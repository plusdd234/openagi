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
 *   ⑦ 覆盖 / 插入 / 剪贴板 / 全轨切分 / 入出点 / JKL 的编辑语义；
 *   ⑧ 效果栈、统一合成器抓帧、框选、SRT 字幕、音频波形与语义化历史；
 *   ⑨ 关窗再开，布局不重建、时间线状态保留，全程无 pageerror。
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
      const t = window.studioApp.__test;
      const list = t.tracks();
      return {
        api: !!(window.studioApp && t),
        visible: !!w && !w.classList.contains('hidden'),
        cls: !!w && w.classList.contains('studio'),
        heads: document.querySelectorAll('#stHeads .st-th').length,
        videos: document.querySelectorAll('#stFrame video').length,
        tabs: document.querySelectorAll('#stTabs .st-tab').length,
        tracks: list.length,
        videoTracks: list.filter(x => x.kind === 'video').length
      };
    });
    check(boot.api, '探针 API 就绪');
    check(boot.visible && boot.cls, '窗口已打开且带 studio 类');
    check(boot.heads === boot.tracks && boot.tracks >= 3, '轨道头与项目轨道一致', boot.heads + ' 条');
    check(boot.tabs === 4, '素材面板四个 tab', boot.tabs + ' 个');
    check(boot.videos === boot.videoTracks, '预览池按视频轨创建', boot.videos + ' 个 <video>');

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
    const fresh = await page.evaluate(() => ({
      tracks: window.studioApp.__test.tracks().map(x => x.id),
      videos: document.querySelectorAll('#stFrame video').length
    }));
    check(fresh.tracks.length === 4 && fresh.videos === 2, '新建项目恢复默认四轨',
      fresh.tracks.join(','));

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
    const fxNow = await page.evaluate(id => {
      const t = window.studioApp.__test;
      return { list: t.effects(id), css: t.effectsCss(id) };
    }, rightId);
    check(fxNow.list.length === 1 && fxNow.list[0].preset === 'bw' && fxNow.css.indexOf('grayscale') >= 0,
      '点滤镜写入效果栈并参与效果链', JSON.stringify(fxNow));

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

    /* 15. 数据模型 v3：迁移 / 幂等 / 关键帧采样 */
    const model = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const v1 = {
        v: 1, name: '旧项目', w: 1280, h: 720, fps: 25, media: [],
        clips: [{ id: 'old1', track: 'v1', kind: 'text', start: 0, dur: 2, text: { content: '旧' } }]
      };
      const v2 = {
        v: 2, name: 'v2 项目', w: 1280, h: 720, fps: 25, sampleRate: 48000, media: [],
        tracks: [{ id: 'v1', kind: 'video', name: '视频 1', height: 56, locked: false, muted: false, hidden: false }],
        markers: [], meta: { createdAt: 0, updatedAt: 0, app: 'studio' },
        clips: [{ id: 'old2', track: 'v1', kind: 'video', start: 0, dur: 2, filter: 'warm', kf: {} }]
      };
      const m1 = t.migrate(v1);
      const m2 = t.migrate(m1);
      const m3 = t.migrate(v2);
      const keys = [{ t: 0, v: 0, ease: 'linear' }, { t: 2, v: 10, ease: 'linear' }];
      return {
        ver: m1.v, tracks: m1.tracks.length, markers: m1.markers.length, kf: !!m1.clips[0].kf,
        idem: JSON.stringify(m1) === JSON.stringify(m2),
        v2ver: m3.v,
        legacyFx: m3.clips[0].effects,
        legacyField: Object.prototype.hasOwnProperty.call(m3.clips[0], 'filter'),
        mid: t.sample(keys, 1), head: t.sample(keys, -1), tail: t.sample(keys, 5),
        empty: t.sample([], 1)
      };
    });
    check(model.ver === 3 && model.tracks === 4 && model.markers === 0 && model.kf,
      'v1 项目迁移到 v3（补轨道 / 标记 / 关键帧容器）', JSON.stringify(model));
    check(model.idem, '迁移可重复执行（幂等）');
    check(model.v2ver === 3 && !model.legacyField && model.legacyFx.length === 1 &&
      model.legacyFx[0].type === 'preset' && model.legacyFx[0].preset === 'warm',
      'v2 的 filter 迁入效果栈并删除旧字段', JSON.stringify(model.legacyFx));
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
    check(imp.ver === 3 && imp.ok && imp.name === '导入项目测试', '项目文件导出为 v3 并可重新导入', imp.name);
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

    /* 27. 专业化界面：状态栏 / 检查器页签 / 素材类型筛选 */
    const status = await page.evaluate(() => {
      const t = window.studioApp.__test;
      t.selectAll();
      return {
        clips: (document.getElementById('stStClips') || {}).textContent,
        sel: (document.getElementById('stStSel') || {}).textContent,
        tracks: (document.getElementById('stStTracks') || {}).textContent,
        tool: (document.getElementById('stStTool') || {}).textContent,
        zoom: (document.getElementById('stStZoom') || {}).textContent,
        n: t.state().clips,
        multi: t.state().multi.length
      };
    });
    check(status.clips === status.n + ' 片段' && status.sel === '已选 ' + status.multi + ' 个' &&
      /轨道$/.test(status.tracks) && /px\/s$/.test(status.zoom),
      '底部状态栏同步片段 / 选中 / 轨道 / 缩放', JSON.stringify(status));

    const tabTest = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const clip = t.project().clips.find(c => c.kind === 'video');
      if (!clip) return null;
      t.select(clip.id);
      const box = document.getElementById('stInspector');
      const bar = box.querySelectorAll('[data-itab]');
      const visualBtn = Array.from(bar).find(b => b.dataset.itab === 'visual');
      visualBtn.click();
      const basic = box.querySelector('.st-insp-sec[data-g="basic"]');
      const visual = box.querySelector('.st-insp-sec[data-g="visual"]');
      const out = {
        n: bar.length,
        tab: box.dataset.itab,
        basicHidden: !!basic && getComputedStyle(basic).display === 'none',
        visualShown: !!visual && getComputedStyle(visual).display !== 'none'
      };
      box.querySelector('[data-itab="basic"]').click();
      out.back = box.dataset.itab === 'basic';
      return out;
    });
    check(!!tabTest && tabTest.n >= 4 && tabTest.tab === 'visual' && tabTest.basicHidden &&
      tabTest.visualShown && tabTest.back, '检查器页签切换分组显示', JSON.stringify(tabTest));

    const chip = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const before = document.querySelectorAll('#stMediaGrid .st-mcard').length;
      document.querySelector('#stMediaFilter [data-fk="audio"]').click();
      const audio = t.project().media.filter(m => m.kind === 'audio').length;
      const shown = document.querySelectorAll('#stMediaGrid .st-mcard').length;
      const on = document.querySelector('#stMediaFilter [data-fk="audio"]').classList.contains('on');
      document.querySelector('#stMediaFilter [data-fk="all"]').click();
      return { before, audio, shown, on, restored: document.querySelectorAll('#stMediaGrid .st-mcard').length };
    });
    check(chip.on && chip.shown === chip.audio && chip.restored === chip.before,
      '素材类型筛选只显示对应素材', JSON.stringify(chip));

    /* 28. P0：素材弹层「图库」来源 + 图库素材只存 assetId */
    const assetId = 'probe-asset-1';
    const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await page.evaluate(({ id, url }) => {
      window.assetBridge = {
        available: () => true,
        list: async () => [{ id, kind: 'image', name: '生成图', size: 2048 }],
        read: async () => url,
        thumb: async () => url
      };
    }, { id: assetId, url: tiny });
    await page.click('#stTabs [data-panel="media"]');
    await page.waitForTimeout(120);
    await page.click('#stLibOpen');
    await page.waitForTimeout(180);
    await page.click('#stLibModal [data-libtab="asset"]');
    await page.waitForTimeout(220);
    const assetRows = await page.locator('#stLibList .st-librow[data-asset]').count();
    check(assetRows === 1, '图库页签列出资产', assetRows + ' 条');
    await page.click('#stLibList .st-librow[data-asset]');
    await page.click('#stLibAdd');
    await page.waitForTimeout(260);
    const assetAdded = await page.evaluate(id => {
      const t = window.studioApp.__test;
      const m = t.project().media.find(x => x.assetId === id);
      return { has: !!m, source: m && m.source, name: m && m.name, dur: m && m.dur };
    }, assetId);
    check(assetAdded.has && assetAdded.source === 'asset' && assetAdded.name === '生成图' && assetAdded.dur === 5,
      '图库素材以 assetId 加入素材池', JSON.stringify(assetAdded));
    const assetJson = await page.evaluate(() =>
      JSON.stringify(window.studioApp.__test.clean(window.studioApp.__test.project())));
    check(typeof assetJson === 'string' && assetJson.indexOf('probe-asset-1') >= 0 &&
      assetJson.indexOf('data:image') < 0, '项目存档保留 assetId、不写 dataURL',
      'len=' + String(assetJson || '').length);

    const studioRefs = await page.evaluate(id => {
      let hit = null;
      try {
        hit = typeof libStudioRefs === 'function'
          ? libStudioRefs([id], [{ media: [{ assetId: id }] }, { media: [{ assetId: id }] }])
          : null;
      } catch (e) { hit = null; }
      return hit;
    }, assetId);
    check(!!studioRefs && studioRefs[assetId] === 2, '删除前能统计剪辑台项目引用',
      JSON.stringify(studioRefs));

    /* 29. 文字转语音：文字片段经 ttsBridge 合成配音并落到音频轨 */
    const ttsTextId = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const c = t.project().clips.find(x => x.kind === 'text');
      return c ? c.id : '';
    });
    await page.evaluate(() => {
      const sr = 8000;
      const n = sr;
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const w = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, n * 2, true);
      let bin = '';
      const u = new Uint8Array(buf);
      for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
      const url = 'data:audio/wav;base64,' + btoa(bin);
      window.ttsBridge = {
        defaultVoice: () => 'piper:probe',
        defaultRate: () => 1,
        isLocal: () => true,
        speak: async () => ({ url, voice: 'piper:probe', rate: 1 })
      };
    });
    check(!!ttsTextId, '存在可配音的文字片段');
    if (ttsTextId) {
      await page.evaluate(id => window.studioApp.__test.select(id), ttsTextId);
      await page.click('#stInspector [data-act="voice"]');
      await page.waitForTimeout(700);
      const tts = await page.evaluate(() => {
        const t = window.studioApp.__test;
        const p = t.project();
        const m = p.media.find(x => x.source === 'tts');
        const clip = m ? p.clips.find(c => c.mediaId === m.id) : null;
        return {
          media: !!m,
          text: m && m.tts && m.tts.text,
          voice: m && m.tts && m.tts.voice,
          kind: clip && clip.kind,
          track: clip && clip.track,
          dur: clip && clip.dur
        };
      });
      check(tts.media && !!tts.text && tts.voice === 'piper:probe' && tts.kind === 'audio' && tts.dur > 0.3,
        '文字转语音生成音频片段', JSON.stringify(tts));
      const ttsClean = await page.evaluate(() => {
        const t = window.studioApp.__test;
        const s = JSON.stringify(t.clean(t.project()));
        return { keep: s.indexOf('"source":"tts"') >= 0, noUrl: s.indexOf('data:audio') < 0 };
      });
      check(ttsClean.keep && ttsClean.noUrl, '配音存档只留文本与音色', JSON.stringify(ttsClean));
      const voiceMenu = await page.evaluate(id => {
        const t = window.studioApp.__test;
        t.openCtx(id, 30, 30);
        const items = t.ctxMenu() || [];
        const has = items.some(x => x.id === 'voice');
        t.closeCtx();
        return has;
      }, ttsTextId);
      check(voiceMenu, '文字片段右键有「生成配音」');
    }

    /* 30. 覆盖 / 插入 / 剪贴板 / 全轨切分 */
    await page.click('#stNew');
    await page.click('#stConfirmYes');
    await page.waitForTimeout(220);
    const ops = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const mk = (name, color) => {
        const c = document.createElement('canvas');
        c.width = 160; c.height = 90;
        const x = c.getContext('2d');
        x.fillStyle = color; x.fillRect(0, 0, 160, 90);
        return t.addMedia({ name, kind: 'image', url: c.toDataURL('image/png'), dur: 6 }).id;
      };
      const a = mk('A', '#334455');
      const b = mk('B', '#884422');
      t.seek(0);
      const c1 = t.place(a, 'overwrite');
      t.seek(2);
      const c2 = t.place(b, 'overwrite');
      const afterOverwrite = t.project().clips.filter(c => c.track === 'v1')
        .map(c => ({ id: c.id, start: c.start, dur: c.dur })).sort((x, y) => x.start - y.start);
      t.seek(4);
      const c3 = t.place(a, 'insert');
      const afterInsert = t.project().clips.filter(c => c.track === 'v1')
        .map(c => ({ id: c.id, start: c.start, dur: c.dur })).sort((x, y) => x.start - y.start);
      t.select(c2);
      const copied = t.copy();
      const pasted = t.paste(20);
      const all = t.project().clips.filter(c => c.track === 'v1');
      const last = all.slice().sort((x, y) => x.start - y.start).pop();
      return { c1, c2, c3, afterOverwrite, afterInsert, copied, pasted, pastedStart: last.start };
    });
    check(ops.afterOverwrite.length === 2 && ops.afterOverwrite[0].dur === 2 &&
      ops.afterOverwrite[1].start === 2, '覆盖编辑把头尾片段切开并保住新片段',
      JSON.stringify(ops.afterOverwrite));
    check(ops.afterInsert.length === 4 && ops.afterInsert[2].start === 4 && ops.afterInsert[2].dur === 5 &&
      ops.afterInsert[3].start === 9, '插入编辑撑开空隙并后移后续片段',
      JSON.stringify(ops.afterInsert));
    check(ops.copied === 1 && ops.pasted === 1 && ops.pastedStart === 20,
      '复制片段并在播放头粘贴', 'frames=' + ops.pastedStart + 's');

    const splitAllRes = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const before = t.project().clips.length;
      t.seek(5);
      const made = t.splitAll(5);
      return { made, before, after: t.project().clips.length };
    });
    check(splitAllRes.made === 1 && splitAllRes.after === splitAllRes.before + 1,
      'Ctrl+K 语义：一次切开播放头处所有轨道',
      splitAllRes.before + ' → ' + splitAllRes.after);

    /* 31. 入出点 / JKL */
    const range = await page.evaluate(() => {
      const t = window.studioApp.__test;
      t.setRange('in', 1);
      t.setRange('out', 3);
      const r = t.range();
      const out = { r, end: t.playEnd(), start: t.playStart() };
      t.clearRange();
      out.cleared = t.range();
      return out;
    });
    check(range.r.in === 1 && range.r.out === 3 && range.start === 1 && range.end === 3,
      '入出点写入序列并驱动播放区间', JSON.stringify(range.r));
    check(range.cleared.in === null && range.cleared.out === null, 'X 清除入出点');

    const jkl = await page.evaluate(() => {
      const t = window.studioApp.__test;
      t.seek(10);
      const rev = t.shuttle(-1);
      t.pause();
      const f1 = t.shuttle(1);
      const f2 = t.shuttle(1);
      const f3 = t.shuttle(1);
      t.pause();
      return { rev, f1, f2, f3 };
    });
    check(jkl.rev.dir === -1 && jkl.rev.playing, 'J 进入倒放预览', JSON.stringify(jkl.rev));
    check(jkl.f1.rate === 1 && jkl.f2.rate === 2 && jkl.f3.rate === 4,
      '连按 L 逐级加速 1× → 2× → 4×', [jkl.f1.rate, jkl.f2.rate, jkl.f3.rate].join(' → '));

    /* 32. 效果栈 / 统一合成器抓帧 */
    const fx = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const c = t.project().clips.filter(x => x.kind !== 'text').sort((a, b) => a.start - b.start)[0];
      t.seek(c.start + 0.5);
      t.select(c.id);
      t.setEffects(c.id, []);
      const plain = t.grabFrame(c.start + 0.5);
      const plain2 = t.grabFrame(c.start + 0.5);
      const list = t.setEffects(c.id, [
        { type: 'preset', preset: 'bw' },
        { type: 'adjust', params: { brightness: 1.4 } }
      ]);
      const css1 = t.effectsCss(c.id);
      const filt = t.grabFrame(c.start + 0.5);
      const firstId = list[0].id;
      t.toggleEffect(c.id, firstId, false);
      const css2 = t.effectsCss(c.id);
      t.toggleEffect(c.id, firstId, true);
      const moved = t.moveEffect(c.id, firstId, 1);
      const css3 = t.effectsCss(c.id);
      const blur = t.addEffect(c.id, 'blur');
      return {
        png: plain.indexOf('data:image/png') === 0, stable: plain === plain2,
        differs: plain !== filt, css1, css2, css3, moved, blur,
        count: t.effects(c.id).length
      };
    });
    check(fx.png && fx.stable, '统一 renderFrame 抓帧为稳定 PNG');
    check(fx.css1.indexOf('grayscale') >= 0 && fx.css1.indexOf('brightness(1.4)') >= 0,
      '效果栈按顺序拼进同一条效果链', fx.css1);
    check(fx.differs, '效果开关改变输出像素（预览与导出同源）');
    check(fx.css2.indexOf('grayscale') < 0, '逐条关闭效果只影响该条', fx.css2);
    check(fx.moved && fx.css3.indexOf('grayscale') > fx.css3.indexOf('brightness'),
      '效果可排序，顺序即渲染顺序', fx.css3);
    check(fx.count === 3 && fx.blur && fx.blur.params.px === 4, '可追加模糊效果',
      fx.count + ' 条');

    /* 33. 框选：在空轨道上起手，拖过上方多个片段 */
    const clipBox = await page.locator('#stRows .st-clip').first().boundingBox();
    const emptyRow = await page.locator('#stRows .st-row').last().boundingBox();
    const scBox = await page.locator('#stScroll').boundingBox();
    let marqueeCount = -1;
    let marqueeShown = false;
    if (emptyRow && clipBox && scBox) {
      await page.mouse.move(scBox.x + scBox.width - 70, emptyRow.y + emptyRow.height / 2);
      await page.mouse.down();
      await page.mouse.move(clipBox.x + 4, clipBox.y + 4, { steps: 12 });
      marqueeShown = await page.evaluate(() =>
        !document.getElementById('stMarquee').classList.contains('hidden'));
      await page.mouse.up();
      await page.waitForTimeout(200);
      marqueeCount = await page.evaluate(() => document.querySelectorAll('#stRows .st-clip.sel').length);
    }
    check(marqueeShown, '拖拽中出现框选虚线框');
    check(marqueeCount >= 2, '空白处拖拽框选多个片段', marqueeCount + ' 个');

    /* 34. 字幕：SRT / VTT 解析、导入与导出 */
    const subs = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const srt = '1\n00:00:01,000 --> 00:00:02,500\n第一句\n\n2\n00:00:03,000 --> 00:00:04,250\n第二句\n';
      const vtt = 'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nVTT 字幕\n';
      const p1 = t.parseSubs(srt);
      const p2 = t.parseSubs(vtt);
      const added = t.importSubs(srt + '\n' + vtt);
      const out = t.buildSrt();
      const round = t.parseSubs(out);
      return {
        p1, p2, added, out, round: round.length,
        first: round[0] && round[0].text,
        textClips: t.project().clips.filter(c => c.kind === 'text').length
      };
    });
    check(subs.p1.length === 2 && subs.p1[0].start === 1 && subs.p1[0].end === 2.5,
      '解析 SRT 时间码（毫秒精度）', JSON.stringify(subs.p1[0]));
    check(subs.p2.length === 1 && subs.p2[0].text === 'VTT 字幕', '解析 WebVTT 头与点号时间码');
    check(subs.added === 3 && subs.textClips === 3, '导入字幕落到文字轨', subs.added + ' 条');
    check(subs.round === 3 && subs.first === '第一句' &&
      subs.out.indexOf('00:00:01,000 --> 00:00:02,500') >= 0, '导出的 SRT 可被自身解析器读回');

    /* 35. 音频波形：页面内 1 秒正弦波 */
    const wave = await page.evaluate(async () => {
      const t = window.studioApp.__test;
      const sr = 8000, n = sr;
      const buf = new ArrayBuffer(44 + n * 2);
      const v = new DataView(buf);
      const w = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, 'data'); v.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin((i / sr) * 2 * Math.PI * 440) * 12000), true);
      let bin = '';
      const u = new Uint8Array(buf);
      for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
      const url = 'data:audio/wav;base64,' + btoa(bin);
      const m = t.addMedia({ name: '正弦波', kind: 'audio', url: url, dur: 1 });
      t.seek(30);
      const cid = t.place(m.id, 'overwrite');
      const loaded = await t.loadPeaks(m.id);
      const canvas = document.querySelector('#stRows .st-clip[data-kind="audio"] canvas.st-wave');
      return { cid, loaded, peaks: t.peaks(m.id), canvas: !!canvas && canvas.width > 0, level: !!document.getElementById('stLevel') };
    });
    check(wave.cid && wave.loaded > 10 && wave.peaks && wave.peaks.max > 0.05,
      '解码音频并压成有界峰值数组', wave.loaded + ' 点 / peak=' + (wave.peaks ? wave.peaks.max.toFixed(2) : '-'));
    check(wave.canvas && wave.level, '音频片段出现波形，传输栏出现电平表');

    /* 36. 语义化历史：标签可读，可跳回 */
    const hist = await page.evaluate(() => {
      const t = window.studioApp.__test;
      const labels = t.history();
      const before = t.project().clips.length;
      const ok = t.goHistory(0);
      return { labels, before, ok, after: t.project().clips.length };
    });
    check(hist.labels.some(x => x === '覆盖素材') && hist.labels.some(x => x === '插入素材') &&
      hist.labels.indexOf('粘贴片段') >= 0 && hist.labels.indexOf('导入字幕') >= 0,
      '历史记录带语义标签', hist.labels.slice(-5).join(' / '));
    check(hist.ok && hist.after === 0, '历史面板可跳回动作之前', hist.before + ' → ' + hist.after);

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
