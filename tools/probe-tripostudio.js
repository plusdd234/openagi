#!/usr/bin/env node
/* 探针：Tripo 工坊（apps/tripostudio）
 *
 * 只验证「编辑器自己的链路」，不碰真实 Tripo 浏览器：
 *   - 顶替 window.wfTripoWebImage / wfTripoWebModel 两个工作流节点函数
 *   - 顶替 window.tripoWebFetch，让 /status 返回已登录
 * 用 data: URL 的 PNG / OBJ 做真实解析，断言仍走 DOM / state / renderer.info，
 * 不靠截图判断。
 *
 * 用法：node tools/probe-tripostudio.js
 */
'use strict';

const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const { createRun } = require('./probe-run');

const RUN = createRun('probe-tripostudio');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const info = (name, extra) => console.log(' ·· ' + name + (extra ? ' · ' + extra : ''));

/* 1×1 透明 PNG + 四面体 OBJ，都是 data: URL，走真实的图像 / 模型解析链路 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const OBJ = 'data:text/plain;base64,' + Buffer.from([
  'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'v 0 0 1',
  'f 1 2 3', 'f 1 2 4', 'f 2 3 4', 'f 1 3 4'
].join('\n')).toString('base64');

(async () => {
  const root = path.join(__dirname, '..');
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(String((e && e.message) || e)));

  const wait = (fn, timeout, arg) => page.waitForFunction(fn, arg === undefined ? null : arg, { timeout: timeout || 15000 });

  try {
    await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
    await page.waitForTimeout(800);

    /* ---- 1. 从桌面入口打开 ---- */
    const opened = await page.evaluate(() => {
      if (typeof window.openDeskApp !== 'function') return 'no openDeskApp';
      window.openDeskApp('tripostudio');
      return 'ok';
    });
    check(opened === 'ok', '桌面入口 openDeskApp("tripostudio") 可调用', opened);

    await wait(() => !!(window.TripStudio && window.TripStudio.ready()), 12000);
    check(await page.evaluate(() => window.TripStudio.ready()), 'mount 完成，body 标记 ready');

    const box = await page.evaluate(() => {
      const w = document.getElementById('tripostudioWin');
      const b = document.querySelector('#tripostudioWin .tps-app');
      if (!w || !b) return null;
      const r = w.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), bw: Math.round(rb.width), bh: Math.round(rb.height) };
    });
    check(!!box && box.w > 900 && box.h > 500, '窗口铺开', box ? box.w + '×' + box.h : 'null');
    check(!!box && box.bw > 900 && box.bh > 500, '.tps-app 撑满窗口 body', box ? box.bw + '×' + box.bh : 'null');

    /* ---- 2. 面板切换（真实点击 rail） ---- */
    await page.evaluate(() => {
      document.querySelector('#tripostudioWin .tps-rail-btn[data-panel="model"]').click();
    });
    const pModel = await page.evaluate(() => window.TripStudio.getPanel());
    await page.evaluate(() => {
      document.querySelector('#tripostudioWin .tps-rail-btn[data-panel="image"]').click();
    });
    const pImage = await page.evaluate(() => window.TripStudio.getPanel());
    check(pModel === 'model' && pImage === 'image', 'rail 面板切换', pModel + ' → ' + pImage);

    /* ---- 3. 顶替节点函数与助手状态 ---- */
    const stubbed = await page.evaluate(({ png, obj }) => {
      window.__tpsPng = png;
      window.__tpsObj = obj;
      window.__tpsCalls = { img: 0, model: 0 };
      window.tripoWebFetch = function (pathname) {
        if (pathname === '/status') {
          return Promise.resolve({ ok: true, running: true, ready: true, modelReady: true, url: '', title: 'mock' });
        }
        return Promise.resolve({ ok: true });
      };
      window.wfTripoWebImage = function (prompt, refs) {
        window.__tpsCalls.img++;
        return Promise.resolve({
          url: window.__tpsPng,
          file: 'mock-' + window.__tpsCalls.img + '.png',
          canvas: null,
          message: '',
          refs: (refs || []).slice()
        });
      };
      window.wfTripoWebModel = function () {
        window.__tpsCalls.model++;
        return Promise.resolve({ url: window.__tpsObj, file: 'mock.obj', size: 2048, message: '' });
      };
      return typeof window.wfTripoWebImage === 'function' && typeof window.wfTripoWebModel === 'function';
    }, { png: PNG, obj: OBJ });
    check(stubbed, '已顶替 tripoWebFetch / wfTripoWebImage / wfTripoWebModel');

    /* ---- 4. 生图 ---- */
    await page.evaluate(() => {
      const ta = document.querySelector('#tripostudioWin [data-form="image.prompt"]');
      ta.value = '探针：一只低多边形恐龙';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = Array.from(document.querySelectorAll('#tripostudioWin .tps-side [data-act="genImage"]'))
        .filter(b => b.offsetParent)[0];
      if (btn) btn.click();
    });
    await wait(() => window.TripStudio.state().assets.length === 1, 15000);
    await page.waitForTimeout(500);
    const imgState = await page.evaluate(() => {
      const s = window.TripStudio.state();
      return {
        n: s.assets.length,
        kind: s.assets[0] && s.assets[0].kind,
        stage: window.TripStudio.getStage(),
        shown: !!document.querySelector('#tripostudioWin img[data-role="img"].is-on'),
        calls: window.__tpsCalls.img
      };
    });
    check(imgState.n === 1 && imgState.kind === 'image', '生图：生成 1 个图像资源', JSON.stringify(imgState));
    check(imgState.stage === 'image' && imgState.shown, '生图：图像已载入 2D 视口');
    check(imgState.calls === 1, '生图：调用了 Tripo 生图节点');

    /* ---- 5. 生模型（单图，用当前图像当参考） ---- */
    await page.evaluate(() => {
      document.querySelector('#tripostudioWin .tps-rail-btn[data-panel="model"]').click();
    });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#tripostudioWin [data-act="refFromCurrent"][data-target="model:single"]'))
        .filter(x => x.offsetParent)[0];
      if (b) b.click();
    });
    await page.waitForTimeout(400);
    const refSet = await page.evaluate(() => {
      const slot = document.querySelector('#tripostudioWin .tps-ref[data-ref="model:single"]');
      return !!(slot && slot.classList.contains('has'));
    });
    check(refSet, '生模型：参考图已填入单图槽');

    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#tripostudioWin .tps-side [data-act="genModel"]'))
        .filter(x => x.offsetParent)[0];
      if (b) b.click();
    });
    await wait(() => window.TripStudio.state().assets.some(a => a.kind === 'model'), 20000);
    await page.waitForTimeout(1200);
    const modelState = await page.evaluate(() => {
      const s = window.TripStudio.state();
      const m = s.assets.find(a => a.kind === 'model');
      const st = window.TripStudio.stats();
      const mt = document.querySelector('#tripostudioWin [data-role="missing"]');
      const hint = document.querySelector('#tripostudioWin [data-role="stageHint"]');
      return {
        n: s.assets.length,
        has3d: window.TripStudio.has3d(),
        stage: window.TripStudio.getStage(),
        tris: st ? st.tris : -1,
        verts: st ? st.verts : -1,
        missing: !!(m && m.meta && m.meta.missing),
        calls: window.__tpsCalls.model,
        hint: hint ? hint.textContent : '',
        missingText: mt && !mt.classList.contains('hidden') ? mt.textContent : ''
      };
    });
    check(modelState.has3d && modelState.tris > 0, '生模型：3D 视口解析出三角面',
      'tri=' + modelState.tris + ' verts=' + modelState.verts + ' hint=' + modelState.hint + ' missing=' + modelState.missingText);
    check(modelState.stage === 'model' && !modelState.missing, '生模型：自动切到 3D 舞台且资源可用');
    check(modelState.calls === 1, '生模型：调用了 Tripo 模型节点');

    /* ---- 6. 生成并应用纹理（模型已选中） ---- */
    await page.evaluate(() => {
      document.querySelector('#tripostudioWin .tps-rail-btn[data-panel="texture"]').click();
      const ta = document.querySelector('#tripostudioWin [data-form="tex.prompt"]');
      ta.value = '探针：磨砂金属表面';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#tripostudioWin .tps-side [data-act="genTexture"]'))
        .filter(x => x.offsetParent)[0];
      if (b) b.click();
    });
    await wait(() => {
      const st = window.TripStudio.stats();
      return !!(st && st.hasTexture);
    }, 20000);
    const texState = await page.evaluate(() => {
      const s = window.TripStudio.state();
      const tex = s.assets.find(a => a.kind === 'texture');
      const model = s.assets.find(a => a.kind === 'model');
      const st = window.TripStudio.stats();
      return {
        texAssets: s.assets.filter(a => a.kind === 'texture').length,
        hasTexture: !!(st && st.hasTexture),
        metaTex: !!(model && model.meta && model.meta.textureUrl),
        texUrlIsPng: !!(tex && /^data:image\/png/.test(tex.url)),
        tile: model && model.meta && model.meta.tex ? model.meta.tex.tile : null,
        calls: window.__tpsCalls.img
      };
    });
    check(texState.texAssets === 1 && texState.texUrlIsPng, '纹理：生成 1 张纹理资源', JSON.stringify(texState));
    check(texState.hasTexture && texState.metaTex, '纹理：已贴到当前模型并写回资源 meta');
    check(texState.calls === 2, '纹理：复用了生图节点生成无缝贴图');

    /* ---- 7. 拉回生成结果（对话框 → URL 回接） ---- */
    const before = await page.evaluate(() => window.TripStudio.state().assets.length);
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#tripostudioWin [data-act="pullBack"]'))
        .filter(x => x.offsetParent)[0];
      if (b) b.click();
    });
    await page.waitForTimeout(200);
    const dlgOpen = await page.evaluate(() => {
      const d = document.querySelector('#tripostudioWin [data-role="dialog"]');
      return !!(d && !d.classList.contains('hidden'));
    });
    check(dlgOpen, '拉回：对话框已打开');

    await page.evaluate((png) => {
      const input = document.querySelector('#tripostudioWin [data-role="pullUrl"]');
      input.value = png;
      const btn = document.querySelector('#tripostudioWin [data-act="pullDo"]');
      if (btn) btn.click();
    }, PNG);
    await wait(n => window.TripStudio.state().assets.length === n + 1, 10000, before).catch(() => {});
    const afterPull = await page.evaluate(() => {
      const s = window.TripStudio.state();
      const a = s.assets[0];
      return {
        n: s.assets.length,
        kind: a && a.kind,
        source: a && a.meta && a.meta.source,
        dlgClosed: !!document.querySelector('#tripostudioWin [data-role="dialog"]').classList.contains('hidden')
      };
    });
    check(afterPull.n === before + 1, '拉回：资源数量 +1', before + ' → ' + afterPull.n);
    check(afterPull.kind === 'image' && afterPull.source === 'pull', '拉回：自动识别为图像并标记来源');
    check(afterPull.dlgClosed, '拉回：提交后关闭对话框');

    /* ---- 8. 重复打开幂等：DOM 不重建、输入不丢 ---- */
    const keep = await page.evaluate(() => {
      window.__tpsNode = document.querySelector('#tripostudioWin .tps-app');
      const ta = document.querySelector('#tripostudioWin [data-form="image.prompt"]');
      ta.value = '探针：重复打开后应保留';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      window.deskCloseWin(document.getElementById('tripostudioWin'));
      return ta.value;
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => window.openDeskApp('tripostudio'));
    await page.waitForTimeout(900);
    const again = await page.evaluate(() => {
      const node = document.querySelector('#tripostudioWin .tps-app');
      const all = document.querySelectorAll('#tripostudioWin .tps-app').length;
      const ta = document.querySelector('#tripostudioWin [data-form="image.prompt"]');
      return {
        same: node === window.__tpsNode,
        all: all,
        value: ta ? ta.value : '',
        ready: window.TripStudio.ready(),
        n: window.TripStudio.state().assets.length
      };
    });
    check(again.same && again.all === 1, '再次打开：复用同一份 DOM（mount 幂等）');
    check(again.value === keep, '再次打开：输入内容保留', JSON.stringify(again.value));
    check(again.ready && again.n >= 4, '再次打开：项目资源与就绪状态保留', 'assets=' + again.n);

    /* ---- 9. 3D 视口真的在渲染 ---- */
    const gpu = await page.evaluate(() => {
      const host = document.querySelector('#tripostudioWin [data-role="host3d"]');
      const canvas = host ? host.querySelector('canvas') : null;
      const st = window.TripStudio.stats();
      return {
        canvas: !!canvas,
        cw: canvas ? canvas.width : 0,
        ch: canvas ? canvas.height : 0,
        tris: st ? st.tris : -1,
        hasTexture: !!(st && st.hasTexture)
      };
    });
    check(gpu.canvas && gpu.cw > 100 && gpu.ch > 100, '3D 画布存在且尺寸正常', gpu.cw + '×' + gpu.ch);
    check(gpu.tris > 0 && gpu.hasTexture, '3D 视口仍持有模型与纹理', 'tri=' + gpu.tris);

    info('页面错误', errors.length ? errors.join(' | ') : '无');
  } catch (e) {
    fails++;
    console.error(' ❌ 探针异常：' + ((e && e.stack) || e));
    errors.push(String((e && e.message) || e));
  } finally {
    await browser.close().catch(() => {});
  }

  const ok = RUN.finish(errors.concat(fails ? ['fails=' + fails] : []));
  console.log((ok ? '✅' : '❌') + ' probe-tripostudio 结束 · 失败 ' + fails + ' 项 · 结果 ' +
    path.relative(path.join(__dirname, '..'), RUN.dir));
  process.exit(fails ? 1 : 0);
})();
