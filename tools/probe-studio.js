/* 探针：剪辑台（时间线视频剪辑器）是否真的能剪、能播、能导出。
 * 用法：node tools/probe-studio.js
 *
 * 光看代码看不出「轨道放不放得下」「拖拽会不会算错时间」「导出有没有数据」。
 * 这里从桌面图标点进去，走一遍真实操作：
 *   ① 窗口 / 四轨 / 素材面板结构；
 *   ② 双击素材追加片段、预览出画面；
 *   ③ 时间线上拖片段、分割、撤销 / 重做；
 *   ④ 文字预设与滤镜写回片段；
 *   ⑤ 检查器联动、?nostore=1 不写真实存储；
 *   ⑥ 真实导出产出一个 blob: 链接；
 *   ⑦ 关窗再开，布局不重建、时间线状态保留，全程无 pageerror。
 *
 * 素材一律用页面内 canvas 生成的 dataURL，不读用户文件、不联网。
 */
'use strict';

const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const { createRun } = require('./probe-run');

const run = createRun('probe-studio');
const failList = [];
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) failList.push(name + (extra ? ' · ' + extra : ''));
};

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));

  try {
    await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
    await page.waitForTimeout(1200);

    /* 1. 桌面入口与窗口结构 */
    check(await page.evaluate(() => !!document.querySelector('.desk-app[data-app="studio"]')),
      '桌面上的「剪辑台」图标存在');

    await page.evaluate(() => window.openDeskApp('studio'));
    await page.waitForTimeout(1600);

    const boot = await page.evaluate(() => {
      const w = document.getElementById('studioWin');
      return {
        api: !!(window.studioApp && window.studioApp.__test),
        visible: !!w && !w.classList.contains('hidden'),
        cls: !!w && w.classList.contains('studio'),
        heads: document.querySelectorAll('#stHeads .st-th').length,
        videos: document.querySelectorAll('#stFrame video').length,
        tabs: document.querySelectorAll('#stTabs .st-tab').length
      };
    });
    check(boot.api, '探针 API 就绪');
    check(boot.visible && boot.cls, '窗口已打开且带 studio 类');
    check(boot.heads === 4, '四条轨道齐全', boot.heads + ' 条');
    check(boot.tabs === 4, '素材面板四个 tab', boot.tabs + ' 个');
    check(boot.videos === 2, '预览池按视频轨创建', boot.videos + ' 个 <video>');

    /* 2. 新建项目：确认弹层 + 清空 */
    await page.click('#stNew');
    await page.waitForTimeout(150);
    const confirmShown = await page.evaluate(() =>
      !document.getElementById('stConfirmModal').classList.contains('hidden'));
    await page.click('#stConfirmYes');
    await page.waitForTimeout(200);
    const st0 = await page.evaluate(() => window.studioApp.__test.state());
    check(confirmShown, '新建项目有确认弹层');
    check(st0.clips === 0 && st0.media === 0, '新建后时间线为空',
      st0.clips + ' 片段 / ' + st0.media + ' 素材');

    /* 3. 素材：页面内生成一张图，双击卡片追加片段 */
    const mediaId = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 180;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 320, 180);
      g.addColorStop(0, '#1b3a6b');
      g.addColorStop(1, '#0e1a2b');
      x.fillStyle = g; x.fillRect(0, 0, 320, 180);
      x.fillStyle = '#f0b429'; x.fillRect(120, 60, 80, 60);
      x.fillStyle = '#ffffff'; x.font = 'bold 28px sans-serif'; x.fillText('CLIP', 18, 40);
      const item = window.studioApp.__test.addMedia({
        name: '测试图', kind: 'image', url: c.toDataURL('image/png'), dur: 6
      });
      return item.id;
    });
    await page.waitForTimeout(150);
    const cards = await page.locator('#stMediaGrid .st-mcard').count();
    check(cards === 1, '素材池出现一张卡片', cards + ' 张');

    await page.dblclick('#stMediaGrid .st-mcard');
    await page.waitForTimeout(220);
    const added = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const p = t.project();
      const clip = p.clips.find(c => c.track === 'v1');
      return { clips: p.clips.length, els: t.clipEls(), id: clip && clip.id, dur: clip && clip.dur };
    });
    check(added.clips === 1 && added.els === 1, '双击素材自动追加片段',
      added.clips + ' 片段 / ' + added.els + ' 个时间线块');
    check(added.dur === 5, '图片片段默认 5 秒', added.dur + 's');

    /* 4. 预览：播放头落在片段内要出画面 */
    await page.evaluate(() => window.studioApp.__test.seek(1));
    await page.waitForTimeout(220);
    const prev = await page.evaluate(() => window.studioApp.__test.previewEl());
    check(!!(prev && prev.img), '播放头处预览出图片', prev ? JSON.stringify(prev) : 'null');

    /* 5. 时间线拖拽：关掉磁吸，右移 80px（放大 80px/s → 1 秒） */
    await page.click('#stSnap');
    const snapOff = await page.evaluate(() => !document.getElementById('stSnap').classList.contains('on'));
    const box = await page.locator('#stRows .st-clip').first().boundingBox();
    if (!box) {
      check(false, '时间线片段有可拖拽区域');
    } else {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 80, cy, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(220);
      const movedStart = await page.evaluate(id =>
        (window.studioApp.__test.project().clips.find(c => c.id === id) || {}).start, added.id);
      check(snapOff && movedStart > 0.85 && movedStart < 1.15, '拖拽片段沿时间线移动 1 秒',
        'start=' + movedStart + 's');
      await page.click('#stUndo');
      await page.waitForTimeout(180);
      const backStart = await page.evaluate(id =>
        (window.studioApp.__test.project().clips.find(c => c.id === id) || {}).start, added.id);
      check(backStart === 0, '撤销拖拽回到原位置', 'start=' + backStart + 's');
    }

    /* 6. 播放：rAF 推进时间线，再点一次暂停 */
    await page.evaluate(() => window.studioApp.__test.seek(0.4));
    await page.click('#stPlay');
    await page.waitForTimeout(220);
    const pl1 = await page.evaluate(() => window.studioApp.__test.state());
    await page.waitForTimeout(420);
    const pl2 = await page.evaluate(() => window.studioApp.__test.state());
    await page.click('#stPlay');
    await page.waitForTimeout(160);
    const pl3 = await page.evaluate(() => window.studioApp.__test.state());
    check(pl1.playing && pl2.playing && pl2.time > pl1.time + 0.15, '播放推进时间线',
      pl1.time.toFixed(2) + 's → ' + pl2.time.toFixed(2) + 's');
    check(!pl3.playing, '再点一次暂停');

    /* 7. 文字预设 */
    await page.click('#stTabs [data-panel="text"]');
    await page.waitForTimeout(120);
    const tabOn = await page.evaluate(() => {
      const b = document.querySelector('#stTabs [data-panel="text"]');
      const p = document.querySelector('.st-panel[data-panel="text"]');
      return { on: b.classList.contains('on'), visible: !p.classList.contains('hidden') };
    });
    await page.evaluate(() => window.studioApp.__test.seek(0));
    await page.click('#stTextPresets [data-preset="title"]');
    await page.waitForTimeout(220);
    const txt = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const p = t.project();
      const c = p.clips.find(x => x.kind === 'text');
      return { clips: p.clips.length, els: t.textEls(), id: c && c.id, content: c && c.text.content };
    });
    check(tabOn.on && tabOn.visible, '切到文字面板');
    check(txt.clips === 2 && !!txt.id, '文字预设落到时间线', txt.content || '');
    check(txt.els === 1, '预览出现文字层', txt.els + ' 层');

    /* 8. 分割：选中主视频片段，播放头放到 2 秒 */
    await page.evaluate(id => window.studioApp.__test.select(id), added.id);
    await page.evaluate(() => window.studioApp.__test.seek(2));
    await page.click('#stSplit');
    await page.waitForTimeout(250);
    const split = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const p = t.project();
      const vids = p.clips.filter(c => c.track === 'v1').sort((a, b) => a.start - b.start);
      return {
        clips: p.clips.length,
        els: t.clipEls(),
        vids: vids.map(c => ({ id: c.id, start: c.start, dur: c.dur, in: c.in }))
      };
    });
    check(split.vids.length === 2 && split.els === 3, '播放头处分割成两段',
      split.vids.map(c => c.start + '~' + (c.start + c.dur)).join(' | '));
    check(split.vids.length === 2 && Math.abs(split.vids[1].in - 2) < 0.05, '分割后右段入点顺延',
      'in=' + (split.vids[1] ? split.vids[1].in : '-'));

    /* 9. 撤销 / 重做 */
    await page.click('#stUndo');
    await page.waitForTimeout(200);
    const undone = await page.evaluate(() => window.studioApp.__test.state());
    await page.click('#stRedo');
    await page.waitForTimeout(200);
    const redone = await page.evaluate(() => window.studioApp.__test.state());
    check(undone.clips === 2 && redone.clips === 3, '撤销 / 重做片段数正确',
      undone.clips + ' → ' + redone.clips);

    /* 10. 检查器与滤镜 */
    const rightId = split.vids[1] ? split.vids[1].id : added.id;
    await page.evaluate(id => window.studioApp.__test.select(id), rightId);
    await page.waitForTimeout(120);
    const insp = await page.evaluate(() => ({
      title: (document.querySelector('#stInspector .st-insp-sec h4') || {}).textContent || '',
      dur: !!document.querySelector('#stInspector input[data-prop="dur"]'),
      opacity: !!document.querySelector('#stInspector input[data-prop="opacityPct"]')
    }));
    check(insp.dur && insp.opacity && insp.title.indexOf('片段') === 0,
      '检查器显示片段参数', insp.title);

    await page.click('#stTabs [data-panel="fx"]');
    await page.waitForTimeout(100);
    await page.click('#stFxGrid .st-fxcard[data-fx="bw"]');
    await page.waitForTimeout(150);
    const filterNow = await page.evaluate(id => {
      const c = window.studioApp.__test.project().clips.find(x => x.id === id);
      return c ? c.filter : '';
    }, rightId);
    check(filterNow === 'bw', '点滤镜写到选中片段', filterNow);

    /* 11. 项目面板改名联动顶栏 */
    await page.evaluate(() => window.studioApp.__test.select(''));
    await page.waitForTimeout(120);
    const renamed = await page.evaluate(() => {
      const el = document.querySelector('#stInspector input[data-proj="name"]');
      if (!el) return { ok: false, name: '' };
      el.value = '探针项目';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, name: document.getElementById('stProjName').textContent };
    });
    check(renamed.ok && renamed.name === '探针项目', '项目面板改名联动顶栏', renamed.name);

    /* 12. ?nostore=1：不把测试数据写进真实存储 */
    await page.waitForTimeout(800);
    const saveText = await page.evaluate(() => document.getElementById('stSaveState').textContent);
    check(saveText.indexOf('不落盘') >= 0, '测试模式不写真实存储', saveText);

    /* 13. 导出：把时间线压到 1.2 秒，真实录一段 WebM */
    check(await page.evaluate(() => window.studioApp.__test.exportSupported()),
      '环境支持 MediaRecorder 导出');
    await page.evaluate(() => {
      const t = window.studioApp.__test;
      const p = t.project();
      const vids = p.clips.filter(c => c.track === 'v1').sort((a, b) => a.start - b.start);
      const txt = p.clips.find(c => c.kind === 'text');
      if (vids[0]) t.setClip(vids[0].id, { start: 0, dur: 0.6 });
      if (vids[1]) t.setClip(vids[1].id, { start: 0.6, dur: 0.6 });
      if (txt) t.setClip(txt.id, { start: 0, dur: 0.6 });
    });
    const durNow = await page.evaluate(() => window.studioApp.__test.state().duration);
    check(Math.abs(durNow - 1.2) < 0.06, '时间线压缩为 1.2 秒便于导出', durNow + 's');

    await page.click('#stExport');
    await page.waitForTimeout(200);
    const modal = await page.evaluate(() => ({
      open: !document.getElementById('stExportModal').classList.contains('hidden'),
      res: Array.from(document.querySelectorAll('#stExRes option')).map(o => o.value)
    }));
    check(modal.open && modal.res.length === 4, '导出弹层打开且分辨率可选', modal.res.join(','));

    await page.selectOption('#stExRes', '854x480');
    let exportDone = false;
    let exportMsg = '';
    try {
      await page.click('#stExStart');
      await page.waitForFunction(
        () => window.studioApp.__test.exportState().done === true,
        { timeout: 30000 }
      );
      exportDone = true;
    } catch (e) {
      exportMsg = String((e && e.message) || e).split('\n')[0];
      try { await page.evaluate(() => window.studioApp.__test.cancelExport()); } catch (err) {}
    }
    const ex = await page.evaluate(() => window.studioApp.__test.exportState());
    check(exportDone && ex.done && /^blob:/.test(ex.href), '真实导出产出可下载 WebM',
      exportDone ? (ex.text + ' · ' + ex.bar) : (exportMsg || ex.text));

    /* 14. 关窗再开：布局不重建、时间线状态保留 */
    await page.evaluate(() => {
      const b = document.querySelector('#stExportModal .st-modal-x[data-close="stExportModal"]');
      if (b) b.click();
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.querySelector('#studioWin .os-win-close').click());
    await page.waitForTimeout(600);
    const closed = await page.evaluate(() =>
      document.getElementById('studioWin').classList.contains('hidden'));

    await page.evaluate(() => window.openDeskApp('studio'));
    await page.waitForTimeout(1400);
    const reopened = await page.evaluate(() => {
      const t = window.studioApp.__test;
      return {
        visible: !document.getElementById('studioWin').classList.contains('hidden'),
        heads: document.querySelectorAll('#stHeads .st-th').length,
        videos: document.querySelectorAll('#stFrame video').length,
        cards: document.querySelectorAll('#stMediaGrid .st-mcard').length,
        clips: t.state().clips
      };
    });
    check(closed, '关闭按钮能收回窗口');
    check(reopened.visible && reopened.heads === 4 && reopened.videos === 2 && reopened.cards === 1,
      '重开窗口布局不重建', JSON.stringify(reopened));
    check(reopened.clips === 3, '重开后时间线状态保留', reopened.clips + ' 片段');

    /* 15. 数据模型 v2：迁移 / 幂等 / 关键帧采样 */
    const model = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const v1 = {
        v: 1, name: '旧项目', w: 1280, h: 720, fps: 25, media: [],
        clips: [{ id: 'old1', track: 'v1', kind: 'text', start: 0, dur: 2, text: { content: '旧' } }]
      };
      const m1 = t.migrate(v1);
      const m2 = t.migrate(m1);
      const keys = [{ t: 0, v: 0, ease: 'linear' }, { t: 2, v: 10, ease: 'linear' }];
      return {
        ver: m1.v, tracks: m1.tracks.length, markers: m1.markers.length, kf: !!m1.clips[0].kf,
        idem: JSON.stringify(m1) === JSON.stringify(m2),
        mid: t.sample(keys, 1), head: t.sample(keys, -1), tail: t.sample(keys, 5),
        empty: t.sample([], 1)
      };
    });
    check(model.ver === 2 && model.tracks === 4 && model.markers === 0 && model.kf,
      'v1 项目迁移到 v2（补轨道 / 标记 / 关键帧容器）', JSON.stringify(model));
    check(model.idem, '迁移可重复执行（幂等）');
    check(model.mid === 5 && model.head === 0 && model.tail === 10 && model.empty === null,
      '关键帧线性采样与端点钳制', 'mid=' + model.mid + ' head=' + model.head + ' tail=' + model.tail);

    /* 16. 动态轨道：新增 / 预览池 / 删除 */
    const dyn = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const before = t.state().tracks;
      const tk = t.addTrack('video');
      const after = t.state().tracks;
      const heads = document.querySelectorAll('#stHeads .st-th').length;
      const vids = document.querySelectorAll('#stFrame video').length;
      const added = t.tracks().find(x => x.id === tk.id);
      t.removeTrack(tk.id);
      return {
        before, after, heads, vids, name: added && added.name,
        back: t.state().tracks,
        backHeads: document.querySelectorAll('#stHeads .st-th').length
      };
    });
    check(dyn.after === dyn.before + 1 && dyn.heads === dyn.after && dyn.vids === 3,
      '新增视频轨同步到轨道头与预览池', dyn.name + ' / heads=' + dyn.heads + ' / video=' + dyn.vids);
    check(dyn.back === dyn.before && dyn.backHeads === dyn.before, '删除空轨道后完全复原');

    /* 17. 轨道锁定 / 静音 / 隐藏状态 */
    const lock = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const mediaId = (t.project().clips.find(c => c.kind !== 'text') || {}).mediaId;
      const before = t.state().clips;
      t.toggleTrack('v1', 'locked');
      const locked = t.tracks().find(x => x.id === 'v1').locked;
      const headOn = !!document.querySelector('.st-th[data-track="v1"] .st-thb.on');
      const added = t.addClip(mediaId);
      const after = t.state().clips;
      t.toggleTrack('v1', 'locked');
      const unlocked = t.tracks().find(x => x.id === 'v1').locked;
      return { locked, headOn, added: !!added, before, after, unlocked };
    });
    check(lock.locked && lock.headOn, '轨道锁定状态写进轨道头');
    check(!lock.added && lock.after === lock.before && !lock.unlocked,
      '锁定轨道拒绝落片段，解锁后恢复', lock.before + ' → ' + lock.after);

    /* 18. 标记：打点 / 标尺渲染 / 磁吸 / 删除 */
    await page.click('#stSnap');
    const marker = await page.evaluate(() => {
      const t = window.studioApp.__test;
      t.seek(1.3);
      const m = t.addMarker();
      const mt = m ? m.t : 0;
      const count = t.markers().length;
      const els = t.markerEls();
      const snapped = t.snapTime(mt + 0.06);
      const removed = t.removeMarker(mt);
      return { id: !!m, t: mt, count, els, snapped, removed, left: t.markers().length, leftEls: t.markerEls(), time: t.seek(0) };
    });
    check(marker.id && marker.count === 1 && marker.els === 1, 'M 在播放头打标记并画到标尺');
    check(Math.abs(marker.snapped - marker.t) < 0.03, '磁吸会吸附到标记点',
      'snap=' + marker.snapped + ' / marker@' + marker.t);
    check(marker.removed && marker.left === 0 && marker.leftEls === 0, 'Alt+点击标记可删除');

    /* 19. 关键帧写入 / 补间取值 / 清除 */
    const kf = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const c = t.project().clips.find(x => x.track === 'v1');
      t.setClip(c.id, { kf: { opacity: [{ t: 0, v: 0.2, ease: 'linear' }, { t: 1, v: 1, ease: 'linear' }] } });
      const mid = t.propAt(c.id, 'opacity', c.start + 0.5);
      const pts = t.addKeyframe(c.id, 'scale', c.start);
      const stored = (t.project().clips.find(x => x.id === c.id).kf.scale || []).length;
      t.clearKeyframes(c.id);
      const cleared = Object.keys(t.project().clips.find(x => x.id === c.id).kf).length;
      return { mid, added: Array.isArray(pts) && pts.length === 1, stored, cleared };
    });
    check(Math.abs(kf.mid - 0.6) < 0.02, '关键帧补间参与预览取值', 'opacity@0.5=' + kf.mid);
    check(kf.added && kf.stored === 1 && kf.cleared === 0, '打点 / 清除关键帧', JSON.stringify(kf));

    /* 20. 滚动剪辑 / 波纹裁剪 / 滑动：改边界，不改别人的入点 */
    const edit = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const vids = t.project().clips.filter(c => c.track === 'v1').sort((a, b) => a.start - b.start);
      const a = vids[0];
      const b = vids[1];
      t.setClip(a.id, { start: 0, dur: 1, in: 0 });
      t.setClip(b.id, { start: 1, dur: 1, in: 0 });
      t.edit.roll(a.id, 'r', 0.2);
      const roll = t.project().clips.filter(c => c.track === 'v1').sort((x, y) => x.start - y.start)
        .map(c => ({ id: c.id, start: c.start, dur: c.dur, in: c.in }));
      t.edit.trim(a.id, 'r', -0.2, true);
      const ripple = t.project().clips.filter(c => c.track === 'v1').sort((x, y) => x.start - y.start)
        .map(c => ({ id: c.id, start: c.start, dur: c.dur, in: c.in }));
      t.edit.slide(b.id, 0.1);
      const slide = t.project().clips.filter(c => c.track === 'v1').sort((x, y) => x.start - y.start)
        .map(c => ({ id: c.id, start: c.start, dur: c.dur, in: c.in }));
      return { roll, ripple, slide };
    });
    const rollA = edit.roll.find(x => x.id === edit.roll[0].id);
    const rollB = edit.roll[1];
    check(Math.abs(rollA.dur - 1.2) < 0.02 && Math.abs(rollB.start - 1.2) < 0.02 && Math.abs(rollB.in - 0.2) < 0.02,
      'Ctrl+拖边缘＝滚动剪辑（边界与入点一起动）', JSON.stringify(edit.roll));
    check(Math.abs(edit.ripple[0].dur - 1) < 0.02 && Math.abs(edit.ripple[1].start - 1) < 0.02,
      'Alt+拖边缘＝波纹裁剪（后续片段整体前移）', JSON.stringify(edit.ripple));
    const slideA = edit.slide[0];
    const slideB = edit.slide[1];
    check(Math.abs(slideA.dur - 1.1) < 0.02 && Math.abs(slideB.start - 1.1) < 0.02 &&
      Math.abs(slideB.in - 0.2) < 0.02 && Math.abs(slideB.dur - 0.8) < 0.02,
      'Ctrl+拖片段＝滑动（自身入点/时长不变，邻居让位）', JSON.stringify(edit.slide));

    /* 21. 滑移：只改入点 */
    const slip = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const m = t.addMedia({ name: '滑移素材', kind: 'video', url: '', dur: 20 });
      const c = t.addClip(m.id, 'v2', 0);
      t.setClip(c.id, { dur: 4 });
      t.edit.slip(c.id, 1.5);
      const now = t.project().clips.find(x => x.id === c.id);
      const out = { start: now.start, dur: now.dur, in: now.in };
      t.select(c.id);
      t.remove();
      return out;
    });
    check(slip.start === 0 && slip.dur === 4 && Math.abs(slip.in - 1.5) < 0.02,
      'Alt+拖片段＝滑移（只改入点）', JSON.stringify(slip));

    /* 22. 波纹删除 + 多选删除 */
    const multi = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const m = t.addMedia({ name: '波纹素材', kind: 'image', url: '', dur: 4 });
      const c1 = t.addClip(m.id, 'v2', 0);
      t.setClip(c1.id, { dur: 2 });
      const c2 = t.addClip(m.id, 'v2', 2);
      t.setClip(c2.id, { dur: 2 });
      const base = t.state().clips;
      t.select(c1.id);
      t.remove(true);
      const afterRipple = t.state().clips;
      const movedStart = (t.project().clips.find(x => x.id === c2.id) || {}).start;
      const c3 = t.addClip(m.id, 'v2', 3);
      t.selectMany([c2.id, c3.id]);
      const selN = t.state().multi.length;
      t.remove();
      return { base, afterRipple, movedStart, c2: !!c2.id, selN, afterMulti: t.state().clips };
    });
    check(multi.afterRipple === multi.base - 1 && Math.abs(multi.movedStart) < 0.02,
      'Shift+Delete＝波纹删除（后续片段前移）', 'start=' + multi.movedStart);
    check(multi.selN === 2 && multi.afterMulti === multi.base - 2,
      '多选后一次删除两个片段', multi.selN + ' 选中 → ' + multi.afterMulti + ' 片段');

    /* 23. 快照：保存 / 改动 / 回滚 */
    const snap = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const c = t.project().clips.find(x => x.track === 'v1');
      const n = t.snapshotNow();
      t.setClip(c.id, { start: 3 });
      const changed = (t.project().clips.find(x => x.id === c.id) || {}).start;
      t.restoreSnapshot(t.snapshots().length - 1);
      const back = (t.project().clips.find(x => x.id === c.id) || {}).start;
      return { n, changed, back, btns: document.querySelectorAll('#stInspector [data-snap]').length };
    });
    check(snap.n >= 1 && snap.changed === 3 && snap.back === 0, '快照可把项目回滚到保存点', JSON.stringify(snap));
    check(snap.btns >= 1, '项目面板出现快照恢复入口', snap.btns + ' 个');

    /* 24. 项目文件导出 / 导入（跨会话只保留视频库素材） */
    const imp = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const json = t.exportProjectJSON();
      const obj = JSON.parse(json);
      const textCount = obj.clips.filter(c => c.kind === 'text').length;
      obj.name = '导入项目测试';
      const ok = t.importProjectJSON(JSON.stringify(obj), 'x.hfstudio');
      const st = t.state();
      const p = t.project();
      return {
        ver: obj.v, ok, name: document.getElementById('stProjName').textContent,
        clips: st.clips, media: st.media, textCount,
        fileDropped: p.clips.every(c => c.kind === 'text')
      };
    });
    check(imp.ver === 2 && imp.ok && imp.name === '导入项目测试', '项目文件导出为 v2 并可重新导入', imp.name);
    check(imp.clips === imp.textCount && imp.fileDropped && imp.media === 0,
      '导入时剔除跨会话失效的文件素材', JSON.stringify(imp));

    /* 25. 右键片段：浮动菜单与「分离音频轨道」 */
    const ctxReady = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const m = t.addMedia({ name: '右键视频', kind: 'video', url: 'data:video/mp4;base64,AAAA', dur: 10 });
      const c = t.addClip(m.id, 'v1', 0);
      t.setClip(c.id, { dur: 4 });
      return { id: c.id, mediaId: m.id };
    });
    await page.waitForTimeout(200);
    const cbox = await page.locator('#stRows .st-clip[data-id="' + ctxReady.id + '"]').boundingBox();
    if (!cbox) {
      check(false, '右键菜单：片段在时间线上可见');
    } else {
      await page.mouse.click(cbox.x + 24, cbox.y + cbox.height / 2, { button: 'right' });
      await page.waitForTimeout(150);
      const opened = await page.evaluate(() => {
        const t = window.studioApp.__test;
        const items = t.ctxMenu();
        const el = document.getElementById('stCtx');
        const rect = el ? el.getBoundingClientRect() : null;
        return {
          open: !!rect && rect.width > 0 && rect.height > 0,
          ids: (items || []).map(x => x.id),
          detachDisabled: !!((items || []).find(x => x.id === 'detach') || {}).disabled,
          inBody: !!(el && el.parentElement === document.body),
          sel: t.state().sel
        };
      });
      check(opened.open && opened.inBody && opened.sel === ctxReady.id, '右键视频片段弹出浮动菜单',
        opened.ids.join(','));
      check(opened.ids.indexOf('detach') >= 0 && opened.ids.indexOf('split') >= 0 && !opened.detachDisabled,
        '菜单包含分割与分离音频', opened.ids.join(','));

      await page.click('#stCtx [data-mi="detach"]');
      await page.waitForTimeout(250);
      const det = await page.evaluate(id => {
        const t = window.studioApp.__test;
        const p = t.project();
        const orig = p.clips.find(c => c.id === id);
        const audios = p.clips.filter(c => c.kind === 'audio');
        const a = audios[audios.length - 1];
        return {
          closed: !document.getElementById('stCtx'),
          n: audios.length,
          track: a && a.track,
          start: a && a.start,
          dur: a && a.dur,
          media: a && a.mediaId,
          muted: orig && orig.muted
        };
      }, ctxReady.id);
      check(det.closed && det.n === 1 && det.track === 'a1', '分离音频后菜单关闭并落到音频轨',
        JSON.stringify(det));
      check(det.start === 0 && Math.abs(det.dur - 4) < 0.02 && det.media === ctxReady.mediaId && det.muted,
        '音频片段沿用入点/时长，原视频静音', JSON.stringify(det));

      const again = await page.evaluate(id => {
        const t = window.studioApp.__test;
        t.openCtx(id, 30, 30);
        const items = t.ctxMenu() || [];
        const det2 = items.find(x => x.id === 'detach');
        const out = { disabled: !!(det2 && det2.disabled), label: det2 && det2.label };
        t.closeCtx();
        return out;
      }, ctxReady.id);
      check(again.disabled, '分离后菜单标记「音频已分离」', again.label || '');

      const textMenu = await page.evaluate(() => {
        const t = window.studioApp.__test;
        const text = t.project().clips.find(c => c.kind === 'text');
        t.openCtx(text.id, 30, 30);
        const items = t.ctxMenu() || [];
        const det3 = items.find(x => x.id === 'detach');
        const out = { has: !!det3, disabled: !!(det3 && det3.disabled) };
        t.closeCtx();
        return out;
      });
      check(textMenu.has && textMenu.disabled, '文字片段的「分离音频」不可用');
    }

    /* 26. 专业界面：菜单栏 / 剃刀工具 / 循环 / 适配 / 快捷键面板 */
    const chrome = await page.evaluate(() => ({
      menubar: !!document.getElementById('stMenuBar'),
      tools: !!document.getElementById('stToolSelect') && !!document.getElementById('stToolBlade'),
      loop: !!document.getElementById('stLoop'),
      frame: !!document.getElementById('stPrevFrame') && !!document.getElementById('stNextFrame'),
      zoomVal: (document.getElementById('stZoomVal') || {}).textContent || ''
    }));
    check(chrome.menubar && chrome.tools && chrome.loop && chrome.frame, '菜单栏与工具栏控件齐全',
      JSON.stringify(chrome));

    await page.click('#stMenuBar [data-menu="edit"]');
    await page.waitForTimeout(120);
    const editMenu = await page.evaluate(() => window.studioApp.__test.menuBar());
    check(!!editMenu && editMenu.id === 'edit' && editMenu.items.some(x => x.label === '全选片段'),
      '编辑菜单可展开', editMenu ? editMenu.items.map(x => x.label).join(' / ') : 'null');

    const all = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const ok = t.clickMenu('全选片段');
      const st = t.state();
      return { ok, multi: st.multi.length, total: st.clips, closed: !document.getElementById('stMenuPop') };
    });
    check(all.ok && all.closed && all.multi === all.total && all.total > 0,
      '菜单「全选片段」选中全部片段', JSON.stringify(all));

    const loop1 = await page.evaluate(() => {
      document.getElementById('stLoop').click();
      return window.studioApp.__test.state().loop;
    });
    const loop2 = await page.evaluate(() => {
      document.getElementById('stLoop').click();
      return window.studioApp.__test.state().loop;
    });
    check(loop1 === true && loop2 === false, '循环播放开关可切换', loop1 + ' → ' + loop2);

    await page.evaluate(() => window.studioApp.__test.setTool('blade'));
    const bladeState = await page.evaluate(() => ({
      tool: window.studioApp.__test.state().tool,
      cls: document.getElementById('stRows').classList.contains('blade'),
      btn: document.getElementById('stToolBlade').classList.contains('on')
    }));
    check(bladeState.tool === 'blade' && bladeState.cls && bladeState.btn,
      '剃刀工具激活并切换指针样式', JSON.stringify(bladeState));

    const before = await page.evaluate(() => window.studioApp.__test.state().clips);
    const vidBox = await page.locator('#stRows .st-clip[data-kind="video"]').first().boundingBox();
    if (!vidBox) {
      check(false, '剃刀模式：视频片段可见');
    } else {
      await page.mouse.click(vidBox.x + vidBox.width / 2, vidBox.y + vidBox.height / 2);
      await page.waitForTimeout(250);
      const cut = await page.evaluate(() => {
        const t = window.studioApp.__test;
        const p = t.project();
        const vids = p.clips.filter(c => c.kind === 'video').sort((a, b) => a.start - b.start);
        return { clips: p.clips.length, vids: vids.length, lastStart: vids[vids.length - 1].start };
      });
      check(cut.clips === before + 1 && cut.vids >= 2 && cut.lastStart > 0,
        '剃刀点击片段在指针处切割', before + ' → ' + cut.clips + ' 片段');
    }
    await page.click('#stToolSelect');
    check(await page.evaluate(() => window.studioApp.__test.state().tool === 'select'), '切回选择工具');

    await page.evaluate(() => window.studioApp.__test.setZoom(240));
    await page.click('#stZoomFit');
    await page.waitForTimeout(150);
    const fit = await page.evaluate(() => {
      const st = window.studioApp.__test.state();
      return { pps: st.pps, label: (document.getElementById('stZoomVal') || {}).textContent };
    });
    check(fit.pps < 240 && fit.pps >= 32 && fit.label === String(Math.round(fit.pps)),
      '适配时间线改变缩放并同步百分比', JSON.stringify(fit));

    const help = await page.evaluate(() => {
      const t = window.studioApp.__test;
      t.openMenu('help');
      const items = t.menuBar();
      const ok = t.clickMenu('快捷键一览');
      return { ok, has: !!items && items.items.some(x => x.label === '快捷键一览'), open: t.helpOpen() };
    });
    check(help.has && help.ok && help.open, '帮助菜单打开快捷键面板');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => !window.studioApp.__test.helpOpen()), 'Esc 关闭快捷键面板');

    check(errors.length === 0, '无 pageerror', errors.join(' | '));
  } catch (e) {
    check(false, '探针执行异常', String((e && e.stack) || e));
  } finally {
    await browser.close();
  }

  const ok = run.finish(errors.concat(failList), { fails: failList.length });
  console.log(failList.length ? '\n❌ ' + failList.length + ' 项失败' : '\n✅ 全部通过');
  process.exit(ok ? 0 : 1);
})();
