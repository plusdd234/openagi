#!/usr/bin/env node
/* 探针：特征提取台（featlab）
 * 用法：node tools/probe-featlab.js
 *
 * 关注的是「没有模型也能用完整条人工链路」：
 *   ① 桌面图标 / 窗口 / 三栏布局都在；
 *   ② 导入图片后能框选、能新增区域、能排序、能改名；
 *   ③ 边界能按像素微调（四边 ±、外扩 / 内缩、1:1、方向键）；
 *   ④ 标注自动生成，图集预览与 JSON 导出内容一致；
 *   ⑤ 右键能复制图片进剪切板（区域小图 / 整张源图 / 图集）；
 *   ⑥ 填表式提示词：中文 / 英文 / 双语生成，可复制；
 *   ⑦ 切走再回来是同一个窗口、区域不丢；
 *   ⑧ 全程无 pageerror。
 *
 * 不访问真实模型：AI 定位 / 复核 / 命名只检查按钮存在，不发请求（后面用桩验接线）。
 * 剪贴板：把 navigator.clipboard.write / writeText 包一层，先把交给系统的内容记下来再真写。
 *   这样断言的是「我们递出去的是不是合法 PNG / 正确文本」，不依赖机器剪贴板状态。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { createRun } = require('./probe-run');

const run = createRun('probe-featlab');
let fails = 0;
const checks = [];

function check(ok, name, extra) {
  checks.push({ ok: !!ok, name, extra: extra || '' });
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra != null && extra !== '' ? ' · ' + extra : ''));
  if (!ok) fails++;
}

(async () => {
  const root = path.join(__dirname, '..');
  const errors = [];
  let browser = null;
  try {
    browser = await chromium.launch({ channel: 'msedge' });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
    page.on('pageerror', e => errors.push(String((e && e.stack) || (e && e.message))));
    await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
    await page.waitForTimeout(1200);

    check(await page.evaluate(() => !!document.querySelector('.desk-app[data-app="featlab"]')), '桌面出现「特征提取台」图标');

    await page.evaluate(() => window.openDeskApp('featlab'));
    await page.waitForTimeout(700);

    const shell = await page.evaluate(() => {
      const win = document.getElementById('featlabWin');
      const s = win && win.querySelector('.featlab-shell');
      const r = s ? s.getBoundingClientRect() : null;
      return {
        exists: !!s,
        visible: !!win && !win.classList.contains('hidden'),
        w: r ? Math.round(r.width) : 0,
        h: r ? Math.round(r.height) : 0,
        winW: win ? Math.round(win.getBoundingClientRect().width) : 0,
        rail: !!win.querySelector('.featlab-rail'),
        stage: !!win.querySelector('.featlab-viewwrap canvas'),
        panel: !!win.querySelector('.featlab-panel')
      };
    });
    check(shell.exists && shell.visible, '窗口打开且渲染了三栏编辑器', shell.w + '×' + shell.h);
    check(shell.rail && shell.stage && shell.panel, '左栏 / 画布 / 右栏齐全');
    check(shell.w >= shell.winW - 40, '内容铺满窗口（没有缩成小卡片）', shell.w + ' / ' + shell.winW);

    check(await page.evaluate(() => {
      const tabs = Array.prototype.map.call(document.querySelectorAll('.featlab-tabs [data-ftab]'), b => b.getAttribute('data-ftab'));
      return tabs.join(',') === 'ext,atlas,prompt,ann';
    }), '右栏分成 提取 / 图集 / 提示词 / 标注 四页');
    check(await page.evaluate(() => {
      const on = document.querySelector('.featlab-tabpage.on');
      return !!on && on.getAttribute('data-tab') === 'ext';
    }), '默认停在「提取」页');

    await run.shot(page, '01-empty.png');

    /* 导入一张真实 PNG（用当前页面截图当素材），走和用户一样的 input 路径 */
    const png = await page.screenshot({ type: 'png' });
    const pngPath = run.artifact('probe-source.png');
    fs.writeFileSync(pngPath, png);
    await page.setInputFiles('#featlabFile', pngPath);
    await page.waitForFunction(() => {
      const img = document.querySelector('#featlabSrcs .featlab-src img');
      return !!img && img.naturalWidth > 0;
    }, { timeout: 10000 });
    await page.waitForTimeout(300);

    check(await page.evaluate(() => !!document.querySelector('#featlabSrcs .featlab-src')), '源图导入成功');
    check(await page.evaluate(() => document.getElementById('featlabEmpty').classList.contains('hide')), '空状态已让位给画布');
    check(await page.evaluate(() => {
      const c = document.getElementById('featlabCanvas');
      return c && c.width > 100 && c.height > 100;
    }), '画布已按视口尺寸初始化');

    /* 人工链路 1：新增区域 */
    await page.click('.featlab-listfoot [data-act="add-region"]');
    await page.waitForTimeout(250);
    check(await page.evaluate(() => document.querySelectorAll('#featlabList .featlab-row').length === 1), '「新增区域」生成 1 个区域');
    check(await page.evaluate(() => {
      const v = document.getElementById('featlabAnn').value;
      return v.indexOf('3行3列') === 0 && v.indexOf('左上为图1人物') >= 0;
    }), '标注按 3×3 位置自动生成', await page.evaluate(() => document.getElementById('featlabAnn').value));

    /* 人工链路 2：在画布上拖框 */
    const box = await page.evaluate(() => {
      const r = document.getElementById('featlabCanvas').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });
    await page.click('[data-tool="add"]');
    await page.mouse.move(box.x + box.w * 0.42, box.y + box.h * 0.38);
    await page.mouse.down();
    await page.mouse.move(box.x + box.w * 0.56, box.y + box.h * 0.52, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(350);
    check(await page.evaluate(() => document.querySelectorAll('#featlabList .featlab-row').length === 2), '画布框选生成第 2 个区域');
    check(await page.evaluate(() => !!document.querySelector('#featlabInspect #featlabSelName')), '选中区域后出现检查器（可改名 / 微调）');

    /* 改名 */
    const nameInput = await page.$('#featlabSelName');
    await nameInput.fill('发髻');
    await page.waitForTimeout(250);
    check(await page.evaluate(() => document.getElementById('featlabAnn').value.indexOf('发髻') >= 0), '改名后标注同步更新');

    /* 排序 */
    await page.click('#featlabList .featlab-row:nth-child(2) [data-ract="up"]');
    await page.waitForTimeout(250);
    check(await page.evaluate(() => {
      const first = document.querySelector('#featlabList .featlab-row input');
      return first && first.value === '发髻';
    }), '上移把「发髻」排到左上（图集顺序跟着变）');

    /* 逐格写标注：直接在区域行下面写那一句，整段标注自动重算 */
    check(await page.evaluate(() => {
      const rows = document.querySelectorAll('#featlabList .featlab-row');
      return rows.length > 0 && !!rows[0].querySelector('.featlab-row-note');
    }), '每个特征区域下面都有一行可写的标注');

    const noteInput = await page.$('#featlabList .featlab-row:nth-child(1) .featlab-row-note');
    await noteInput.fill('高挽的发髻，插着金步摇');
    await page.waitForTimeout(250);
    const annText = await page.evaluate(() => document.getElementById('featlabAnn').value);
    check(annText.indexOf('人物的高挽的发髻，插着金步摇') >= 0,
      '逐格写的标注直接进整段（不用另外拼）', annText);
    check(await page.evaluate(() => {
      const rows = document.querySelectorAll('#featlabList .featlab-row');
      return rows[1].querySelector('.featlab-row-note').value === '';
    }), '没写的格子留空，整段退回用名称');

    /* 选区微调：把 W 改成 40% */
    await page.evaluate(() => {
      const el = document.querySelector('#featlabSelName');
      if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const wInput = await page.$('#featlabInspect [data-box="2"]');
    if (wInput) {
      await wInput.fill('40');
      await wInput.dispatchEvent('change');
      await page.waitForTimeout(200);
    }
    check(await page.evaluate(() => {
      const el = document.querySelector('#featlabInspect [data-box="2"]');
      return el && Math.abs(Number(el.value) - 40) < 0.6;
    }), '检查器可把区域宽度精确改到 40%');

    /* ---- 边界微调 ---- */
    const pxOf = async () => page.evaluate(() => {
      const m = /(\d+)×(\d+) px/.exec((document.getElementById('featlabInspMeta') || {}).textContent || '');
      return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
    });
    const p0 = await pxOf();
    check(!!p0 && p0.w > 0 && p0.h > 0, '检查器显示像素尺寸', p0 ? p0.w + '×' + p0.h : '没读到');

    await page.click('.featlab-stepgrp [data-step="10"]');
    check(await page.evaluate(() => {
      const b = document.querySelector('.featlab-stepgrp [data-step="10"]');
      return b && b.classList.contains('on');
    }), '边界步进可切到 10px');

    await page.click('[data-act="edge-expand"]');
    await page.waitForTimeout(150);
    const p1 = await pxOf();
    check(p1 && p1.w === p0.w + 20 && p1.h === p0.h + 20, '「外扩」四边各 +10px', p1 ? p1.w + '×' + p1.h : '没读到');

    await page.click('[data-act="edge-shrink"]');
    await page.waitForTimeout(150);
    const p2 = await pxOf();
    check(p2 && p2.w === p0.w && p2.h === p0.h, '「内缩」回到原尺寸', p2 ? p2.w + '×' + p2.h : '没读到');

    /* 单边：左边界内收 10px → 宽 -10，左移 +10 */
    const leftBefore = await page.evaluate(() => Number(document.querySelector('#featlabInspect [data-box="0"]').value));
    await page.click('[data-edge="l"][data-dir="1"]');
    await page.waitForTimeout(150);
    const leftAfter = await page.evaluate(() => ({
      x: Number(document.querySelector('#featlabInspect [data-box="0"]').value),
      w: Number(document.querySelector('#featlabInspect [data-box="2"]').value)
    }));
    check(leftAfter.x > leftBefore && Math.abs((leftAfter.w + (leftAfter.x - leftBefore)) - 40) < 0.3,
      '单边「左」微调只动左边（宽随之减少）', leftBefore.toFixed(1) + '% → ' + leftAfter.x.toFixed(1) + '%');

    /* 方向键：移动 / Alt 调边（先把焦点从输入框挪开，否则按键被当成打字） */
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    const posBefore = await page.evaluate(() => Number(document.querySelector('#featlabInspect [data-box="0"]').value));
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(120);
    const posAfter = await page.evaluate(() => Number(document.querySelector('#featlabInspect [data-box="0"]').value));
    check(posAfter > posBefore, '方向键微调选中区域', posBefore.toFixed(1) + '% → ' + posAfter.toFixed(1) + '%');

    const hBefore = await pxOf();
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForTimeout(150);
    const hAfter = await pxOf();
    check(hAfter && hAfter.h === hBefore.h + 10, 'Alt+方向键只拉那一条边', hBefore.h + ' → ' + hAfter.h);

    await page.click('[data-act="edge-square"]');
    await page.waitForTimeout(150);
    const sq = await pxOf();
    check(sq && Math.abs(sq.w - sq.h) <= 1, '1:1 把选区调成正方形', sq ? sq.w + '×' + sq.h : '没读到');

    /* ---- 剪贴板：先包一层，把递给系统的内容记下来 ---- */
    await page.evaluate(() => {
      window.__clip = [];
      const cb = navigator.clipboard || (navigator.clipboard = {});
      cb.write = async function (items) {
        const rec = [];
        for (const it of items) {
          for (const t of it.types) {
            try {
              const b = await it.getType(t);
              rec.push({ type: t, size: b.size, magic: b.type });
            } catch (e) { rec.push({ type: 'error', size: 0, magic: String(e && e.message) }); }
          }
        }
        window.__clip.push({ kind: 'image', items: rec });
      };
      cb.writeText = async function (text) {
        window.__clip.push({ kind: 'text', text: String(text) });
      };
    });

    /* 右键画布上的区域 → 菜单 → 复制该区域小图 */
    const canvasPt = await page.evaluate(() => {
      const c = document.getElementById('featlabCanvas').getBoundingClientRect();
      const zoom = parseFloat(document.getElementById('featlabZoom').textContent || '100') / 100;
      const hud = (document.getElementById('featlabHudInfo').textContent || '').match(/(\d+)×(\d+)/);
      const iw = hud ? Number(hud[1]) : 1440, ih = hud ? Number(hud[2]) : 900;
      const get = k => Number(document.querySelector('#featlabInspect [data-box="' + k + '"]').value) / 100;
      const ox = (c.width - iw * zoom) / 2, oy = (c.height - ih * zoom) / 2;
      return {
        x: c.left + ox + (get(0) + get(2) / 2) * iw * zoom,
        y: c.top + oy + (get(1) + get(3) / 2) * ih * zoom
      };
    });
    await page.mouse.click(canvasPt.x, canvasPt.y, { button: 'right' });
    await page.waitForTimeout(200);
    const menu = await page.evaluate(() => {
      const el = document.getElementById('featlabCtx');
      return {
        open: !!el && !el.hidden,
        text: el ? el.innerText : '',
        items: el ? el.querySelectorAll('.featlab-ctx-item').length : 0
      };
    });
    check(menu.open && menu.items >= 3, '画布右键弹出菜单', menu.items + ' 项');
    check(menu.text.indexOf('小图') >= 0 && menu.text.indexOf('整张源图') >= 0 && menu.text.indexOf('九宫格图集') >= 0,
      '菜单含 区域小图 / 整张源图 / 图集 三个复制入口');

    await run.shot(page, '02-ctxmenu.png');

    await page.click('#featlabCtx .featlab-ctx-item:first-child');
    await page.waitForTimeout(300);
    const clip1 = await page.evaluate(() => window.__clip.filter(c => c.kind === 'image').pop());
    check(!!clip1 && clip1.items.some(i => i.type === 'image/png' && i.size > 1000),
      '复制区域小图：交给剪贴板的是 image/png', clip1 ? JSON.stringify(clip1.items) : '没有写入记录');
    check(await page.evaluate(() => {
      const s = document.getElementById('featlabStatus').textContent || '';
      return s.indexOf('已复制') >= 0 || s.indexOf('已改为下载') >= 0;
    }), '状态栏如实反馈复制结果', await page.evaluate(() => document.getElementById('featlabStatus').textContent));

    /* 右键源图缩略图 → 复制整张源图 */
    await page.click('#featlabSrcs .featlab-src', { button: 'right' });
    await page.waitForTimeout(150);
    const srcMenu = await page.evaluate(() => (document.getElementById('featlabCtx') || {}).innerText || '');
    check(srcMenu.indexOf('复制这张图') >= 0, '源图右键可复制整张图');
    await page.click('#featlabCtx .featlab-ctx-item:first-child');
    await page.waitForTimeout(300);
    const clip2 = await page.evaluate(() => window.__clip.filter(c => c.kind === 'image').pop());
    check(!!clip2 && clip2.items.some(i => i.type === 'image/png' && i.size > 1000), '复制整张源图写入 image/png');

    /* ---- 提示词（先切到图集页把尺寸定下来，再走填表） ---- */
    await page.click('[data-ftab="atlas"]');
    check(await page.evaluate(() => {
      const p = document.querySelector('.featlab-tabpage[data-tab="atlas"]');
      return p && p.classList.contains('on');
    }), '点「图集」页可切换');

    await page.evaluate(() => {
      const sel = document.getElementById('featlabCell');
      sel.value = '256';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.click('[data-act="build"]');
    await page.waitForTimeout(400);
    const built = await page.evaluate(() => {
      const s = document.getElementById('featlabStatus').textContent || '';
      const pv = document.getElementById('featlabPreview');
      return { status: s, pw: pv.width, ph: pv.height };
    });
    check(built.status.indexOf('已拼图集') >= 0, '拼图集成功', built.status);
    check(built.pw > 300 && built.pw === built.ph, '图集预览按比例生成（正方形）', built.pw + '×' + built.ph);

    /* 图集右键复制 */
    await page.click('#featlabPreviewWrap', { button: 'right' });
    await page.waitForTimeout(150);
    check(await page.evaluate(() => {
      const el = document.getElementById('featlabCtx');
      return !!el && !el.hidden && el.innerText.indexOf('复制九宫格图集') >= 0;
    }), '图集预览右键可复制九宫格');
    await page.click('#featlabCtx .featlab-ctx-item:first-child');
    await page.waitForTimeout(300);
    const clip3 = await page.evaluate(() => window.__clip.filter(c => c.kind === 'image').pop());
    check(!!clip3 && clip3.items.some(i => i.type === 'image/png' && i.size > 1000), '图集写入 image/png');

    /* ---- 填表式提示词 ---- */
    await page.click('[data-ftab="prompt"]');
    await page.waitForTimeout(150);
    check(await page.evaluate(() => {
      const p = document.querySelector('.featlab-tabpage[data-tab="prompt"]');
      return p && p.classList.contains('on') && p.querySelectorAll('input,select,textarea').length >= 9;
    }), '提示词页是可填的表单');

    await page.fill('#featlabPmSubject', '少女');
    await page.evaluate(() => {
      const sel = document.getElementById('featlabPmStyle');
      sel.value = '写实摄影';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.fill('#featlabPmAngle', '四分之三侧');
    await page.fill('#featlabPmLight', '柔和侧光');
    await page.click('#featlabPmQuality [data-q="超清细节"]');
    await page.waitForTimeout(200);

    const zh = await page.evaluate(() => document.getElementById('featlabPmOut').value);
    check(zh.indexOf('写实摄影风格') >= 0 && zh.indexOf('少女') >= 0 && zh.indexOf('超清细节') >= 0,
      '中文提示词按表单生成', zh);

    /* 「填入特征」把区域名写进细节 */
    await page.click('[data-act="pm-regions"]');
    await page.waitForTimeout(200);
    const details = await page.evaluate(() => document.getElementById('featlabPmDetails').value);
    check(details.indexOf('发髻') >= 0, '「填入特征」把区域名写进细节', details);

    /* 英文 / 双语 */
    await page.click('[data-pmlang="en"]');
    await page.waitForTimeout(200);
    const en = await page.evaluate(() => document.getElementById('featlabPmOut').value);
    check(en.indexOf('photorealistic photography') >= 0 && en.indexOf('ultra detailed') >= 0,
      '英文模式给的是英文关键词（不是中文原样塞）', en);
    check(en.indexOf('发髻') < 0, '英文模式不会把中文名词塞进 CLIP 提示词');

    await page.click('[data-pmlang="both"]');
    await page.waitForTimeout(200);
    const both = await page.evaluate(() => document.getElementById('featlabPmOut').value);
    check(both.indexOf('中文：') === 0 && both.indexOf('English:') > 0, '双语模式两段都在');

    await page.click('[data-pmlang="zh"]');
    await page.waitForTimeout(200);

    /* 复制提示词 / 负面词 */
    await page.click('[data-act="copy-prompt"]');
    await page.waitForTimeout(250);
    const cText = await page.evaluate(() => {
      const t = window.__clip.filter(c => c.kind === 'text').pop();
      return { got: t ? t.text : '', want: document.getElementById('featlabPmOut').value };
    });
    check(!!cText.got && cText.got === cText.want, '复制提示词：写进剪贴板的就是文本框里那串');

    await page.click('[data-act="copy-negative"]');
    await page.waitForTimeout(250);
    const cNeg = await page.evaluate(() => {
      const t = window.__clip.filter(c => c.kind === 'text').pop();
      return { got: t ? t.text : '', want: document.getElementById('featlabPmNeg').value };
    });
    check(!!cNeg.got && cNeg.got === cNeg.want && cNeg.got.length > 0, '复制负面词', cNeg.got);

    /* 手改结果后不再被表单覆盖，点「恢复自动」回来 */
    await page.fill('#featlabPmOut', '我手改过的一句');
    await page.waitForTimeout(150);
    await page.click('[data-q="8K"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => document.getElementById('featlabPmOut').value === '我手改过的一句'), '手改过的提示词不会被表单覆盖');
    await page.click('[data-act="pm-reset"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => document.getElementById('featlabPmOut').value.indexOf('8K') >= 0), '「恢复自动」按表单重新生成');

    await run.shot(page, '03-prompt.png');

    /* 导出 JSON：内容要能对上（标注页隐藏也能读值） */
    await page.click('[data-ftab="atlas"]');
    const dlWait = page.waitForEvent('download', { timeout: 8000 });
    await page.click('[data-act="export-json"]');
    const dl = await dlWait;
    const dlPath = await dl.path();
    const json = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
    check(json.generator === 'featlab' && json.version === 1, 'JSON 带生成器与版本号');
    check(Array.isArray(json.regions) && json.regions.length === 2, 'JSON 导出 2 个区域', json.regions && json.regions.length);
    check(json.atlas && json.atlas.width === 768 && json.atlas.height === 768, 'JSON 记录图集尺寸 768×768');
    check(json.regions[0].name === '发髻' && json.regions[0].position === '左上', 'JSON 顺序与图集一致（左上是发髻）');
    check(json.regions[0].note === '高挽的发髻，插着金步摇' && json.regions[0].line.indexOf('高挽的发髻') >= 0,
      'JSON 记录逐格标注与拼好的那一句', json.regions[0].line);
    /* 提示词表单里把主体改成「少女」后，标注与 AI 提取的主体是同一个值 —— 标注应跟着变 */
    check(typeof json.annotation === 'string' && json.annotation.indexOf('3行3列') === 0 &&
      json.annotation.indexOf('左上为图1少女的') >= 0,
      'JSON 内含标注文本，且关键主体已同步', json.annotation);

    await run.shot(page, '04-built.png');

    /* 幂等：切走再回来，窗口节点不变、区域不丢、分页还停在原处 */
    await page.evaluate(() => { document.getElementById('featlabWin').__probeTag = 'keep'; });
    await page.evaluate(() => window.openDeskApp('hello'));
    await page.waitForTimeout(400);
    await page.evaluate(() => window.openDeskApp('featlab'));
    await page.waitForTimeout(500);
    check(await page.evaluate(() => document.getElementById('featlabWin').__probeTag === 'keep'), '切走再回来仍是同一个窗口节点');
    check(await page.evaluate(() => document.querySelectorAll('#featlabList .featlab-row').length === 2), '回到 App 后区域没有丢');
    check(await page.evaluate(() => {
      const on = document.querySelector('.featlab-tabpage.on');
      return !!on && on.getAttribute('data-tab') === 'atlas';
    }), '回到 App 后仍停在离开时的分页');

    /* AI 链路：用桩替换模型通道，验证定位 → 复核 → 入库 → 命名的接线 */
    await page.evaluate(() => {
      window.llmConn = function () { return { model: 'probe-stub', base: 'http://stub.local', key: 'probe' }; };
      window.llmStreamRequest = async function (sys, msgs) {
        const s = String(sys || '');
        if (s.indexOf('复核员') >= 0) return JSON.stringify({ checks: { 1: { ok: true, reason: '' } } });
        if (s.indexOf('命名器') >= 0) return JSON.stringify({ names: { 1: '衣领' } });
        return JSON.stringify({ regions: [{ name: '腰部', box: [0.3, 0.55, 0.24, 0.16] }] });
      };
    });
    await page.click('[data-ftab="ext"]');
    await page.click('[data-act="ai-extract"]');
    await page.waitForFunction(() => document.querySelectorAll('#featlabList .featlab-row').length === 3, { timeout: 8000 });
    check(await page.evaluate(() => document.getElementById('featlabAnn').value.indexOf('腰部') >= 0), 'AI 定位 + 复核后新增区域并写进标注');

    await page.click('#featlabList .featlab-row:nth-child(2) input');
    await page.waitForTimeout(200);
    await page.click('[data-act="ai-name"]');
    await page.waitForFunction(() => {
      const el = document.querySelector('#featlabList .featlab-row:nth-child(2) input');
      return el && el.value === '衣领';
    }, { timeout: 8000 });
    check(await page.evaluate(() => document.getElementById('featlabAnn').value.indexOf('衣领') >= 0), 'AI 命名为手工区域补上名字');

    /* AI 按钮存在（不在探针里发真实请求） */
    check(await page.evaluate(() => ['ai-extract', 'ai-name', 'ai-verify'].every(a => !!document.querySelector('[data-act="' + a + '"]'))),
      'AI 提取 / 命名 / 复核入口都在');

    check(errors.length === 0, '全程无 pageerror', errors.length ? errors[0].slice(0, 160) : '');
  } catch (e) {
    errors.push(String((e && e.stack) || e));
    check(false, '探针执行未抛异常', String((e && e.message) || e));
  } finally {
    if (browser) await browser.close();
    const ok = run.finish(errors, { checks, fails });
    console.log(ok && fails === 0 ? '\n✅ featlab 探针通过' : '\n❌ featlab 探针失败：' + fails + ' 项');
    process.exit(ok && fails === 0 ? 0 : 1);
  }
})();
