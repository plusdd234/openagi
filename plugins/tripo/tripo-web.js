#!/usr/bin/env node
'use strict';
/**
 * Tripo 网页自动化助手（有头浏览器 + 人工登录）
 *
 * 用法：
 *   node tripo-web.js
 *   node tripo-web.js --url=https://studio.tripo3d.ai/
 *   node tripo-web.js --timeout=300 --cooldown=15
 *   node tripo-web.js --selftest
 *
 * 流程：
 *   1. 打开真实 Edge 窗口（独立持久化配置，首次需手动登录）
 *   2. 你手动进入生图页面后回车确认
 *   3. 输入提示词，脚本自动填入、点击生成、等待结果并下载图片
 *
 * 风险提示：
 *   Tripo 服务条款禁止使用自动化工具访问/提取服务内容，此脚本可能触发风控，
 *   导致账号被限制、积分清零且不退款。请自行评估并承担风险。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const DEFAULT_URL = 'https://studio.tripo3d.com/';
const ALT_URL = 'https://studio.tripo3d.ai/';
// 目录可用环境变量覆盖：装成桌面应用后 __dirname 在只读的 asar / resources 里，
// 登录态与产物必须落到用户数据目录（Electron 主进程会传这三个变量）
const PROFILE_DIR = process.env.TRIPO_PROFILE_DIR || path.join(__dirname, '.tripo-profile');
const OUT_DIR = process.env.TRIPO_OUT_DIR || path.join(__dirname, 'tripo_out');
const TMP_DIR = process.env.TRIPO_TMP_DIR || path.join(__dirname, 'tripo_tmp');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const hit = argv.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return fallback;
  if (hit.includes('=')) return hit.split('=').slice(1).join('=');
  return fallback;
}
const TARGET_URL = argValue('url', DEFAULT_URL);
const TIMEOUT_SEC = Number(argValue('timeout', '180')) || 180;
const COOLDOWN_SEC = Number(argValue('cooldown', '10'));
const SELFTEST = argv.includes('--selftest');
const SERVE = argv.includes('--serve');
const PORT = Number(process.env.PORT || argValue('port', '8790')) || 8790;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- 启动浏览器 ----------
// 优先连接「用户手动启动的 Edge」（CDP 模式）
// 背景：Playwright 自己 launch 的浏览器带自动化特征，Cloudflare 会反复弹「验证真人」，
// 人工点完还会再弹。改成连接一个普通启动的 Edge（无自动化特征）后，挑战基本能一次通过。
const CDP_URL = process.env.TRI_CDP_URL || 'http://127.0.0.1:9222';
const CDP_PORT = Number(String(CDP_URL).match(/:(\d+)/)?.[1] || 9222);
// 额外的 Edge 启动参数（例如 TRI_EDGE_ARGS=--proxy-server=direct://）
const EDGE_EXTRA_ARGS = String(process.env.TRI_EDGE_ARGS || '').split(/\s+/).filter(Boolean);

function edgeExecutable() {
  const cands = [
    process.env.TRI_EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return '';
}

async function cdpAlive(timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(CDP_URL + '/json/version', { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch (e) { return false; }
}

// 用普通方式拉起一个 Edge（带远程调试端口），而不是用 Playwright 启动 ——
// 这样浏览器没有任何自动化特征，Cloudflare 不会反复弹验证。
function spawnPlainEdge() {
  const exe = edgeExecutable();
  if (!exe) return false;
  const args = [
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + PROFILE_DIR,
    '--no-first-run',
    '--no-default-browser-check',
    ...EDGE_EXTRA_ARGS,
    TARGET_URL,
  ];
  try {
    const child = spawn(exe, args, {
      detached: true, stdio: 'ignore', windowsHide: false,
    });
    child.unref();
    log('已启动普通 Edge（远程调试端口 ' + CDP_PORT + '），等待它就绪…');
    return true;
  } catch (e) {
    log('启动 Edge 失败：' + e.message);
    return false;
  }
}

async function tryConnectCDP() {
  try {
    const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
    const ctx = browser.contexts()[0];
    if (!ctx) return null;
    const pages = ctx.pages().filter(p => !p.isClosed());
    const page = pages[0] || await ctx.newPage();
    log('已连接到 Edge（CDP 模式），自动化特征更低，不易触发 Cloudflare 验证');
    return { context: ctx, page };
  } catch (e) {
    return null;
  }
}

async function launch() {
  // ① 已有 CDP 浏览器在跑就直接连
  if (await cdpAlive()) {
    const cdp = await tryConnectCDP();
    if (cdp) {
      cdp.context.on('page', p => recordPage(p));
      recordPage(cdp.page);
      return cdp;
    }
  }

  // ② 没有就自己拉起一个普通 Edge，再连上去
  if (spawnPlainEdge()) {
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (await cdpAlive()) {
        const cdp = await tryConnectCDP();
        if (cdp) {
          cdp.context.on('page', p => recordPage(p));
          recordPage(cdp.page);
          return cdp;
        }
      }
    }
    log('Edge 未能就绪，回退到 Playwright 启动方式');
  }

  // ③ 兜底：Playwright 自己启动（带反检测参数）
  const args = ['--start-maximized'];
  // 反自动化检测：Playwright 默认会带上 --enable-automation 且暴露 navigator.webdriver，
  // Cloudflare 的挑战会因此反复弹「验证真人」循环。以下措施把特征抹掉。
  args.push(
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--no-default-browser-check',
    '--no-first-run',
  );
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'msedge',
    headless: SELFTEST,
    viewport: null,
    acceptDownloads: true,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  // 抹掉 navigator.webdriver
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
      if (window.chrome) window.chrome.runtime = window.chrome.runtime || {};
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'], configurable: true });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5], configurable: true });
    } catch (e) { /* 忽略 */ }
  });
  context.on('page', p => recordPage(p));
  const page = context.pages()[0] || await context.newPage();
  recordPage(page);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch(e => log('页面加载提示：' + e.message));
  return { context, page };
}

// ---------- 参考图：落盘与上传 ----------
function cleanTmp() {
  try {
    if (!fs.existsSync(TMP_DIR)) return;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const name of fs.readdirSync(TMP_DIR)) {
      const file = path.join(TMP_DIR, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch {}
}

async function resolveImageFile(src) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  let buffer = null;
  let ext = '.png';
  if (/^data:/i.test(src)) {
    const d = decodeDataUrl(src);
    if (!d) throw new Error('参考图 data URL 解析失败');
    buffer = d.buffer;
    ext = d.ext;
  } else if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error('参考图下载失败 HTTP ' + r.status);
    buffer = Buffer.from(await r.arrayBuffer());
    ext = extFromType(r.headers.get('content-type') || '', src);
  } else {
    throw new Error('参考图格式不支持');
  }
  const file = path.join(TMP_DIR, `ref_${Date.now()}_${Math.floor(Math.random() * 1000)}${ext}`);
  fs.writeFileSync(file, buffer);
  return file;
}

async function visibleImageSrcs(page) {
  return page.evaluate(() => Array.from(document.images).filter(i => {
    const r = i.getBoundingClientRect();
    return r.width > 24 && r.height > 24;
  }).map(i => i.currentSrc || i.src).filter(Boolean)).catch(() => []);
}

/* ---------- 参考图就绪探测 ----------
 * 背景（真实 bug）：写入文件控件只代表「浏览器接受了文件」，页面还要转码 / 上传 / 处理，
 * 之后才会渲染出参考图缩略图。原来的实现是「写完就固定等 1.8 秒」，
 * 上传稍慢就会出现「参考图还没传完就点了生成」，模型只看到部分参考图。
 *
 * 探测口径与 clearReferences 保持一致：可见的 blob:/data: 图片（自然尺寸 > 0）算一张已就绪参考图。
 * busy 信号（进度条 / 上传中文案 / 百分比）只用于「多等一会儿」，不作为成败判据：
 * 页面上可能有与参考图无关的常驻动画，卡它会把正常流程拖死。 */
async function refsSnapshot(page) {
  return page.evaluate(() => {
    const vis = el => { const b = el.getBoundingClientRect(); return b.width > 4 && b.height > 4; };
    const thumbs = Array.from(document.images).filter(i => {
      const s = i.currentSrc || i.src || '';
      if (!/^blob:|^data:/i.test(s)) return false;
      return vis(i);
    });
    const loaded = thumbs.filter(i => i.naturalWidth > 0).length;
    let busy = 0, busyText = '';
    const progSel = '[role="progressbar"],[class*="progress" i],[class*="loading" i],[class*="uploading" i],[class*="spinner" i]';
    for (const el of Array.from(document.querySelectorAll(progSel))) {
      if (!vis(el)) continue;
      busy++;
      if (!busyText) busyText = String(el.className || '').slice(0, 40);
    }
    if (busyText === '') {
      const BUSY = /(上传中|上传失败|处理中|解析中|分析中|\d{1,3}\s*%)/;
      for (const el of Array.from(document.querySelectorAll('div,span,p,li,button,small'))) {
        if (!vis(el) || el.children.length) continue;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 12) continue;
        if (!BUSY.test(t)) continue;
        busy++;
        busyText = t;
        break;
      }
    }
    return { total: thumbs.length, loaded, busy, busyText };
  }).catch(() => ({ total: 0, loaded: 0, busy: 0, busyText: '' }));
}

/* 等参考图全部就绪。
 * 返回 ok = 已就绪数量是否达标（无法识别缩略图时按 ok 处理并标记 verified:false，
 * 避免把「探测不到」误判成「上传失败」而阻断正常流程）。 */
async function waitRefsReady(page, expect, opts = {}) {
  const need = Math.max(1, Number(expect) || 1);
  const timeoutMs = Math.max(3000, Math.min(180000, Number(opts.timeoutMs) || 45000));
  const quietMs = Math.max(0, Number(opts.quietMs) || 1200);
  const busyGraceMs = Math.max(0, Number(opts.busyGraceMs) || 10000);
  const t0 = Date.now();
  let last = null, goodMs = 0, busySince = 0;
  while (Date.now() - t0 < timeoutMs) {
    last = await refsSnapshot(page);
    const enough = last.loaded >= need;
    if (!enough) { goodMs = 0; busySince = 0; }
    else if (last.busy > 0) {
      goodMs = 0;
      if (!busySince) busySince = Date.now();
      // 数量够了但页面还在忙：给一段宽限，超过就按就绪放行（busy 可能来自无关动画）
      if (Date.now() - busySince >= busyGraceMs) {
        return { ok: true, verified: true, reason: 'busy-ignored', ...last, waited: Date.now() - t0 };
      }
    } else {
      busySince = 0;
      goodMs += 600;
      if (goodMs >= quietMs) {
        return { ok: true, verified: true, reason: 'ready', ...last, waited: Date.now() - t0 };
      }
    }
    // 一张都识别不到：说明探测口径不适用当前页面，退回固定静默等待，不阻断
    if (last.total === 0 && last.busy === 0 && Date.now() - t0 >= 3000) {
      return { ok: true, verified: false, reason: 'no-thumbs', loaded: 0, total: 0, waited: Date.now() - t0 };
    }
    await sleep(600);
  }
  const verified = !!last && last.loaded >= need;
  return {
    ok: verified, verified: !!last && last.total > 0 && verified,
    reason: verified ? 'timeout-quiet' : 'timeout',
    loaded: last ? last.loaded : 0, total: last ? last.total : 0,
    busy: last ? last.busy : 0, busyText: last ? last.busyText : '',
    waited: Date.now() - t0
  };
}

/* 等「已就绪缩略图数量超过 before」——页面真的把新图渲染出来了。
 * 用于逐张上传时「写完一张等一张就绪再写下一张」。
 * 页面上压根识别不到缩略图（total 一直是 0）时只短等 noThumbMs 后放过，
 * 避免把探测口径不适用的页面（如缩略图用背景图渲染）拖死；是否真的就绪由就绪闸门复核。 */
async function waitThumbGrow(page, before, opts = {}) {
  const timeoutMs = Math.max(1000, Math.min(60000, Number(opts.timeoutMs) || 12000));
  const noThumbMs = Math.max(1000, Math.min(timeoutMs, Number(opts.noThumbMs) || 4000));
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < timeoutMs) {
    st = await refsSnapshot(page);
    if (st.loaded > before) return { ok: true, loaded: st.loaded, total: st.total, waited: Date.now() - t0 };
    if (st.total === 0 && Date.now() - t0 >= noThumbMs) break;
    await sleep(400);
  }
  return { ok: false, loaded: st ? st.loaded : before, total: st ? st.total : 0, waited: Date.now() - t0 };
}

async function attachReference(page, file, opts = {}) {
  const base = typeof opts.base === 'number' ? opts.base : (await refsSnapshot(page)).loaded;
  // expectTotal：多张上传时按累计数量等待（第 2 张要等到 2 张就绪），避免漏等后漏判
  const target = typeof opts.expectTotal === 'number' ? Math.max(base + 1, opts.expectTotal) : base + 1;
  const waitMs = Math.max(2000, Math.min(60000, Number(opts.waitMs) || 25000));
  // 等到「新的一张缩略图真正加载出来」，而不是只看到 src 出现。
  // 返回 'preview'（看到新缩略图）/ 'unknown'（页面不渲染可识别缩略图、明确报失败、
  // 或等满超时也没看到——都按「已写入」继续，由就绪闸门给出最终判断）
  const previewAppeared = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      const st = await refsSnapshot(page);
      if (st.loaded >= target) return 'preview';
      // 页面压根不渲染可识别的缩略图：短等后按「已写入」处理，由就绪闸门复核
      if (st.total === 0 && st.busy === 0 && Date.now() - t0 >= 3000) return 'unknown';
      // 页面明确报失败（上传失败 / 格式不支持…）：不再干等，交给就绪闸门给出最终判断
      if (/失败|错误|不支持|error|fail|invalid/i.test(st.busyText || '')) return 'unknown';
      await sleep(500);
    }
    const after = await visibleImageSrcs(page);
    return after.some(s => !beforeSrcs.includes(s)) ? 'preview' : 'unknown';
  };
  const beforeSrcs = await visibleImageSrcs(page);

  // 1) 页面里已有、可见且接受图片的文件输入（排除模型/视频上传）
  const inputs = await page.$$('input[type=file]');
  for (const el of inputs) {
    const accept = ((await el.getAttribute('accept').catch(() => '')) || '').toLowerCase();
    if (accept && !/image|\.png|\.jpe?g|\.webp|\*/.test(accept)) continue;
    if (/model|glb|fbx|obj|video|mp4/.test(accept)) continue;
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    try {
      await el.setInputFiles(file, { timeout: 5000 });
      const seen = await previewAppeared();
      log(seen === 'preview' ? '参考图已上传并出现预览' : '参考图已写入上传控件（未检测到新预览，继续执行）');
      return true;
    } catch {}
  }
  // 2) 上传 / 参考图按钮触发的文件选择
  const candidates = await page.$$('button, [role="button"], label, [class*="upload"], [class*="reference"]');
  for (const el of candidates) {
    const text = ((await el.innerText().catch(() => '')) || '').trim().slice(0, 30);
    if (!text) continue;
    if (!/(上传|参考图|添加图片|拖入|upload|reference|add image)/i.test(text)) continue;
    if (/(模型|model|3d|视频|video)/i.test(text)) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null),
      el.click({ timeout: 3000 }).catch(() => {}),
    ]);
    if (chooser) {
      try {
        await chooser.setFiles(file);
        const seen = await previewAppeared();
        log(seen === 'preview' ? '参考图已上传并出现预览' : '参考图已写入上传控件（未检测到新预览，继续执行）');
        return true;
      } catch (e) {
        log('参考图写入失败：' + e.message);
      }
    }
  }
  return false;
}

// 多张参考图上传
// 真实页面实测结论：参考图控件虽带 multiple，但一次性写入多张不会触发页面逐图处理，
// 因此主路径是「逐张写入」——每次写一张，页面追加进参考图列表；
// 一次性写入仅作兜底（供支持数组写入的页面使用）。
// 关掉页面上的引导/教程弹窗（如「选择生图模型 2/2 … 知道了」）
// 这些弹窗会挡住参考图上传区与生成按钮，必须先关掉
async function dismissOnboarding(page) {
  const hit = await page.evaluate(() => {
    const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const WANT = /^(知道了|我知道了|跳过|不再提示|稍后再说|立即体验|开始使用|关闭)$/;
    // 优先点弹窗内的按钮
    const dialogs = Array.from(document.querySelectorAll('[role=dialog],[class*=modal],[class*=Modal],[class*=dialog],[class*=popup]'));
    for (const dlg of dialogs) {
      if (!vis(dlg)) continue;
      for (const el of dlg.querySelectorAll('button,[role=button]')) {
        if (!vis(el)) continue;
        const t = (el.innerText || '').trim();
        if (t && WANT.test(t)) { el.click(); return t; }
      }
    }
    // 没有弹窗容器时，退而求其次找页面上的同名按钮
    for (const el of document.querySelectorAll('button,[role=button]')) {
      if (!vis(el)) continue;
      const t = (el.innerText || '').trim();
      if (t && WANT.test(t)) { el.click(); return t; }
    }
    return '';
  }).catch(() => '');
  if (hit) { await sleep(900); log('已关闭页面引导弹窗：' + hit); }
  return hit;
}

// 清空页面上已有的参考图
// 背景：Tripo 的上传区是「追加」式的——不清空的话，每次运行都会把新图叠在上一轮的旧图上，
// 模型会拿到一堆残留参考图。策略：
//   ① 优先点「清空 / 重置 / 清除」类按钮
//   ② 否则逐个点缩略图上的删除控件
//   ③ 都不可行时返回 ok=false，由调用方整页重载来保证干净状态
async function clearReferences(page) {
  const countBlobs = () => page.evaluate(() => Array.from(document.querySelectorAll('img'))
    .filter(i => /^blob:/.test(i.src || '') && i.naturalWidth > 0).length).catch(() => 0);

  const before = await countBlobs();
  if (!before) return { ok: true, method: 'empty', removed: 0 };

  // ① 文本类清空按钮
  const byText = await page.evaluate(() => {
    const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    for (const el of document.querySelectorAll('button,[role=button],span,div,label,a')) {
      if (!vis(el)) continue;
      const t = (el.innerText || '').trim();
      if (!t || t.length > 6) continue;
      if (/^(清空|清除|重置|移除|删除|全部清空|clear|reset|remove|delete)$/i.test(t)) {
        el.click();
        return t;
      }
    }
    return '';
  }).catch(() => '');
  if (byText) {
    await sleep(1200);
    const after = await countBlobs();
    if (after < before) {
      log(`已通过「${byText}」清空参考图（${before} → ${after}）`);
      return { ok: true, method: 'text:' + byText, removed: before - after };
    }
  }

  // ② 逐个点缩略图上的删除控件
  let removed = 0;
  for (let round = 0; round < 8; round++) {
    const n = await countBlobs();
    if (!n) break;
    const hit = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const imgs = Array.from(document.querySelectorAll('img'))
        .filter(i => /^blob:/.test(i.src || '') && i.naturalWidth > 0);
      if (!imgs.length) return '';
      const img = imgs[0];
      const b = img.getBoundingClientRect();
      let node = img.parentElement;
      for (let d = 0; d < 5 && node && node !== document.body; d++, node = node.parentElement) {
        for (const el of node.querySelectorAll('button,[role=button],svg,span,div,i')) {
          if (!vis(el)) return '';
          const bb = el.getBoundingClientRect();
          if (bb.x + bb.width < b.x - 48 || bb.x > b.x + b.width + 48) continue;
          const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || ''));
          const t = (el.innerText || '').trim();
          const aria = (el.getAttribute('aria-label') || '') + '|' + (el.getAttribute('title') || '');
          if (/delete|remove|clear|close|trash/i.test(cls) || /delete|remove|clear|close/i.test(aria) || t === '×' || t === '✕') {
            el.click();
            return cls.slice(0, 40) || t || aria.slice(0, 20) || 'del';
          }
        }
      }
      return '';
    }).catch(() => '');
    if (!hit) break;
    removed++;
    await sleep(700);
  }
  const after = await countBlobs();
  if (after < before) {
    log(`已清空参考图（${before} → ${after}）`);
    return { ok: true, method: 'delete-btn', removed: before - after };
  }
  log(`未能清空参考图（仍有 ${after} 张），需要整页重载`);
  return { ok: false, method: 'none', removed: 0, remain: after };
}

async function attachReferences(page, files, opts = {}) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return { ok: false, uploaded: 0 };
  const base = (await refsSnapshot(page)).loaded;
  if (list.length === 1) {
    const ok = await attachReference(page, list[0], { base });
    const st = await refsSnapshot(page);
    const uploaded = Math.max(0, st.loaded - base);
    // 单张：写进去且（出现缩略图 或 页面不渲染可识别缩略图）即算写入成功；
    // 是否真的就绪由调用方的就绪闸门复核（上传慢/被页面静默丢弃时给出精确提示）
    return { ok: ok && (uploaded >= 1 || st.total === 0), uploaded, state: st };
  }

  let written = 0;
  for (let i = 0; i < list.length; i++) {
    // expectTotal 按累计数量等待：第 i 张要等到 base+i+1 张缩略图就绪
    if (await attachReference(page, list[i], { base, expectTotal: base + i + 1 })) written++;
    await sleep(700);
  }
  let st = await refsSnapshot(page);
  let uploaded = Math.max(0, st.loaded - base);
  // ok 只表示「文件都写进了控件」；参考图是否处理完由就绪闸门（waitRefsReady）判定，
  // 避免把「写入成功但页面还在处理」误报成上传失败，也避免写入不全却放行去生成
  const allWritten = written >= list.length;
  if (uploaded >= list.length) {
    log(`已逐张上传参考图：${uploaded}/${list.length} 张已就绪`);
    return { ok: allWritten, uploaded, state: st };
  }
  if (uploaded > 0) {
    // 就绪了一部分却不足：不重写（重复写入会让页面出现两份参考图），
    // 是否处理完交给就绪闸门复核，由它给出「已就绪 x/y」的精确提示
    log(`逐张上传后 ${uploaded}/${list.length} 张就绪，是否处理完交由就绪闸门复核`);
    return { ok: allWritten, uploaded, state: st };
  }
  log('逐张上传后未检测到就绪的缩略图，尝试一次性写入…');

  // 兜底：一次性写入带 multiple 的控件（仅供支持数组写入、逐张写不进去的页面）
  const handles = await page.$$('input[type=file]');
  for (const el of handles) {
    const info = await el.evaluate(e => {
      const r = e.getBoundingClientRect();
      const a = (e.getAttribute('accept') || '').toLowerCase();
      return { visible: r.width > 0 && r.height > 0, multiple: !!e.multiple, accept: a };
    }).catch(() => null);
    if (!info || !info.visible || !info.multiple) continue;
    if (!/image|png|jpe?g|webp|\*/.test(info.accept)) continue;
    try {
      await el.setInputFiles(list, { timeout: 15000 });
      written = Math.max(written, list.length);
      await sleep(1800);
      st = await refsSnapshot(page);
      uploaded = Math.max(0, st.loaded - base);
      if (uploaded > 0) {
        log(`已一次性写入，当前 ${uploaded}/${list.length} 张就绪`);
        return { ok: written >= list.length, uploaded, state: st };
      }
    } catch (e) {
      log('一次性写入失败：' + e.message);
    }
    break;
  }
  return { ok: written >= list.length, uploaded, state: st };
}

/* 比例：把文本/属性里的比例抽成 token 集合（"1 : 1"、"方形 1:1"、"1:1（方形）" 都算 1:1）
   严格 innerText 相等会把本来存在的选项判成没找到，然后静默保持页面默认尺寸。 */
function ratioTokens(v) {
  const out = [];
  const s = String(v == null ? '' : v).replace(/[：]/g, ':').replace(/[×＊]/g, 'x');
  const re = /(\d{1,2}(?:\.\d+)?)\s*[:xX／\/]\s*(\d{1,2}(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] + ':' + m[2]);
  return out;
}

function normRatio(v) {
  const t = ratioTokens(v);
  return t.length ? t[0] : '';
}

async function ratioCandidates(page) {
  const els = await page.$$('button, [role="button"], [role="option"], [role="radio"], [role="menuitemradio"], [class*="ratio"], [class*="aspect"], [class*="size"]');
  const hits = [];
  for (const el of els) {
    const meta = await el.evaluate(e => ({
      text: (e.innerText || '').trim(),
      hint: [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('data-value'), e.getAttribute('alt')]
        .filter(Boolean).join(' '),
    })).catch(() => null);
    if (!meta) continue;
    const tokens = ratioTokens(meta.text + ' ' + meta.hint);
    if (!tokens.length) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 8 || box.height < 8) continue;
    hits.push({ el, tokens, area: box.width * box.height });
  }
  return hits;
}

// 兜底：比例常常收在下拉里，先点开「比例 / 尺寸」触发器。返回触发器句柄（失败时用来原路点回去）
async function openRatioMenu(page) {
  const els = await page.$$('button, [role="button"], [role="combobox"], [class*="select"], [class*="dropdown"], [class*="trigger"]');
  let best = null;
  for (const el of els) {
    const info = await el.evaluate(e => ({
      text: (e.innerText || '').trim(),
      hint: [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('data-value')].filter(Boolean).join(' '),
    })).catch(() => null);
    if (!info) continue;
    if (!/比例|尺寸|画面比例|aspect|ratio/i.test(info.text + ' ' + info.hint)) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 8 || box.height < 8) continue;
    const area = box.width * box.height;
    if (!best || area < best.area) best = { el, area };
  }
  if (!best) return null;
  await best.el.click({ timeout: 3000 }).catch(() => {});
  await sleep(250);
  return best.el;
}

async function selectRatio(page, ratio) {
  if (!ratio || ratio === 'auto') return false;
  const want = normRatio(ratio);
  if (!want) return false;

  const pick = async () => {
    const hits = (await ratioCandidates(page)).filter(h => h.tokens.includes(want));
    hits.sort((a, b) => a.area - b.area);   // 面积最小的才是比例胶囊，不是包住整排比例的容器
    return hits[0] || null;
  };

  let hit = await pick();
  let trigger = null;
  if (!hit) {
    trigger = await openRatioMenu(page);
    if (trigger) { await sleep(300); hit = await pick(); }
  }
  if (!hit) {
    // 没命中就把弹层原路收回去，免得它盖住提示词输入框
    if (trigger) {
      await trigger.click({ timeout: 2000 }).catch(() => {});
      await sleep(150);
      await page.keyboard.press('Escape').catch(() => {});
    }
    return false;
  }
  await hit.el.click({ timeout: 3000 }).catch(() => {});
  await sleep(300);
  return true;
}

// ---------- 页面元素探测 ----------
async function findPromptInput(page) {
  const handles = await page.$$('textarea, [contenteditable="true"], [role="textbox"]');
  const items = [];
  for (const el of handles) {
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 120 || box.height < 18) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const meta = await el.evaluate(e => ({
      tag: e.tagName.toLowerCase(),
      hint: ((e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase(),
    })).catch(() => ({ tag: '', hint: '' }));
    // 占位符明确是“描述/提示词/prompt”的输入框优先，其次取面积最大的
    const score = (/描述|提示|prompt|describe|画面|场景|想象|输入文本|生成图片|参考图生成/.test(meta.hint) ? 1e6 : 0) + box.width * box.height;
    items.push({ el, area: box.width * box.height, tag: meta.tag, score, hint: meta.hint });
  }
  items.sort((a, b) => b.score - a.score);
  return items[0] || null;
}

async function findGenerateButton(page, anchor) {
  // 优先在提示词输入框所在的容器里找，避免点到其它面板的「生成三视图」
  if (anchor) {
    const scoped = await anchor.evaluateHandle(el => {
      let p = el;
      for (let i = 0; i < 8 && p; i++) {
        const hit = Array.from(p.querySelectorAll('button,[role="button"]')).filter(b => {
          const t = (b.innerText || '').trim();
          return t && t.length <= 12 && /(生成|generate|create)/i.test(t) && !/(登录|sign|upgrade|升级|购买|充值|设置|settings|下载|download)/i.test(t);
        });
        if (hit.length) return p;
        p = p.parentElement;
      }
      return document.body;
    }).catch(() => null);
    if (scoped) {
      const handles = await scoped.$$('button,[role="button"]').catch(() => []);
      const pick = await pickGenerateButton(handles);
      if (pick) return pick;
    }
  }
  const handles = await page.$$('button, [role="button"], a');
  return pickGenerateButton(handles);
}

async function pickGenerateButton(handles) {
  const all = [];
  for (const el of handles) {
    const text = (await el.innerText().catch(() => '') || '').trim();
    if (!text || text.length > 30) continue;
    if (!/(生成|generate|create|开始)/i.test(text)) continue;
    if (/(登录|sign in|sign up|upgrade|升级|购买|充值|设置|settings|下载|download)/i.test(text)) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const box = await el.boundingBox().catch(() => null);
    if (!box) continue;
    all.push({ el, text, area: box.width * box.height });
  }
  all.sort((a, b) => a.area - b.area);
  return all[0] || null;
}

// 记录页面上已有图片的地址与宽度，用于识别“新出现/变大”的结果
async function imageSnapshot(context) {
  const map = new Map();
  for (const p of context.pages()) {
    const imgs = await p.evaluate(() => Array.from(document.images)
      .map(i => {
        const r = i.getBoundingClientRect();
        return { src: i.currentSrc || i.src, w: i.naturalWidth, visW: Math.round(r.width), vis: r.width > 0 && r.height > 0 };
      })
      .filter(i => i.src && i.w >= 160 && i.vis))
      .catch(() => []);
    for (const it of imgs) {
      if (!map.has(it.src) || map.get(it.src) < it.w) map.set(it.src, it.w);
    }
  }
  return map;
}

// 结果只画在 canvas（如 3D 预览/WebGL）时，截取最大的可见画布
async function captureCanvasFallback(page) {
  const canvases = await page.$$('canvas');
  let best = null;
  for (const el of canvases) {
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 200 || box.height < 200) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    if (!best || box.width * box.height > best.area) best = { el, area: box.width * box.height };
  }
  if (!best) return null;
  const buf = await best.el.screenshot({ type: 'png' });
  return saveBuffer(buf, '.png');
}

async function waitForNewImage(context, before, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      const imgs = await p.evaluate(() => Array.from(document.images)
        .map(i => {
          const r = i.getBoundingClientRect();
          return { src: i.currentSrc || i.src, w: i.naturalWidth, visW: Math.round(r.width), vis: r.width > 0 && r.height > 0 };
        })
        .filter(i => i.src && i.w >= 160 && i.vis))
        .catch(() => []);
      const fresh = imgs
        .filter(it => isResultImage(it))
        .filter(it => !before.has(it.src) || it.w > before.get(it.src) + 20)
        .sort((a, b) => b.w - a.w);
      if (fresh.length) return { page: p, src: fresh[0].src };
    }
    await sleep(1000);
  }
  return null;
}

// ---------- 保存图片 ----------
function extFromType(ct, url) {
  if (ct && ct.includes('jpeg')) return '.jpg';
  if (ct && ct.includes('webp')) return '.webp';
  if (ct && ct.includes('gif')) return '.gif';
  if (ct && ct.includes('png')) return '.png';
  const m = /\.(png|jpe?g|webp|gif)(\?|$)/i.exec(url || '');
  return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '.png';
}

function saveBuffer(buffer, ext) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const name = `tripo_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${Math.floor(Math.random() * 1000)}${ext}`;
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, buffer);
  return file;
}

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const ct = m[1] || 'image/png';
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { buffer: buf, ext: extFromType(ct, '') };
}

async function saveImage(context, page, src) {
  if (src.startsWith('data:')) {
    const d = decodeDataUrl(src);
    if (!d) throw new Error('无法解析 data URL');
    return saveBuffer(d.buffer, d.ext);
  }
  if (src.startsWith('blob:')) {
    const dataUrl = await page.evaluate(async s => {
      const r = await fetch(s);
      const b = await r.blob();
      return await new Promise(res => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(b);
      });
    }, src);
    const d = decodeDataUrl(dataUrl);
    if (!d) throw new Error('blob 转 data URL 失败');
    return saveBuffer(d.buffer, d.ext);
  }
  // 优先用浏览器上下文下载，避免本机 IPv6/DNS 直连 CDN 超时
  try {
    const dataUrl = await page.evaluate(async s => {
      const r = await fetch(s, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = await r.blob();
      return await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(new Error('读取失败'));
        fr.readAsDataURL(b);
      });
    }, src);
    const d = decodeDataUrl(dataUrl);
    if (d) return saveBuffer(d.buffer, d.ext);
  } catch (e) {
    log('浏览器内下载失败，改用助手直连：' + e.message);
  }
  const resp = await context.request.get(src, { timeout: 30000 });
  if (!resp.ok()) throw new Error('下载失败 HTTP ' + resp.status());
  const body = await resp.body();
  return saveBuffer(body, extFromType(resp.headers()['content-type'], src));
}

// ---------- 页面结构打印 ----------
async function probe(page) {
  const info = await page.evaluate(() => {
    const vis = el => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const inputs = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'))
      .filter(vis)
      .map(el => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          placeholder: el.getAttribute('placeholder') || '',
          aria: el.getAttribute('aria-label') || '',
          size: Math.round(r.width) + 'x' + Math.round(r.height),
        };
      });
    const buttons = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(vis)
      .map(el => (el.innerText || '').trim().replace(/\s+/g, ' '))
      .filter(t => t && t.length <= 30);
    return { url: location.href, title: document.title, inputs, buttons: Array.from(new Set(buttons)).slice(0, 40) };
  });
  log('\n当前页面：' + info.title + '  ' + info.url);
  log('可输入框：' + (info.inputs.length ? '' : '未找到'));
  info.inputs.forEach((i, n) => log(`  [${n}] <${i.tag}> ${i.size}  placeholder="${i.placeholder}" aria="${i.aria}"`));
  log('可见按钮：' + (info.buttons.length ? info.buttons.map(b => '「' + b + '」').join(' ') : '未找到'));
  log('');
}

// ---------- 网络记录（用于定位生图页真实接口） ----------
const API_LOG = [];
const API_LOG_MAX = 40;
function pushApiLog(item) {
  API_LOG.push(item);
  if (API_LOG.length > API_LOG_MAX) API_LOG.shift();
}
function recordPage(page) {
  if (!page || page.__rec) return;
  page.__rec = true;
  const hostRe = /^https?:\/\/([^/]*\.)?(tripo3d|holymolly)\.(com|ai)\//i;
  page.on('request', req => {
    try {
      if (req.method() !== 'POST') return;
      const u = req.url();
      if (!hostRe.test(u)) return;
      let data = req.postData() || '';
      if (data.length > 6000) data = data.slice(0, 6000) + '…(截断)';
      pushApiLog({ t: Date.now(), dir: 'req', url: u, data });
    } catch {}
  });
  page.on('response', async res => {
    try {
      const u = res.url();
      if (!hostRe.test(u)) return;
      if (!/\/api\/|generate|task|image|prompt/i.test(u)) return;
      let text = '';
      try { text = await res.text(); } catch { return; }
      if (!text || text.length < 2) return;
      if (text.length > 4000) text = text.slice(0, 4000) + '…(截断)';
      pushApiLog({ t: Date.now(), dir: 'res', status: res.status(), url: u, data: text });
    } catch {}
  });
}

// 页面结构（JSON），供 /probe 与 CLI probe 使用
async function probeData(page) {
  return page.evaluate(() => {
    const vis = el => {
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
    };
    const inputs = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'))
      .filter(vis)
      .map(el => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          placeholder: el.getAttribute('placeholder') || '',
          aria: el.getAttribute('aria-label') || '',
          size: Math.round(r.width) + 'x' + Math.round(r.height),
          value: (el.value || el.innerText || '').slice(0, 80),
        };
      });
    const buttons = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],a,li,label'))
      .filter(vis)
      .map(el => (el.innerText || '').trim().replace(/\s+/g, ' '))
      .filter(t => t && t.length <= 24);
    const files = Array.from(document.querySelectorAll('input[type=file]')).filter(vis).map(el => ({
      accept: el.getAttribute('accept') || '',
      multiple: el.multiple,
      name: el.name || '',
      area: (el.closest('div') ? (el.closest('div').innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60) : ''),
    }));
    const imgs = Array.from(document.images).filter(vis).map(i => ({
      src: (i.currentSrc || i.src || '').slice(0, 160),
      w: i.naturalWidth,
      h: i.naturalHeight,
    })).slice(0, 30);
    // 候选配置项：文本 + 选中态 + 尺寸，用于定位「智能网格 / P2.0 / 自定义面数」这类控件
    const seen = new Set();
    const options = [];
    Array.from(document.querySelectorAll('button,[role=button],[role=tab],[role=radio],[role=option],[role=switch],label,li'))
      .filter(vis)
      .forEach(el => {
        const t = (el.innerText || '').trim().replace(/\s+/g, ' ');
        if (!t || t.length > 24) return;
        const cls = String(el.className || '');
        const state = el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || el.getAttribute('data-state') || '';
        const selected = state === 'true' || /active|selected|checked|\bon\b/i.test(cls);
        const r = el.getBoundingClientRect();
        const key = t + '|' + cls.slice(0, 30);
        if (seen.has(key)) return;
        seen.add(key);
        options.push({
          tag: el.tagName.toLowerCase(),
          cls: cls.slice(0, 70),
          text: t,
          selected,
          size: Math.round(r.width) + 'x' + Math.round(r.height),
        });
      });

    // 参考图区：已上传的 blob 预览图 + 它们附近的删除类控件（用于实现「先清空再上传」）
    const refs = (() => {
      const blobImgs = Array.from(document.querySelectorAll('img'))
        .filter(i => /^blob:/.test(i.src || '') && i.naturalWidth > 0);
      const out = blobImgs.map(i => {
        const b = i.getBoundingClientRect();
        const ctrls = [];
        let node = i.parentElement;
        for (let d = 0; d < 5 && node && node !== document.body; d++, node = node.parentElement) {
          Array.from(node.querySelectorAll('button,[role=button],svg,span,div,i')).forEach(el => {
            const bb = el.getBoundingClientRect();
            if (!(bb.width > 0 && bb.height > 0)) return;
            // 只看缩略图附近（左右各放宽 48px）的控件
            if (bb.x + bb.width < b.x - 48 || bb.x > b.x + b.width + 48) return;
            const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || ''));
            const t = (el.innerText || '').trim();
            const aria = (el.getAttribute('aria-label') || '') + '|' + (el.getAttribute('title') || '');
            if (/delete|remove|clear|close|trash/i.test(cls) || /delete|remove|clear|close/i.test(aria) || t === '×' || t === '✕') {
              ctrls.push({
                tag: el.tagName.toLowerCase(), cls: cls.slice(0, 70),
                aria: (el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 30),
                txt: t.slice(0, 10),
                x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.width), h: Math.round(bb.height),
              });
            }
          });
        }
        return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), ctrls: ctrls.slice(0, 8) };
      });
      return out;
    })();

    return {
      url: location.href, title: document.title, inputs,
      buttons: Array.from(new Set(buttons)).slice(0, 60),
      files, imgs, options: options.slice(0, 120), refs,
    };
  });
}

// ---------- 单次生成 ----------
const ASSET_IMG_RE = /tripo-webapp-assets|\/assets\/|\/static\/|\/images\/workspace\/|light\.webp|logo|icon|avatar|placeholder|sprite|loading|spinner|favicon/i;

function isResultImage(it) {
  if (!it || !it.src) return false;
  if (it.src.startsWith('data:')) return it.w >= 256;
  if (ASSET_IMG_RE.test(it.src)) return false;
  return it.w >= 256 && it.visW >= 120;
}

// 识别页面上的模式切换（文生图 / 图生图）
async function clickModeTab(page, kind) {
  if (!kind || kind === 'auto') return false;
  const re = kind === 'image'
    ? /^(图生图|图片生图|参考图生图|image\s*to\s*image)$/i
    : /^(文生图|文字生图|文本生图|text\s*to\s*image)$/i;
  // 只点真正的 tab 控件，避免误点模板卡片
  const els = await page.$$('[role="tab"],button[aria-selected],[class*="tab-btn"],[class*="tab-item"],[class*="segmented"] button');
  for (const el of els) {
    const text = ((await el.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
    if (!text || text.length > 12 || !re.test(text)) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 24 || box.height < 16) continue;
    await el.click({ timeout: 3000 }).catch(() => {});
    await sleep(700);
    return true;
  }
  return false;
}

async function runOnce(context, page, prompt, opts = {}) {
  const waitSec = Math.max(10, Math.min(900, Number(opts.timeoutSec) || TIMEOUT_SEC));
  // 只有显式指定模式时才切 tab；Tripo 当前是统一的「生成图片」面板，自动模式不点任何按钮
  const mode = opts.mode === 'text' || opts.mode === 'image' ? opts.mode : '';
  // 参考图：支持多张（最多 3 张）
  const refList = (Array.isArray(opts.images) ? opts.images : (opts.image ? [opts.image] : [])).filter(Boolean);

  // ① 上传区是「追加」式的：不清空的话，新图会叠在上一轮的旧图上，模型会拿到一堆残留参考图
  await dismissOnboarding(page);
  if (refList.length) {
    const cl = await clearReferences(page);
    if (!cl.ok) {
      log('参考图未能清空，重新加载页面以保证干净状态…');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(e => log('页面重载失败：' + e.message));
      await sleep(4500);
    }
  }

  // ② 切模式（重载后需要重新切一次）
  if (mode) {
    const switched = await clickModeTab(page, mode);
    log(switched
      ? `已切换到${mode === 'image' ? '图生图' : '文生图'}模式`
      : `未找到${mode === 'image' ? '图生图' : '文生图'}切换入口，沿用当前面板`);
  }

  // ③ 上传参考图
  if (refList.length) {
    const files = [];
    for (const src of refList) {
      try { files.push(await resolveImageFile(src)); }
      catch (e) { return { ok: false, message: '参考图处理失败：' + e.message }; }
    }
    let attached = await attachReferences(page, files);
    if (!attached.ok) {
      // 写入不完整：清掉残留再试一次（上传区是追加式的，不清会叠图）
      log('参考图写入不完整，清空后重试一次…');
      const cl = await clearReferences(page);
      if (!cl.ok) {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
          .catch(e => log('页面重载失败：' + e.message));
        await sleep(4500);
        if (mode) await clickModeTab(page, mode);
      }
      attached = await attachReferences(page, files);
    }
    if (!attached.ok) {
      const dbg = await probeData(page).catch(() => null);
      const hint = dbg && dbg.files.length
        ? '（页面文件输入：' + dbg.files.map(f => f.accept || f.name || '无 accept').join(' / ') + '）'
        : '（页面上没有可见的文件输入）';
      return { ok: false, message: '参考图没有成功上传' + hint };
    }
    // ④ 就绪闸门：等页面把参考图全部处理完（缩略图真正加载出来、没有上传中状态）才继续。
    //    这里原来是「写完固定等 1.8 秒」，上传稍慢就会带着不完整的参考图点生成。
    const ready = await waitRefsReady(page, refList.length, {
      timeoutMs: Math.max(15000, Math.min(60000, waitSec * 500))
    });
    if (!ready.ok) {
      return {
        ok: false,
        message: `参考图尚未处理完成（已就绪 ${ready.loaded}/${refList.length}，等待 ${Math.round(ready.waited / 1000)} 秒），已中止生成；可调大超时后重试`
      };
    }
    log(ready.verified
      ? `参考图已全部就绪（${ready.loaded}/${refList.length}，${Math.round(ready.waited / 1000)}s）`
      : `参考图写入完成（页面未提供可识别的缩略图，已静默等待 ${Math.round(ready.waited / 1000)}s）`);
  }

  if (opts.ratio && opts.ratio !== 'auto') {
    const ok = await selectRatio(page, opts.ratio);
    log(ok
      ? `已选择比例 ${opts.ratio}`
      : `未找到比例 ${opts.ratio} 的选项（该面板可能不提供比例，或选项文案不同），保持页面默认；按「probe」可查看页面结构`);
  }

  const input = await findPromptInput(page);
  if (!input) {
    const message = '未找到提示词输入框，请确认已在浏览器里进入生图页面';
    log(message + '。输入 probe 查看页面结构。');
    return { ok: false, message };
  }
  await input.el.click();
  await page.keyboard.press('Control+A');
  if (input.tag === 'textarea') {
    await input.el.fill(prompt).catch(async () => {
      await page.keyboard.insertText(prompt);
    });
  } else {
    await page.keyboard.insertText(prompt);
  }
  await sleep(300);

  // 回读确认提示词真的写进了当前面板，避免填到别的输入框后生成无关内容
  const readBack = (await input.el.evaluate(el => (el.value || el.innerText || '').trim()).catch(() => '')) || '';
  const head = prompt.slice(0, Math.min(16, prompt.length));
  if (!readBack || !readBack.includes(head)) {
    const dbg = await probeData(page).catch(() => null);
    const hint = dbg ? '；可见输入框：' + (dbg.inputs.map(i => i.placeholder || i.tag).join(' / ') || '无') : '';
    return { ok: false, message: '提示词没有写入正确的输入框（当前内容：' + (readBack.slice(0, 30) || '空') + '）' + hint };
  }

  const before = await imageSnapshot(context);
  const btn = await findGenerateButton(page, input.el);
  if (!btn) {
    const dbg = await probeData(page).catch(() => null);
    const hint = dbg ? '；可见按钮：' + (dbg.buttons.join(' / ') || '无') : '';
    const message = '未找到「生成」按钮' + hint;
    log(message);
    return { ok: false, message };
  }
  log(`已填入提示词，点击按钮「${btn.text}」，等待结果…`);
  await btn.el.click({ timeout: 10000 }).catch(async () => {
    await btn.el.click({ force: true, timeout: 5000 });
  });

  const found = await waitForNewImage(context, before, waitSec);
  if (!found) {
    const shot = await captureCanvasFallback(page).catch(() => null);
    if (shot) {
      log(`未发现新图片，已截取画布：${shot}`);
      return { ok: false, canvas: true, file: shot, message: '未取到图片，已截取画布' };
    }
    const message = `等待 ${waitSec} 秒仍未发现新图片`;
    log(message + '。可调大 --timeout，或输入 probe 检查页面。');
    return { ok: false, message };
  }
  const file = await saveImage(context, found.page, found.src);
  const size = fs.statSync(file).size;
  log(`已保存：${file}（${(size / 1024).toFixed(0)} KB）`);
  if (size < 10 * 1024) log('提示：文件较小，可能不是最终结果，请打开确认。');
  return { ok: true, file };
}

/* ---------- 生成 3D 模型（图片 → 3D） ---------- */
const MODEL_PAGE_RE = /\/workspace\/generate/i;

async function ensureModelPage(page) {
  if (MODEL_PAGE_RE.test(page.url() || '')) return page.url();
  try {
    const origin = new URL(page.url()).origin;
    await page.goto(origin + '/zh/workspace/generate', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
  } catch (e) {
    log('打开生成页提示：' + e.message);
  }
  return page.url();
}

// 生模型页与生图页不同：靠「图片上传控件 + 生成按钮 + 智能网格/高精度模型」判定
async function computeModelReady(page) {
  try {
    const r = await page.evaluate(() => {
      const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
      const files = Array.from(document.querySelectorAll('input[type=file]'));
      const imgUpload = files.some(i => /image\//i.test(i.getAttribute('accept') || '') && vis(i));
      const genBtn = Array.from(document.querySelectorAll('button,[role=button]'))
        .some(b => /^生成/.test(((b.innerText) || '').trim()) && vis(b));
      const txt = document.body.innerText || '';
      return {
        imgUpload, genBtn,
        modeText: /智能网格|高精度模型|自定义面数/.test(txt),
        url: location.href,
      };
    });
    return { ready: MODEL_PAGE_RE.test(r.url) && r.imgUpload && (r.genBtn || r.modeText), imgUpload: r.imgUpload, genBtn: r.genBtn, url: r.url };
  } catch (e) {
    return { ready: false, message: e.message, url: page.url() };
  }
}

// 通用：按文本点击一个配置控件，返回命中的文本（找不到返回空串）
async function clickTextEl(page, patterns, opts = {}) {
  const sels = '[role="tab"],[role="radio"],[role="option"],[role="switch"],[role="button"],button,label,li,'
    + '[class*="tab-btn"],[class*="tab-item"],[class*="segmented"] button,[class*="option"],[class*="radio"],[class*="chip"],[class*="select"]';
  const maxLen = opts.maxLen || 24;
  const els = await page.$$(sels);
  for (const el of els) {
    const text = ((await el.innerText().catch(() => '')) || '').trim().replace(/\s+/g, ' ');
    if (!text || text.length > maxLen) continue;
    if (!patterns.some(p => new RegExp(p, 'i').test(text))) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    const box = await el.boundingBox().catch(() => null);
    if (!box || box.width < 22 || box.height < 14) continue;
    await el.click({ timeout: 3000 }).catch(async () => {
      await el.click({ force: true, timeout: 3000 }).catch(() => {});
    });
    await sleep(opts.wait || 700);
    return text;
  }
  return '';
}

async function pickModelMode(page, mode) {
  const pats = mode === 'smart' ? ['^智能网格'] : mode === 'hd' ? ['^高精度模型'] : null;
  if (!pats) return '';
  const hit = await clickTextEl(page, pats, { maxLen: 12 });
  log(hit ? `已选择模式：${hit}` : '未找到模式选项，沿用页面当前设置');
  return hit;
}

async function pickMeshVersion(page, ver) {
  if (!ver) return '';
  // 页面上的版本选项可能带后缀（如「P1.0 - 快速版」），用前缀匹配
  const hit = await clickTextEl(page, ['^' + String(ver).replace(/\./g, '\\.')], { maxLen: 20 });
  log(hit ? `已选择网格版本：${hit}` : `未找到版本选项 ${ver}，沿用页面当前设置`);
  return hit;
}

/* ---- 拓扑面板：四边面 / 三角面 + 面数控制（滑杆 500–25000 + 数值框） ---- */
// 打开「通用设置 → 拓扑」面板
async function openTopologyPanel(page) {
  const hit = await clickTextEl(page, ['^拓扑$'], { maxLen: 8 });
  if (!hit) { log('未找到「拓扑」设置入口（可能当前模式不支持），沿用页面默认拓扑'); return ''; }
  await sleep(1000);
  return hit;
}

// 面板里选 四边面(quad) / 三角面(tri)
async function pickTopologyType(page, type) {
  const label = type === 'quad' ? '四边面' : type === 'tri' ? '三角面' : '';
  if (!label) return '';
  const hit = await clickTextEl(page, ['^' + label], { maxLen: 8 });
  log(hit ? `已选择拓扑：${hit}` : `未找到拓扑选项「${label}」，沿用页面当前设置`);
  return hit;
}

// 面数：拓扑面板里的数值框（type=text，紧邻滑杆）。找不到锚点时用第一个可见数值框
async function setFaceCount(page, n) {
  n = Math.trunc(Number(n) || 0);
  if (n <= 0) return false;
  n = Math.max(500, Math.min(25000, n)); // 页面滑杆范围 500–25000
  const idx = await page.evaluate(() => {
    const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    // 锚点：拓扑面板里带「面数」文本的容器
    let anchor = null;
    for (const el of document.querySelectorAll('div,section,li,label')) {
      const t = ((el.innerText) || '').trim().replace(/\s+/g, ' ');
      if (/面数/.test(t) && t.length < 30 && vis(el)) { anchor = el.getBoundingClientRect(); break; }
    }
    // 注意：不过滤列表，保证索引与 Node 侧 page.$$ 一一对应
    const inputs = Array.from(document.querySelectorAll('input[type=text], input[type=number], input[inputmode="numeric"], input[inputmode="decimal"]'));
    let best = -1, bestD = Infinity;
    inputs.forEach((el, i) => {
      if (!vis(el)) return;
      const b = el.getBoundingClientRect();
      if (anchor) {
        const d = Math.hypot((b.x + b.width / 2) - (anchor.x + anchor.width / 2), (b.y + b.height / 2) - (anchor.y + anchor.height / 2));
        if (d < bestD) { bestD = d; best = i; }
      } else if (best < 0) {
        best = i; // 没有锚点就取第一个可见数值框
      }
    });
    return best;
  });
  if (idx < 0) { log('拓扑面板里没有找到面数输入框'); return false; }
  const inputs = await page.$$('input[type=text], input[type=number], input[inputmode="numeric"], input[inputmode="decimal"]');
  const target = inputs[idx];
  if (!target) { log('面数输入框定位失败'); return false; }
  // React 受控输入：用原生 setter 赋值再抛 input/change，确保 onChange 收到
  const got = await page.evaluate((i, val) => {
    const els = Array.from(document.querySelectorAll('input[type=text], input[type=number], input[inputmode="numeric"], input[inputmode="decimal"]'));
    const el = els[i];
    if (!el) return '';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return el.value;
  }, idx, n);
  await sleep(400);
  const ok = String(got) === String(n);
  log(ok ? `已设置面数：${n}` : `面数设置可能未生效（期望 ${n}，读到 ${got || '空'}）`);
  return ok;
}

// 关闭拓扑面板（优先点 ×，兜底 Esc）
async function closeTopologyPanel(page) {
  const hit = await page.evaluate(() => {
    const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    for (const el of document.querySelectorAll('button,[role=button]')) {
      const al = (el.getAttribute('aria-label') || '').toLowerCase();
      const t = ((el.innerText) || '').trim();
      if (vis(el) && (al === 'close' || al === '关闭' || t === '×' || t === '✕' || t === 'X')) { el.click(); return al || t; }
    }
    return '';
  });
  if (!hit) await page.keyboard.press('Escape').catch(() => {});
  await sleep(600);
  return hit || 'Esc';
}

/* ---- 多视图上传模式（前 / 左 / 右 / 后 四个槽位） ---- */
const IMAGE_INPUT_SEL = 'input[type=file]';

// 当前页面可见的图片上传控件数量：1 = 单图模式，4 = 多视图模式
async function countImageInputs(page) {
  return page.evaluate(() => {
    const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    return Array.from(document.querySelectorAll('input[type=file]')).filter(el => {
      if (!vis(el)) return false;
      const accept = (el.getAttribute('accept') || '').toLowerCase();
      return /image|png|jpe?g|webp/.test(accept) && !/glb|fbx|obj|stl|model|video|mp4/.test(accept);
    }).length;
  });
}

// 切换单图 / 多视图上传模式（on=true 多视图）。页面图标类名含 multi-view
async function setMultiViewMode(page, on) {
  const n = await countImageInputs(page);
  if ((on && n >= 4) || (!on && n <= 1)) return n; // 已是目标态
  const hit = await page.evaluate(() => {
    const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const els = Array.from(document.querySelectorAll('[class*="multi-view" i], [class*="multiView" i]'));
    for (const el of els) {
      if (!vis(el)) continue;
      const clickable = el.closest('button,[role=button],label') || el;
      clickable.click();
      return String(el.className).slice(0, 60);
    }
    return '';
  });
  if (hit) { await sleep(1500); return await countImageInputs(page); }
  return n;
}

// 多视图上传：views = { front, left, right, back }，值为图片 dataURL / http / 本地路径
// 槽位与视图固定对应：front→第1格、left→第2格、right→第3格、back→第4格；未提供的视图跳过不错位
async function attachMultiView(page, views) {
  await setMultiViewMode(page, true);
  const order = ['front', 'left', 'right', 'back'];
  const names = { front: '前', left: '左', right: '右', back: '后' };
  // 一次性取齐 4 个可见图片上传控件（DOM 顺序 = 前/左/右/后）。
  // 注意：某槽位上传成功后页面会隐藏/替换该输入框，若逐个现查+可见性过滤会错位
  // （左图传到右槽、后续槽位找不到控件），因此必须在上传前固定句柄。
  const handles = await page.$$(IMAGE_INPUT_SEL);
  const slots = [];
  for (const h of handles) {
    const ok = await h.evaluate(el => {
      const b = el.getBoundingClientRect();
      if (!(b.width > 0 && b.height > 0)) return false;
      const accept = (el.getAttribute('accept') || '').toLowerCase();
      return /image|png|jpe?g|webp/.test(accept) && !/glb|fbx|obj|stl|model|video|mp4/.test(accept);
    }).catch(() => false);
    if (ok) slots.push(h);
  }
  if (slots.length < 4) log(`多视图槽位不足 4 个（当前 ${slots.length}），按可用槽位上传`);
  let uploaded = 0;
  let readySeen = (await refsSnapshot(page)).loaded;
  for (let slot = 0; slot < order.length; slot++) {
    const key = order[slot];
    const src = views && views[key];
    if (!src) continue; // 未提供的视图跳过，不错位
    let file = null;
    try { file = await resolveImageFile(src); }
    catch (e) { log(`${names[key]}视图参考图处理失败：${e.message}`); continue; }
    const target = slots[slot];
    if (!target) { log(`未找到${names[key]}视图上传控件（槽位 ${slot + 1}）`); continue; }
    try {
      await target.setInputFiles(file, { timeout: 8000 });
      uploaded++;
      // 写完控件 ≠ 页面处理完：等这一张的缩略图真正渲染出来再传下一张，
      // 也避免全部写完后立刻点生成时页面还在解析（参考图竞态，同 runOnce 就绪闸门）
      const grew = await waitThumbGrow(page, readySeen, { timeoutMs: 12000 });
      if (grew.ok) {
        readySeen = grew.loaded;
        log(`${names[key]}视图已上传并就绪（槽位 ${slot + 1}）`);
      } else {
        log(`${names[key]}视图已写入上传控件（未检测到缩略图，继续执行）`);
      }
    } catch (e) {
      log(`${names[key]}视图上传失败：${e.message}`);
    }
  }
  return uploaded;
}

async function pickGenerateCount(page, n) {
  if (!n) return '';
  const hit = await clickTextEl(page, ['^' + n + '$'], { maxLen: 4 });
  log(hit ? `已选择生成数量：${hit}` : `未找到数量选项 ${n}，沿用页面默认`);
  return hit;
}

async function clickGenerateModel(page) {
  const hit = await clickTextEl(page, ['^生成'], { maxLen: 16, wait: 400 });
  log(hit ? `已点击「${hit}」，等待模型生成…` : '未找到「生成」按钮');
  return hit;
}

// 生成完成后页面出现下载入口：点它，必要时先选导出格式，再捕获下载
async function grabModelDownload(context, page, timeoutSec, format) {
  const deadline = Date.now() + Math.max(30, Number(timeoutSec) || 420) * 1000;
  const got = [];
  const onDl = d => got.push(d);
  context.on('download', onDl);
  try {
    while (Date.now() < deadline) {
      const hit = await clickTextEl(page, ['^下载', '下载', '^导出', '^Download', '^Export'], { maxLen: 16, wait: 400 });
      if (hit) {
        if (format) await clickTextEl(page, ['^' + format + '$', '\\b' + format + '\\b'], { maxLen: 12, wait: 600 });
        const t0 = Date.now();
        while (Date.now() - t0 < 25000 && !got.length) await sleep(500);
        if (got.length) return got[0];
        log(`已点击「${hit}」但未捕获到下载，继续等待…`);
      }
      await sleep(2500);
    }
  } finally {
    context.off('download', onDl);
  }
  return null;
}

async function saveModelDownload(download) {
  const suggested = download.suggestedFilename() || '';
  const ext = (path.extname(suggested) || '.glb').toLowerCase();
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const out = path.join(OUT_DIR, 'model_' + stamp + ext);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await download.saveAs(out);
  return out;
}

async function runModelOnce(context, page, opts = {}) {
  const waitSec = Math.max(30, Math.min(1800, Number(opts.timeoutSec) || 420));
  const multi = !!opts.multi;
  await ensureModelPage(page);
  const ready = await computeModelReady(page);
  if (!ready.ready) {
    return {
      ok: false,
      message: '浏览器里没有进入「图片生成 3D」页面（当前：' + (ready.url || '未知')
        + '）。请在设置里点「打开登录页」，登录后进入生成页。',
    };
  }

  // 上传区是追加式的：先清掉上一轮残留的参考图，否则新旧图会叠在一起
  await dismissOnboarding(page);
  if (multi || opts.image) {
    const cl = await clearReferences(page);
    if (!cl.ok) {
      log('参考图未能清空，重新加载页面以保证干净状态…');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(e => log('页面重载失败：' + e.message));
      await sleep(4500);
      await ensureModelPage(page);
    }
  }

  if (multi) {
    const uploaded = await attachMultiView(page, opts.views || {});
    if (!uploaded) return { ok: false, message: '多视图参考图没有成功上传；至少需要一张（前 / 左 / 右 / 后）' };
  } else if (opts.image) {
    let file = null;
    try { file = await resolveImageFile(opts.image); }
    catch (e) { return { ok: false, message: '参考图处理失败：' + e.message }; }
    const uploaded = await attachReference(page, file);
    if (!uploaded) return { ok: false, message: '参考图没有成功上传；网页生成模型需要至少一张参考图' };
  }
  // 就绪闸门：写入控件 ≠ 页面处理完，等参考图全部就绪再点生成（同 runOnce）。
  // 这里原来是「写完固定等 1.5 秒」，逐槽上传 + 页面解析稍慢就会带着漏图的参考图生成
  if (multi || opts.image) {
    const views = opts.views || {};
    const expect = multi
      ? Math.max(1, ['front', 'left', 'right', 'back'].filter(k => views[k]).length)
      : 1;
    const ready = await waitRefsReady(page, expect, {
      timeoutMs: Math.max(15000, Math.min(60000, waitSec * 500))
    });
    if (!ready.ok) {
      return {
        ok: false,
        message: `参考图尚未处理完成（已就绪 ${ready.loaded}/${expect}，等待 ${Math.round(ready.waited / 1000)} 秒），已中止生成；可调大超时后重试`
      };
    }
    log(ready.verified
      ? `参考图已全部就绪（${ready.loaded}/${expect}，${Math.round(ready.waited / 1000)}s）`
      : `参考图写入完成（页面未提供可识别的缩略图，已静默等待 ${Math.round(ready.waited / 1000)}s）`);
  }

  await pickModelMode(page, opts.mode);
  await pickMeshVersion(page, opts.version);
  // 拓扑 / 面数：打开「通用设置 → 拓扑」面板设置（当前模式不支持时自动跳过）
  if (opts.topology || (Number(opts.faceCount) || 0) > 0) {
    const opened = await openTopologyPanel(page);
    if (opened) {
      await pickTopologyType(page, opts.topology);
      await setFaceCount(page, Number(opts.faceCount) || 0);
      await closeTopologyPanel(page);
    }
  }
  await pickGenerateCount(page, Number(opts.count) || 0);

  const clicked = await clickGenerateModel(page);
  if (!clicked) return { ok: false, message: '未找到「生成」按钮，请先确认已进入生成页（可用 probe 查看页面结构）' };

  const dl = await grabModelDownload(context, page, waitSec, String(opts.format || '').toLowerCase());
  if (!dl) return { ok: false, message: `等待 ${waitSec} 秒仍未拿到模型文件：可能仍在生成，或结果页没有出现下载入口` };
  const file = await saveModelDownload(dl);
  const size = fs.statSync(file).size;
  log(`已保存模型：${file}（${(size / 1024).toFixed(0)} KB）`);
  return { ok: true, file, size };
}

// ---------- 命令行主流程 ----------
async function mainCli() {
  let context, page;
  try {
    ({ context, page } = await launch());
  } catch (e) {
    log('启动 Edge 失败：' + e.message);
    log('请确认已安装 Microsoft Edge，并在项目目录执行：npm.cmd install playwright-core --no-save');
    process.exit(1);
  }

  if (SELFTEST) {
    log('自检：页面标题 = ' + (await page.title().catch(() => '(读取失败)')));
    log('自检完成，Edge 启动与页面访问正常。');
    await context.close();
    return;
  }

  log('');
  log('==============================================');
  log(' Tripo 网页自动化助手（有头浏览器）');
  log('==============================================');
  log('窗口已打开：' + TARGET_URL);
  log('备用入口：' + ALT_URL);
  log('1) 在窗口里手动登录并进入生图页面');
  log('2) 回到本终端按回车');
  log('');
  log('⚠ 该方式属于网页自动化，Tripo 条款禁止自动化访问；');
  log('  可能触发风控、限制账号或清零积分且不退款。');
  log('  脚本不做任何反检测伪装，请自行承担风险。');
  log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));

  await ask('登录并进入生图页面后，按回车继续 > ');

  while (true) {
    let prompt;
    try {
      prompt = (await ask('提示词（exit 退出 / probe 查看页面）> ')).trim();
    } catch {
      break;
    }
    if (!prompt) continue;
    if (prompt === 'exit' || prompt === 'quit') break;
    if (prompt === 'probe') { await probe(page); continue; }
    try {
      const r = await runOnce(context, page, prompt);
      if (r.ok && COOLDOWN_SEC > 0) {
        log(`冷却 ${COOLDOWN_SEC} 秒后继续…`);
        await sleep(COOLDOWN_SEC * 1000);
      }
    } catch (e) {
      log('本次失败：' + e.message);
    }
  }

  rl.close();
  await context.close();
  log('已退出。登录状态保存在 .tripo-profile，下次无需重新登录。');
}

// ---------- 本地服务模式（供 index.html 调用） ----------
let srvCtx = null;
let srvPage = null;
let srvBusy = false;
let readyCache = { at: 0, ready: false, url: '', title: '' };

async function ensureBrowser() {
  if (srvCtx) {
    const pages = srvCtx.pages().filter(p => !p.isClosed());
    if (pages.length) {
      if (!srvPage || srvPage.isClosed() || !pages.includes(srvPage)) srvPage = pages[0];
      return { context: srvCtx, page: srvPage };
    }
  }
  const { context, page } = await launch();
  srvCtx = context;
  srvPage = page;
  context.on('close', () => {
    if (srvCtx === context) { srvCtx = null; srvPage = null; }
  });
  return { context, page };
}

async function computeReady(page) {
  const now = Date.now();
  if (readyCache.at && now - readyCache.at < 4000) return readyCache;
  let ready = false, title = '', url = '', blocked = '';
  try {
    title = await page.title();
    url = page.url();
    // Cloudflare 人机验证页：标题是「请稍候…」，页面文案含「验证您是否是真人」
    if (/请稍候|just a moment|attention required/i.test(title || '')) {
      blocked = 'cloudflare';
    } else {
      const body = await page.evaluate(() => (document.body ? document.body.innerText : '').slice(0, 400)).catch(() => '');
      if (/验证您是否是真人|正在验证您是否是真人|checking your browser/i.test(body || '')) blocked = 'cloudflare';
    }
    ready = !blocked && !!(await findPromptInput(page)) && !!(await findGenerateButton(page));
  } catch {}
  readyCache = { at: now, ready, url, title, blocked };
  return readyCache;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function serveOut(res, name) {
  const file = path.join(OUT_DIR, path.basename(decodeURIComponent(name)));
  if (!file.startsWith(OUT_DIR + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

async function startServer() {
  cleanTmp();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    try {
      if (u.pathname === '/ping') { sendJson(res, 200, { ok: true, service: 'tripo-bridge' }); return; }

      if (u.pathname === '/status') {
        if (!srvCtx) { sendJson(res, 200, { ok: true, running: false, ready: false }); return; }
        const page = srvPage && !srvPage.isClosed() ? srvPage : srvCtx.pages()[0];
        if (!page) { sendJson(res, 200, { ok: true, running: false, ready: false }); return; }
        const r = await computeReady(page);
        const m = await computeModelReady(page).catch(() => ({ ready: false }));
        sendJson(res, 200, {
          ok: true, running: true, ready: r.ready, modelReady: !!m.ready,
          url: r.url, title: r.title,
        });
        return;
      }

      if (u.pathname === '/probe') {
        if (!srvCtx) { sendJson(res, 409, { ok: false, message: '浏览器未启动，请先点「打开登录页」' }); return; }
        const { page } = await ensureBrowser();
        const data = await probeData(page);
        sendJson(res, 200, { ok: true, data });
        return;
      }

      if (u.pathname === '/api-log') {
        sendJson(res, 200, { ok: true, count: API_LOG.length, log: API_LOG });
        return;
      }

      if (u.pathname === '/login' && req.method === 'POST') {
        const body = await readJson(req).catch(() => ({}));
        const target = String(body.url || '');
        if (target && !/^https:\/\/studio\.tripo3d\.(com|ai)\//i.test(target)) {
          sendJson(res, 400, { ok: false, message: '只允许打开 studio.tripo3d.com 或 studio.tripo3d.ai' });
          return;
        }
        const { page } = await ensureBrowser();
        if (target && page.url() !== target) {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
            .catch(e => log('打开登录页提示：' + e.message));
        }
        await page.bringToFront().catch(() => {});
        sendJson(res, 200, { ok: true, message: '浏览器已打开，请手动登录并进入生图页面' });
        return;
      }

      if (u.pathname === '/generate' && req.method === 'POST') {
        const body = await readJson(req, 25 * 1024 * 1024);
        const prompt = String(body.prompt || '').trim();
        // 参考图：兼容旧的单张 image 字段，也接受最多 3 张的 images 数组
        const rawImages = Array.isArray(body.images) ? body.images : (body.image ? [body.image] : []);
        const images = rawImages.map(s => String(s || '')).filter(Boolean).slice(0, 3);
        const ratio = String(body.ratio || '');
        const mode = String(body.mode || '');
        const timeoutSec = Math.max(10, Math.min(900, Number(body.timeoutSec) || TIMEOUT_SEC));
        if (!prompt) { sendJson(res, 400, { ok: false, message: '缺少提示词' }); return; }
        if (srvBusy) { sendJson(res, 429, { ok: false, message: '上一张仍在生成，请稍候' }); return; }
        if (!srvCtx) {
          sendJson(res, 409, { ok: false, message: '请先在设置里点「打开登录页」，登录并进入生图页面' });
          return;
        }
        const { context, page } = await ensureBrowser();
        const ready = await computeReady(page);
        if (!ready.ready) {
          sendJson(res, 409, { ok: false, message: '浏览器里尚未进入生图页面，请先登录并打开生图页' });
          return;
        }
        srvBusy = true;
        try {
          const r = await runOnce(context, page, prompt, { images, ratio, mode, timeoutSec });
          if (!r.file) { sendJson(res, 500, { ok: false, message: r.message || '生成失败' }); return; }
          sendJson(res, 200, {
            ok: !!r.ok,
            canvas: !!r.canvas,
            message: r.message || '',
            file: r.file,
            url: `http://127.0.0.1:${PORT}/out/${encodeURIComponent(path.basename(r.file))}`,
          });
        } finally {
          srvBusy = false;
        }
        return;
      }

      if (u.pathname === '/generate-model' && req.method === 'POST') {
        const body = await readJson(req, 25 * 1024 * 1024);
        const views = body.views && typeof body.views === 'object' ? body.views : null;
        const opts = {
          image: String(body.image || ''),
          multi: !!body.multi,
          views: views ? {
            front: String(views.front || ''),
            left: String(views.left || ''),
            right: String(views.right || ''),
            back: String(views.back || '')
          } : null,
          mode: String(body.mode || ''),
          version: String(body.version || ''),
          topology: String(body.topology || ''),
          faceCount: Number(body.faceCount) || 0,
          count: Number(body.count) || 0,
          format: String(body.format || ''),
          timeoutSec: Math.max(30, Math.min(1800, Number(body.timeoutSec) || 420)),
        };
        if (!image) { sendJson(res, 400, { ok: false, message: '缺少参考图' }); return; }
        if (srvBusy) { sendJson(res, 429, { ok: false, message: '上一次生成仍在进行，请稍候' }); return; }
        if (!srvCtx) { sendJson(res, 409, { ok: false, message: '请先在设置里点「打开登录页」，登录并进入生成页' }); return; }
        const { context, page } = await ensureBrowser();
        srvBusy = true;
        try {
          const r = await runModelOnce(context, page, opts);
          if (!r.file) { sendJson(res, 500, { ok: false, message: r.message || '生成失败' }); return; }
          sendJson(res, 200, {
            ok: true,
            file: r.file,
            size: r.size || 0,
            url: `http://127.0.0.1:${PORT}/out/${encodeURIComponent(path.basename(r.file))}`,
          });
        } finally {
          srvBusy = false;
        }
        return;
      }

      if (u.pathname.startsWith('/out/')) { serveOut(res, u.pathname.slice(5)); return; }
      sendJson(res, 404, { ok: false, message: '接口不存在' });
    } catch (e) {
      sendJson(res, 500, { ok: false, message: e.message });
    }
  });

  server.requestTimeout = 0;
  server.listen(PORT, '127.0.0.1', () => {
    log(`Tripo 助手已启动：http://127.0.0.1:${PORT}`);
    log('在 index.html → 设置 → 图像生成中选择「Tripo 网页账号」，点击「打开登录页」。');
    log('该方式属于网页自动化，可能触发风控；按 Ctrl+C 停止服务。');
  });
}

// 导出核心函数供单测使用（plugins/tripo/tests/ 下以 mock 页面验证多文件写入等逻辑）
module.exports = {
  attachReference, attachReferences, visibleImageSrcs, resolveImageFile,
  clickTextEl, selectRatio, ratioTokens, normRatio, findPromptInput, findGenerateButton,
  openTopologyPanel, pickTopologyType, setFaceCount, closeTopologyPanel,
  countImageInputs, setMultiViewMode, attachMultiView, pickGenerateCount,
  clearReferences,
  refsSnapshot, waitRefsReady, waitThumbGrow, runOnce, runModelOnce,
};

if (require.main === module) {
  if (SERVE) {
    startServer().catch(e => {
      console.error('启动服务失败：' + e.stack);
      process.exit(1);
    });
  } else {
    mainCli().catch(e => {
      console.error('运行出错：' + e.stack);
      process.exit(1);
    });
  }
}
