#!/usr/bin/env node
/* 探针：线稿重绘台（visionlab）
 *
 * 只测「不靠模型也能测」的部分，口径全部是线稿层（中线 + 线宽），没有填充层指标：
 *   ① App 注册、打开、铺满、无报错；
 *   ② 演示图 → 中线提取（Zhang-Suen 细化 + RDP）→ 线带覆盖层；
 *   ③ 回读指标算得出来且合理：Chamfer / 召回 / 精度 / 中位线宽；
 *   ④ 工具循环接得通：桩替换 llmStreamRequest，走完 查看 → 描绘 → 校验 → 收口；
 *   ⑤ 监督面板把每次工具调用都落成卡片，运行记录里有一条指标。
 *
 * 不访问真实模型。用法：node tools/test-headless.js visionlab
 */
'use strict';

const { chromium } = require('playwright-core');
const { createRun } = require('./probe-run');
const { pathToFileURL } = require('url');
const path = require('path');

const run = createRun('probe-visionlab');
const errors = [];

function check(ok, name, extra) {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) errors.push(name + (extra ? (' · ' + extra) : ''));
}

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push('pageerror: ' + String(e && e.message)));

  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  check(await page.evaluate(() => !!document.querySelector('.desk-app[data-app="visionlab"]')),
    '桌面上的「线稿重绘台」图标存在', '');

  await page.evaluate(() => window.openDeskApp('visionlab'));
  await page.waitForTimeout(1200);

  let dbg = await page.evaluate(() => window.vlLab && window.vlLab.__debug());
  check(!!dbg && dbg.ready, 'App 就绪', '');
  check(!!dbg && dbg.visible, '窗口已翻到前台', '');
  check(await page.evaluate(() => !!document.querySelector('#visionlabWin canvas.vl-canvas')),
    '画布节点存在', '');
  check(await page.evaluate(() => !!document.querySelector('[data-ref="src"]') &&
    !document.querySelector('[data-ref="parts"]') && !document.querySelector('[data-ref="barrier"]')),
    '参数栏是取线口径（无填充层控件）', '');

  /* 1. 演示图（粗体文字）→ 自动判成笔画网络，走中线（轮廓会把笔画糊成一圈） */
  await page.evaluate(() => window.vlLab.__test.loadDemo());
  await page.waitForTimeout(300);
  const autoPick = await page.evaluate(() => {
    const n = window.vlLab.__test.setRegion({ x: 0, y: 0, w: 480, h: 360 });
    return { n: n, auto: window.vlLab.__debug().auto, mode: window.vlLab.__debug().mode, parts: window.vlLab.__test.parts() };
  });
  check(!!autoPick.auto && autoPick.auto.pick === 'contour' && autoPick.mode === 'contour',
    '自动形态：粗体实心字判成区域 → 闭合轮廓', JSON.stringify(autoPick.auto));
  check(autoPick.parts.every(p => p.closed === true), '自动形态给出闭合轮廓（可填色）',
    autoPick.parts.filter(p => p.closed).length + '/' + autoPick.parts.length + ' 闭合');

  /* 1b. 显式选中线：实心字的骨架是「圆头面条」，只能作为线稿观测，不是默认 */
  const nMid = await page.evaluate(() => {
    window.vlLab.__test.setOpt({ shape: 'center' });
    return window.vlLab.__test.extract();
  });
  const midParts = await page.evaluate(() => window.vlLab.__test.parts());
  check(nMid >= 8 && midParts.every(p => p.closed !== true),
    '中线模式把笔画拆开（不再是一圈外沿）', nMid + ' 段 · ' + midParts.filter(p => p.closed).length + ' 条闭合');

  /* 1c. 回到轮廓：后续断言都在闭合环 + 填色口径上 */
  const n = await page.evaluate(() => {
    window.vlLab.__test.setOpt({ shape: 'contour' });
    return window.vlLab.__test.extract();
  });
  check(n >= 3, '轮廓模式提取出闭合轮廓', n + ' 环');

  const parts = await page.evaluate(() => window.vlLab.__test.parts());
  check(parts.length >= 3 && parts.every(p => p.key && p.color && p.anchors >= 3 && p.w > 0),
    '轮廓表带稳定 key / 颜色 / 锚点数 / 线宽', parts.length + ' 环');
  check(parts.every(p => p.closed === true), '轮廓模式全部是闭合环（不是短线段）',
    parts.filter(p => p.closed).length + '/' + parts.length);
  check(parts.some(p => p.name && p.name.length > 0), '轮廓有初始名称', parts[0] && parts[0].name);
  check(parts.every(p => p.len >= 8), '最短环过滤生效', '最短 ' + Math.round(Math.min.apply(null, parts.map(p => p.len))));

  /* 1b. 语义前提：必须把框选区域的位图发给模型，只给数字认不出「企鹅」 */
  const shot = await page.evaluate(() => {
    const u = String(window.vlLab.__test.viewImage(768) || '');
    return { head: u.slice(0, 23), len: u.length };
  });
  check(shot.head.indexOf('data:image/jpeg') === 0 && shot.len > 2000,
    '框选区域能压成给模型看的位图', shot.len + ' 字节 · ' + shot.head);

  /* 2. 提取只给参考线，不落笔；实线必须来自工具调用 */
  check(await page.evaluate(() => window.vlLab.__test.ops().length) === 0,
    '提取后不会自动落笔（实线只能来自工具调用）', '');
  const m0 = await page.evaluate(() => window.vlLab.__test.check());
  check(!!m0 && m0.recall === 0, '未描绘时回读召回为 0（不被预览顶替）', m0 && m0.recall);

  /* 3. 覆盖层 + 回读（轮廓模式按掩膜边界算） */
  const drawn = await page.evaluate(() => window.vlLab.__test.autoDraw());
  check(drawn.drawn >= 3, '按 key 全量描绘成功', drawn.applied + ' 环');

  const m = await page.evaluate(() => window.vlLab.__test.check());
  check(!!m && m.chamfer != null, '回读指标已计算（Chamfer）', m && ('Chamfer ' + m.chamfer + ' / ' + m.mode));
  check(!!m && m.filled === true, '闭合轮廓按填色口径回读', m && ('filled ' + m.filled));
  check(!!m && m.iou === undefined, '回读指标不返回 IoU（面积口径仍走 Chamfer / 覆盖率）', '');
  check(!!m && m.chamfer <= 1.5, '填色轮廓复刻的 Chamfer ≤ 1.5px', m && m.chamfer);
  check(!!m && m.recall >= 0.85, '区域覆盖率召回 ≥ 0.85', m && m.recall);
  check(!!m && m.precision >= 0.85, '区域覆盖率精度 ≥ 0.85', m && m.precision);
  check(!!m && m.shape === 'contour', '指标标注了轮廓形态', m && m.mode);
  check(await page.evaluate(() => !document.querySelector('[data-ref="metrics"]').hidden),
    '指标卡已显示在监督页', '');

  /* 3b. 线稿只是分布输入：模型给控制点 → 几何被替换成模型曲线（不是按 key 复制） */
  const rd = await page.evaluate(() => {
    const before = window.vlLab.__test.path();
    const res = window.vlLab.__test.redraw({
      ops: [{ key: before.key, points: before.samples, closed: before.closed, name: '语义：测试环' }]
    });
    return { before, res, after: window.vlLab.__test.path(before.key), m: window.vlLab.__test.check() };
  });
  check(!!rd.before && Array.isArray(rd.before.samples) && rd.before.samples.length >= 12 && rd.before.samples.length <= 128,
    '参考线带 0–1000 归一化采样点（12–128 自适应）', rd.before && rd.before.samples.length + ' 点');
  check(rd.res.redrawn === 1, 'vl_redraw_parts 按控制点重绘 1 条', JSON.stringify(rd.res));
  check(rd.after.source === 'model' && rd.after.redrawn === true,
    '重绘后几何来源标记为模型', rd.after.source);
  check(rd.after.anchors === rd.before.samples.length, '锚点被替换成模型给的控制点', 'anchors ' + rd.after.anchors);
  check(rd.after.name === '语义：测试环', '重绘同时写入语义名', rd.after.name);
  check(!!rd.m && rd.m.chamfer <= 2.5, '控制点重绘后 Chamfer ≤ 2.5px', rd.m && rd.m.chamfer);

  /* 3c. 点对但顺序错（按角度重排）时，程序按参考线弧长复原，而不是让模型画弦 */
  const ro = await page.evaluate(() => {
    const b = window.vlLab.__test.path();
    const res = window.vlLab.__test.redraw({
      ops: [{ key: b.key, points: b.samples.slice().reverse(), closed: b.closed }]
    });
    return { res, m: window.vlLab.__test.check() };
  });
  check(ro.res.reordered === 1, '乱序控制点被按弧长重排', JSON.stringify(ro.res));
  check(!!ro.m && ro.m.chamfer <= 2.5, '重排后仍贴合参考轮廓', ro.m && ro.m.chamfer);

  /* 3d. 全量按采样点重绘：这是「程序 + 采样」能达到的上限，模型只能更差。
   * 残差来自「少量控制点 + 均匀 Catmull-Rom」在尖角处的过冲（§4.4 实测 1.04px），
   * 直接复制几何时为 0.001，所以这里比 3b 的单环阈值宽。 */
  const fit = await page.evaluate(() => {
    window.vlLab.__test.extract();
    const parts = window.vlLab.__test.parts();
    const ops = parts.map(p => {
      const q = window.vlLab.__test.path(p.key);
      return { key: p.key, points: q.samples, closed: q.closed, width: p.w };
    });
    const res = window.vlLab.__test.redraw({ ops });
    return { want: parts.length, res, m: window.vlLab.__test.check() };
  });
  check(fit.res.redrawn === fit.want,
    '一次调用重绘全部参考线', fit.res.redrawn + '/' + fit.want);
  check(!!fit.m && fit.m.chamfer <= 1.5, '全量采样重绘 Chamfer ≤ 1.5px（流水线上限）', fit.m && fit.m.chamfer);

  /* 3e. B / C 组：端点 + 手柄。切段由 breaks 给，缺手柄时程序最小二乘（C 组）。
   * 这里不重新提取，保留 3d 已画好的其余环，否则 Chamfer 会把「没画的环」算成误差。 */
  const bez = await page.evaluate(() => {
    const parts = window.vlLab.__test.parts();
    const longest = parts.slice().sort((a, b) => b.len - a.len)[0];
    const p = window.vlLab.__test.path(longest.key);
    const pts = p.breaks.points;
    const segs = [];
    for (let i = 1; i < pts.length; i++) segs.push({ end: pts[i] });
    const res = window.vlLab.__test.redraw({
      ops: [{ key: p.key, form: 'bezier', start: pts[0], segs, closed: p.closed }]
    });
    return { bk: p.breaks, res, after: window.vlLab.__test.path(p.key), m: window.vlLab.__test.check() };
  });
  check(!!bez.bk && bez.bk.segs >= 2 && bez.bk.segs <= 16,
    '长环给出 2–16 段的贝塞尔切段建议', bez.bk && bez.bk.segs + ' 段');
  check(bez.res.bezier === 1 && bez.res.segs >= bez.bk.segs,
    '端点 + 手柄走贝塞尔落笔', JSON.stringify({ bezier: bez.res.bezier, segs: bez.res.segs }));
  check(bez.after.form === 'bezier' && bez.after.source === 'model',
    '贝塞尔几何来源标记为模型', bez.after.form);
  check(bez.res.fitted >= 1, '缺手柄时由程序最小二乘拟合', 'fitted ' + bez.res.fitted);
  check(!!bez.m && bez.m.chamfer <= 3, '程序拟合手柄的 Chamfer ≤ 3px', bez.m && bez.m.chamfer);

  /* 3f. 超长手柄必须被夹紧，否则三次贝塞尔会在段内自交出环 */
  const clampT = await page.evaluate(() => {
    const parts = window.vlLab.__test.parts();
    const longest = parts.slice().sort((a, b) => b.len - a.len)[0];
    const p = window.vlLab.__test.path(longest.key);
    const pts = p.breaks.points;
    const segs = [];
    for (let i = 1; i < pts.length; i++) {
      segs.push({
        c1: [pts[i - 1][0] + 900, pts[i - 1][1] + 900],
        c2: [pts[i][0] - 900, pts[i][1] - 900],
        end: pts[i]
      });
    }
    const res = window.vlLab.__test.redraw({ ops: [{ key: p.key, form: 'bezier', start: pts[0], segs }] });
    return { res };
  });
  check(clampT.res.clamped >= 1, '超长手柄被夹紧到 0.85×弦长', 'clamped ' + clampT.res.clamped);

  /* 3h. 色块模式：多色图不能按暗掩膜取线。合成「深灰底 + 白圆 + 红块 + 黑块」，
   * 断言背景被排除、每块带 region 标记与原色、按区域覆盖率回读。 */
  const color = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = '#5a5a5a'; g.fillRect(0, 0, 200, 160);
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(100, 80, 56, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e02424'; g.fillRect(70, 70, 60, 24);
    g.fillStyle = '#111111'; g.fillRect(84, 40, 32, 22);
    await window.vlLab.__test.loadDataURL(c.toDataURL('image/png'));
    window.vlLab.__test.setOpt({ src: 'color', shape: 'auto' });
    const n = window.vlLab.__test.setRegion({ x: 0, y: 0, w: 200, h: 160 });
    const parts = window.vlLab.__test.parts();
    window.vlLab.__test.autoDraw();
    const m = window.vlLab.__test.check();
    return { n, parts, m };
  });
  const rgbOf = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  check(color.n >= 3 && color.n <= 20, '色块模式分出前景块', color.n + ' 块');
  check(color.parts.every(p => p.region === true && p.closed === true), '每块都是闭合区域（可整块填充）', '');
  check(!color.parts.some(p => p.bbox[0] <= 2 && p.bbox[1] <= 2 && p.bbox[2] >= 198 && p.bbox[3] >= 158),
    '背景块没有进入参考线', color.parts.length + ' 块');
  check(color.parts.some(p => { const c2 = rgbOf(p.color); return c2[0] > 150 && c2[1] < 110 && c2[2] < 110; }),
    '红色块保留原色（不被压成墨色）', color.parts.map(p => p.color).join(' '));
  check(!!color.m && color.m.mode === 'color' && color.m.filled === true,
    '色块模式按区域覆盖率回读', color.m && color.m.mode);
  check(!!color.m && color.m.recall >= 0.9 && color.m.precision >= 0.9,
    '色块重绘覆盖率 ≥ 0.9', color.m && (color.m.recall + ' / ' + color.m.precision));

  /* 3h2. 细节 vs 噪点：被包住的深色小块（瞳孔）必须留下，抗锯齿过渡色必须并进邻块。
   * 402×390 的企鹅图标里瞳孔只有 30 多像素，旧的 minArea 一刀切会把它整个过滤掉；
   * 反过来全保留，放大图的每个 6×6 抗锯齿块都会变成一个「部位」，满屏碎块。 */
  const pupil = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 240;
    const g = c.getContext('2d');
    g.fillStyle = '#5a5a5a'; g.fillRect(0, 0, 300, 240);
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(150, 120, 88, 0, Math.PI * 2); g.fill();
    /* 6×6 的深色瞳孔：面积 36，低于块下限（300×240 时 72） */
    g.fillStyle = '#0a0a0a'; g.fillRect(147, 117, 6, 6);
    /* 黑方块 + 压在它左边界上的中间灰条：亮度夹在黑白之间，属于过渡色 */
    g.fillStyle = '#000000'; g.fillRect(120, 60, 60, 40);
    g.fillStyle = '#808080'; g.fillRect(113, 65, 10, 6);
    await window.vlLab.__test.loadDataURL(c.toDataURL('image/png'));
    window.vlLab.__test.setOpt({ src: 'color', shape: 'auto' });
    const n = window.vlLab.__test.setRegion({ x: 0, y: 0, w: 300, h: 240 });
    window.vlLab.__test.autoDraw();
    return { n, parts: window.vlLab.__test.parts() };
  });
  const lumOf = h => (parseInt(h.slice(1, 3), 16) * 299 + parseInt(h.slice(3, 5), 16) * 587 +
    parseInt(h.slice(5, 7), 16) * 114) / 1000;
  const nearPt = (p, x, y, r) => Math.abs((p.bbox[0] + p.bbox[2]) / 2 - x) <= r &&
    Math.abs((p.bbox[1] + p.bbox[3]) / 2 - y) <= r;
  check(pupil.parts.some(p => lumOf(p.color) < 60 && nearPt(p, 150, 120, 8)),
    '被包住的深色小块（瞳孔）没有被面积下限吃掉',
    pupil.parts.map(p => p.color + '@' + JSON.stringify(p.bbox)).join(' '));
  check(!pupil.parts.some(p => lumOf(p.color) > 100 && lumOf(p.color) < 160),
    '抗锯齿过渡色被并进邻块，不单独成块', pupil.parts.map(p => p.color).join(' '));
  check(pupil.n <= 8, '碎块归并没有把块数炸开', pupil.n + ' 块');

  /* 3h3. 矢量口径：色块边界是「少量控制点 + 曲线」，控制点能在画布上拖动改形状。 */
  const vec = await page.evaluate(() => {
    const ps = window.vlLab.__test.parts().map(p => window.vlLab.__test.path(p.key).points);
    return { n: ps.length, max: Math.max.apply(null, ps), min: Math.min.apply(null, ps) };
  });
  check(vec.max <= 40 && vec.min >= 4,
    '色块边界是少量控制点，不是逐像素折线', vec.n + ' 块，控制点 ' + vec.min + '~' + vec.max);

  await page.click('[data-act="ckpt"]');
  const ck0 = await page.evaluate(() => {
    const d = window.vlLab.__debug();
    const p = window.vlLab.__test.path('');
    const raw = window.vlLab.__test.raw(p.key);
    return { key: p.key, a: raw.path[0], view: d.view, ckpt: d.ckpt };
  });
  const cbox = await page.locator('.vl-canvas').boundingBox();
  const csx = cbox.x + ck0.a[0] * ck0.view.s + ck0.view.ox;
  const csy = cbox.y + ck0.a[1] * ck0.view.s + ck0.view.oy;
  await page.mouse.move(csx, csy);
  await page.mouse.down();
  await page.mouse.move(csx + 18, csy + 12, { steps: 5 });
  await page.mouse.up();
  const ck1 = await page.evaluate(k => ({
    pt: window.vlLab.__test.raw(k).path[0],
    metrics: window.vlLab.__debug().metrics
  }), ck0.key);
  check(ck0.ckpt && Math.hypot(ck1.pt[0] - ck0.a[0], ck1.pt[1] - ck0.a[1]) > 3,
    '控制点模式能拖动锚点改曲线', JSON.stringify([ck0.a, ck1.pt]));
  check(ck1.metrics === null, '改动几何后旧指标被清掉');
  await page.click('[data-act="ckpt"]');

  /* 3g. 分组口径必须真的换掉：占位符不能漏进提示词，工具描述也要跟着分组走。
   * 真实运行里模型 5 次全用 points、一次 bezier 都没有，就是「末尾分组说明压不过开头硬规则」。 */
  const forms = await page.evaluate(() => {
    const out = {};
    ['auto', 'poly', 'bezier', 'fit'].forEach(f => {
      window.vlLab.__test.setForm(f);
      const s = window.vlLab.__test.sys();
      const t = window.vlLab.__test.tools(f).filter(x => x.function.name === 'vl_redraw_parts')[0];
      out[f] = { brace: s.indexOf('{{'), hasSegs: s.indexOf('segs') >= 0, desc: t.function.description };
    });
    window.vlLab.__test.setForm('auto');
    return out;
  });
  check(['auto', 'poly', 'bezier', 'fit'].every(f => forms[f].brace === -1),
    '四组提示词都没有残留占位符', forms.bezier.brace === -1 ? '' : 'brace ' + forms.bezier.brace);
  check(forms.bezier.hasSegs && forms.bezier.desc.indexOf('segs') >= 0 &&
    forms.bezier.desc !== forms.poly.desc,
    '强行贝塞尔时提示词与工具描述同步切换', forms.bezier.desc.slice(0, 24));

  /* 3h. 复盘只在真实运行里发：桩模型下必须静默，避免测试联网或卡在第二次请求 */
  check(await page.evaluate(() => window.vlLab.__test.lastReview()) === '',
    '桩运行不发复盘请求', '');

  /* 3i. 逐条归因：模型说过「只有全局 Chamfer，看不出哪段拖后腿」
   * 3j. 最优轮回滚：模型曾把 5.108 一路改到 7.306 才收口 */
  const attr = await page.evaluate(() => {
    const m = window.vlLab.__test.check();
    return { m, best: window.vlLab.__test.best() };
  });
  check(Array.isArray(attr.m.worst), '校验返回逐条归因（worst）', (attr.m.worst || []).length + ' 条超标');
  check(Array.isArray(attr.m.undrawn) && attr.m.undrawn.length === 0,
    '全部画完时 undrawn 为空', (attr.m.undrawn || []).length + ' 条');
  check(!!attr.best && attr.best.chamfer <= attr.m.chamfer + 1e-6,
    '最好一轮的 Chamfer 不劣于当前', JSON.stringify(attr.best) + ' vs ' + attr.m.chamfer);

  const rb = await page.evaluate(() => {
    const p = window.vlLab.__test.parts().slice().sort((a, b) => b.len - a.len)[0];
    const q = window.vlLab.__test.path(p.key);
    /* 把最长环缩到区域中心的一个小三角：这是一个「肯定错」的构造，用来验证回滚 */
    const bad = [[480, 480], [520, 480], [500, 520]];
    const res = window.vlLab.__test.redraw({ ops: [{ key: p.key, points: bad, closed: false }] });
    const mBad = window.vlLab.__test.check();
    const back = window.vlLab.__test.restoreBest();
    const mBack = window.vlLab.__test.check();
    return { res, mBad, back, mBack };
  });
  check(rb.res.redrawn === 1, '构造「改坏」的重绘确实生效', JSON.stringify(rb.res));
  check(rb.mBad.chamfer > rb.mBack.chamfer, '故意改坏后 Chamfer 变差（构造成功）',
    rb.mBad.chamfer + ' → ' + rb.mBack.chamfer);
  check(rb.back.restored === true, 'vl_restore_best 回滚成功', JSON.stringify(rb.back));
  check(rb.mBack.bestChamfer != null && Math.abs(rb.mBack.chamfer - rb.mBack.bestChamfer) < 0.01,
    '回滚后停在最好一轮的 Chamfer', rb.mBack.chamfer + ' vs best ' + rb.mBack.bestChamfer);

  /* 4. 中线模式仍然可用（细线 / 手绘线稿） */
  const center = await page.evaluate(() => {
    window.vlLab.__test.setOpt({ shape: 'center', src: 'auto', threshold: 20 });
    const c = window.vlLab.__test.extract();
    window.vlLab.__test.autoDraw();
    return { n: c, parts: window.vlLab.__test.parts(), m: window.vlLab.__test.check() };
  });
  check(center.n >= 1, '中线模式也能提取', center.n + ' 段');
  check(center.parts.every(p => p.w > 0 && p.closed === false), '中线模式带线宽且不闭合',
    center.parts.length + ' 段');
  check(!!center.m && center.m.shape === 'center', '中线模式的指标口径独立', center.m && center.m.shape);

  /* 5. 取线三模式都能跑（中线口径） */
  for (const src of ['edge', 'dark', 'auto']) {
    const count = await page.evaluate(s => {
      window.vlLab.__test.setOpt({ shape: 'center', src: s, threshold: 20 });
      return window.vlLab.__test.extract();
    }, src);
    check(count >= 1, '取线模式 ' + src + ' 有结果', count + ' 条');
  }

  /* 6. 回到轮廓模式，跑工具循环 */
  await page.evaluate(() => {
    window.vlLab.__test.setOpt({ shape: 'contour', src: 'auto', threshold: 20 });
    window.vlLab.__test.extract();
  });

  /* 7. 工具循环（桩）：先按控制点重绘，再补画，再校验 */
  await page.evaluate(() => {
    const s = window.vlLab.__test.path();
    window.vlLab.__test.stubLLM([
      { tool: 'vl_view_region', args: {} },
      { tool: 'vl_redraw_parts', args: { ops: [{ key: s.key, points: s.samples, closed: s.closed, name: '桩重绘', width: s.width }] } },
      { tool: 'vl_draw_parts', args: { ops: [{ key: '*' }] } },
      { tool: 'vl_render_check', args: {} },
      { tool: 'vl_finish', args: { summary: '桩：控制点重绘 + 全量复刻' } }
    ]);
    window.vlLab.__test.run();
  });

  await page.waitForFunction(() => window.vlLab.__debug().busy === false, null, { timeout: 20000 });
  await page.waitForTimeout(300);

  const firstParts = await page.evaluate(() => window.vlLab.__test.firstUserParts());
  const lastParts = await page.evaluate(() => window.vlLab.__test.lastUserParts());
  check(firstParts[0] === 'text' && firstParts.indexOf('image_url') >= 0,
    '第一条任务同时带文字与位图', firstParts.join(' + '));
  check(lastParts.indexOf('image_url') < 0,
    '第 3 轮起不再重发位图（输入按轮次线性涨的直接原因）', lastParts.join(' + '));

  dbg = await page.evaluate(() => window.vlLab.__debug());
  check(dbg.calls >= 5, '工具循环执行了 ≥5 次调用', dbg.calls + ' 次');
  check(dbg.runs >= 1, '运行记录已落盘', dbg.runs + ' 条');
  check(!!dbg.metrics && dbg.metrics.chamfer <= 1.5, '循环结束后的指标存在',
    dbg.metrics && ('Chamfer ' + dbg.metrics.chamfer));

  const cards = await page.evaluate(() => document.querySelectorAll('[data-ref="sup"] .vl-tool').length);
  check(cards >= 4, '监督面板逐次落了工具卡片', cards + ' 张');

  const toolNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-ref="sup"] .vl-tool-name')).map(e => e.textContent));
  check(toolNames.indexOf('vl_draw_parts') >= 0 && toolNames.indexOf('vl_render_check') >= 0,
    '卡片里能看到描绘与校验两类调用', toolNames.join(' / '));

  /* 8. 没画任何线时不许反复换取线口径（实测模型 8 轮全用在 24/5/18/5 段对比上，0 条描绘） */
  const guard = await page.evaluate(async () => {
    window.vlLab.__test.reset();
    await window.vlLab.__test.loadDemo();
    window.vlLab.__test.setOpt({ shape: 'auto', src: 'auto', threshold: 20 });
    const n = window.vlLab.__test.setRegion({ x: 0, y: 0, w: 480, h: 360 });
    const blocked = await window.vlLab.__test.tool('vl_trace', { shape: 'contour', src: 'dark', threshold: 200 });
    const forced = await window.vlLab.__test.tool('vl_trace', { shape: 'contour', src: 'dark', threshold: 200, force: true });
    return { n, blocked, forced };
  });
  check(guard.blocked.blocked === true && guard.blocked.count === guard.n,
    '未描绘时改口径被拦截（保住已提取的参考线）',
    JSON.stringify({ blocked: guard.blocked.blocked, count: guard.blocked.count }));
  check(guard.forced.blocked !== true && guard.forced.count >= 1,
    '显式 force 时仍允许重提取', guard.forced.count + ' 段 · delta ' + guard.forced.delta);

  /* 8. 语义分组：并组 / 组色边界 / 同级碎块各自保留 / drop。
   * 颜色是测量值：模型给的组色离实测太远会被拒收，避免把白眼涂成瞳孔色。 */
  const sem = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 160;
    const g = c.getContext('2d');
    g.fillStyle = '#5a5a5a'; g.fillRect(0, 0, 200, 160);
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(100, 80, 56, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e02424'; g.fillRect(70, 70, 60, 24);
    g.fillStyle = '#111111'; g.fillRect(84, 40, 32, 22);
    await window.vlLab.__test.loadDataURL(c.toDataURL('image/png'));
    window.vlLab.__test.setOpt({ src: 'color', shape: 'auto' });
    window.vlLab.__test.setRegion({ x: 0, y: 0, w: 200, h: 160 });
    window.vlLab.__test.autoDraw();
    const parts = window.vlLab.__test.parts().filter(p => p.region);
    const a = parts[0], b = parts[1], c2 = parts[2];
    const pickA = [
      Math.round(a.bbox[0] + (a.bbox[2] - a.bbox[0]) * 0.15),
      Math.round((a.bbox[1] + a.bbox[3]) / 2)
    ];
    const mid = p => [Math.round((p.bbox[0] + p.bbox[2]) / 2), Math.round((p.bbox[1] + p.bbox[3]) / 2)];

    const g1 = window.vlLab.__test.group({ groups: [{ name: '测试·浅色并组', keys: [a.key, b.key], color: '#e8e8e8' }] });
    const s1 = window.vlLab.__test.semantics();
    const px1 = window.vlLab.__test.sampleDraw(pickA[0], pickA[1]);

    const gBad = window.vlLab.__test.group({ groups: [{ name: '测试·错误改色', keys: [a.key], color: '#111111' }] });
    const sBad = window.vlLab.__test.semantics();
    const pxBad = window.vlLab.__test.sampleDraw(pickA[0], pickA[1]);

    const gSib = window.vlLab.__test.group({ groups: [{ name: '测试·并列', keys: [b.key, c2.key] }] });
    const sSib = window.vlLab.__test.semantics();
    const mb = mid(b), mc = mid(c2);
    const pxB = window.vlLab.__test.sampleDraw(mb[0], mb[1]);
    const pxC = window.vlLab.__test.sampleDraw(mc[0], mc[1]);

    const g2 = window.vlLab.__test.group({
      groups: [{
        name: '测试·全部', color: '#00aa00',
        keys: parts.map(p => p.key).filter(k => k !== b.key), drop: [b.key]
      }]
    });
    const s2 = window.vlLab.__test.semantics();

    /* 顶层 drop：模型真实运行里会把 drop 写在主参数上，必须被识别 */
    const keepTop = parts.map(p => p.key).filter(k => k !== b.key && k !== c2.key);
    const gTop = window.vlLab.__test.group({ drop: [c2.key], groups: [{ name: '测试·顶层drop', keys: keepTop }] });
    const sTop = window.vlLab.__test.semantics();
    /* 分图层：每个语义组在左侧列表里是一行，重绘几何是三次贝塞尔段 */
    const layerRows = document.querySelectorAll('[data-ref="layers"] [data-layer]').length;
    const layerText = (document.querySelector('[data-ref="layers"]') || {}).textContent || '';
    const bezA = window.vlLab.__test.bez(a.key);
    return { n: parts.length, g1, s1, px1, gBad, sBad, pxBad, gSib, sSib, pxB, pxC, g2, s2, gTop, sTop, layerRows, layerText, bezA };
  });
  const rgb = hex => [1, 3, 5].map(i => parseInt(String(hex).slice(i, i + 2), 16) || 0);
  check(sem.n >= 3 && sem.g1.groups === 1 && sem.g1.grouped === 2,
    '色块可以按语义并成一组', '块 ' + sem.n + ' · 组 ' + sem.g1.groups + ' · 并入 ' + sem.g1.grouped);
  check(sem.s1.duplicates.length === 0 && sem.s1.unnamed === 0,
    '分组自检：无重复归组、组名完整', JSON.stringify(sem.s1.groups));
  check(String(sem.px1).toLowerCase() === '#e8e8e8', '贴近实测的组色可以统一覆盖（栅格取样 = 组色）', sem.px1);
  check(sem.s1.clash.length >= 1, '组内颜色跨度被检出（并错部位）',
    JSON.stringify(sem.s1.clash.map(x => x.name + ' ' + x.spread)));
  check(sem.gBad.colorFixed.length === 1 && sem.sBad.colorFixed.length === 1,
    '与实测色差过大的组色被拒收', JSON.stringify(sem.gBad.colorFixed));
  const bad = rgb(sem.pxBad);
  check(bad.every(v => v > 180), '被拒收的组色不改写实测原色（白眼仍是白的）', sem.pxBad);
  const cb = rgb(sem.pxB), cc = rgb(sem.pxC);
  check(cb[0] > 150 && cb[0] - cb[1] > 60 && cc.every(v => v < 70),
    '同级碎块并组时各自保留（不会把另一块挖成孔）', 'b=' + sem.pxB + ' c=' + sem.pxC);
  check(sem.g2.dropped === 1 && sem.s2.dropped === 1, '无意义碎块可以 drop', 'dropped ' + sem.g2.dropped);
  check(sem.s2.drawn === sem.n - 1, 'drop 后该块既不上屏也不计入已描绘', sem.s2.drawn + ' / ' + sem.n);
  check(sem.gTop.dropped === 1 && sem.sTop.ungrouped.length === 0,
    '顶层 drop 也能被识别（模型真实写法）', 'dropped ' + sem.gTop.dropped + ' · 未分组 ' + sem.sTop.ungrouped.length);
  check(sem.layerRows === sem.gTop.groups && /测试·顶层drop/.test(sem.layerText),
    '分组后每个部位是一个图层（左侧列表可单独隐藏）', sem.layerRows + ' 行 · ' + String(sem.layerText).slice(0, 24));
  check(!!sem.bezA && sem.bezA.segs > 0,
    '区域边界输出的是三次贝塞尔段（不是折线）', sem.bezA ? sem.bezA.segs + ' 段 · tol ' + Math.round(sem.bezA.tol * 100) / 100 : '无');
  await page.evaluate(() => window.vlLab.__test.reset());

  /* 9. 实验页 */
  const variants = await page.evaluate(() => document.querySelectorAll('[data-variant]').length);
  check(variants >= 6, '实验页枚举了 ≥6 个改良方案', variants + ' 个');

  await run.shot(page, 'visionlab.png');
  await browser.close();

  const ok = run.finish(errors);
  console.log(ok ? '\n全部通过（' + (errors.length) + ' 个失败）' : '\n失败 ' + errors.length + ' 项');
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error(e);
  run.finish([String((e && e.stack) || e)]);
  process.exit(1);
});
