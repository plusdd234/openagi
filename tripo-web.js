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
const { chromium } = require('playwright-core');

const DEFAULT_URL = 'https://studio.tripo3d.com/';
const ALT_URL = 'https://studio.tripo3d.ai/';
const PROFILE_DIR = path.join(__dirname, '.tripo-profile');
const OUT_DIR = path.join(__dirname, 'tripo_out');
const TMP_DIR = path.join(__dirname, 'tripo_tmp');

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
const PORT = Number(argValue('port', '8790')) || 8790;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---------- 启动浏览器 ----------
async function launch() {
  const args = [];
  if (!SELFTEST) args.push('--start-maximized');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'msedge',
    headless: SELFTEST,
    viewport: null,
    acceptDownloads: true,
    args,
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

async function attachReference(page, file) {
  const beforeSrcs = await visibleImageSrcs(page);
  const previewAppeared = async () => {
    await sleep(1200);
    const after = await visibleImageSrcs(page);
    return after.some(s => !beforeSrcs.includes(s));
  };

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
      log(seen ? '参考图已上传并出现预览' : '参考图已写入上传控件（未检测到新预览，继续执行）');
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
        log(seen ? '参考图已上传并出现预览' : '参考图已写入上传控件（未检测到新预览，继续执行）');
        return true;
      } catch (e) {
        log('参考图写入失败：' + e.message);
      }
    }
  }
  return false;
}

async function selectRatio(page, ratio) {
  if (!ratio || ratio === 'auto') return false;
  const els = await page.$$('button, [role="button"], [class*="ratio"], [class*="aspect"], [class*="size"]');
  for (const el of els) {
    const text = ((await el.innerText().catch(() => '')) || '').trim();
    if (text !== ratio) continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    await el.click({ timeout: 3000 }).catch(() => {});
    await sleep(300);
    return true;
  }
  return false;
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

    return {
      url: location.href, title: document.title, inputs,
      buttons: Array.from(new Set(buttons)).slice(0, 60),
      files, imgs, options: options.slice(0, 120),
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
  if (mode) {
    const switched = await clickModeTab(page, mode);
    log(switched
      ? `已切换到${mode === 'image' ? '图生图' : '文生图'}模式`
      : `未找到${mode === 'image' ? '图生图' : '文生图'}切换入口，沿用当前面板`);
  }

  if (opts.image) {
    let file = null;
    try {
      file = await resolveImageFile(opts.image);
    } catch (e) {
      return { ok: false, message: '参考图处理失败：' + e.message };
    }
    const attached = await attachReference(page, file);
    if (!attached) {
      const dbg = await probeData(page).catch(() => null);
      const hint = dbg && dbg.files.length
        ? '（页面文件输入：' + dbg.files.map(f => f.accept || f.name || '无 accept').join(' / ') + '）'
        : '（页面上没有可见的文件输入）';
      return { ok: false, message: '参考图没有成功上传' + hint };
    }
    log('已上传参考图，等待页面处理…');
    await sleep(1800);
  }

  if (opts.ratio && opts.ratio !== 'auto') {
    const ok = await selectRatio(page, opts.ratio);
    log(ok ? `已选择比例 ${opts.ratio}` : `未找到比例 ${opts.ratio} 的选项，保持页面默认`);
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

async function setFaceCount(page, n) {
  if (!n || n <= 0) return false;
  const hit = await clickTextEl(page, ['^自定义面数$', '自定义面数'], { maxLen: 12 });
  if (!hit) { log('未找到「自定义面数」入口，沿用页面默认面数'); return false; }
  // 在「自定义面数」附近找数字输入框：取中心距最近的那个，避免误抓页面其它数值输入
  const idx = await page.evaluate(() => {
    const vis = el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const sels = '[role="tab"],[role="radio"],[role="option"],[role="switch"],[role="button"],button,label,li,[class*="option"],[class*="chip"],[class*="select"]';
    let anchor = null;
    for (const el of document.querySelectorAll(sels)) {
      const t = ((el.innerText) || '').trim().replace(/\s+/g, ' ');
      if (t === '自定义面数' && vis(el)) { anchor = el.getBoundingClientRect(); break; }
    }
    if (!anchor) return -1;
    // 注意：不过滤列表，保证索引与 Node 侧 page.$$ 的结果一一对应
    const inputs = Array.from(document.querySelectorAll('input[type=number], input[inputmode="numeric"], input[type=text]'));
    let best = -1, bestD = Infinity;
    inputs.forEach((el, i) => {
      if (!vis(el)) return;
      const b = el.getBoundingClientRect();
      const d = Math.hypot((b.x + b.width / 2) - (anchor.x + anchor.width / 2), (b.y + b.height / 2) - (anchor.y + anchor.height / 2));
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  });
  if (idx < 0) { log('「自定义面数」附近没有找到可填写的输入框'); return false; }
  const inputs = await page.$$('input[type=number], input[inputmode="numeric"], input[type=text]');
  const target = inputs[idx];
  if (!target) { log('「自定义面数」输入框定位失败'); return false; }
  await target.click().catch(() => {});
  await target.fill(String(n)).catch(async () => { await page.keyboard.insertText(String(n)); });
  log(`已填写自定义面数：${n}`);
  return true;
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
  await ensureModelPage(page);
  const ready = await computeModelReady(page);
  if (!ready.ready) {
    return {
      ok: false,
      message: '浏览器里没有进入「图片生成 3D」页面（当前：' + (ready.url || '未知')
        + '）。请在设置里点「打开登录页」，登录后进入生成页。',
    };
  }

  if (opts.image) {
    let file = null;
    try { file = await resolveImageFile(opts.image); }
    catch (e) { return { ok: false, message: '参考图处理失败：' + e.message }; }
    const uploaded = await attachReference(page, file);
    if (!uploaded) return { ok: false, message: '参考图没有成功上传；网页生成模型需要至少一张参考图' };
    await sleep(1500);
  }

  await pickModelMode(page, opts.mode);
  await pickMeshVersion(page, opts.version);
  await setFaceCount(page, Number(opts.faceCount) || 0);
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
  let ready = false, title = '', url = '';
  try {
    title = await page.title();
    url = page.url();
    ready = !!(await findPromptInput(page)) && !!(await findGenerateButton(page));
  } catch {}
  readyCache = { at: now, ready, url, title };
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
        const image = String(body.image || '');
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
          const r = await runOnce(context, page, prompt, { image, ratio, mode, timeoutSec });
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
        const image = String(body.image || '');
        const opts = {
          image,
          mode: String(body.mode || ''),
          version: String(body.version || ''),
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
