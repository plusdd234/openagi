/* 图片编辑器（图库 → 双击图片 / 右键「编辑」）
 *
 * 设计口径：
 *  - 参数化非破坏式编辑：旋转/翻转/裁剪/调色都只是参数，永远不动原图；
 *    只有「保存副本 / 覆盖原图」时才真正合成一张新图写回资产库。
 *  - 画布只负责「看」，右侧检查器负责「改」：工具轨切换 调整 / 裁剪 / 滤镜 / 信息，
 *    底部固定文件名 + 格式 + 质量 + 保存，和桌面修图软件的操作顺序一致。
 *  - 裁剪矩形是归一化坐标（相对旋转翻转后的底图），拖动时只在覆盖层上算，
 *    不重绘整张图；松手才记一条历史。
 *  - 撤销栈按「一次操作一条」：滑杆在 change（松手）时记录，拖动过程不刷历史。
 */

const IE_DEFAULTS = {
  bright: 100, contrast: 100, saturate: 100,
  temp: 0, tint: 0, vignette: 0, fade: 0, scale: 100
};

/* 滤镜预设只改「调整」参数，不改裁剪和尺寸——套完还能回「调整」里继续微调。 */
const IE_PRESETS = [
  { id: 'none',  name: '原图',   v: {} },
  { id: 'vivid', name: '鲜明',   v: { bright: 102, contrast: 112, saturate: 130, temp: 4,  vignette: 8 } },
  { id: 'soft',  name: '柔和',   v: { bright: 106, contrast: 94,  saturate: 92,  temp: 3,  fade: 8 } },
  { id: 'mono',  name: '黑白',   v: { contrast: 108, saturate: 0, vignette: 12 } },
  { id: 'film',  name: '胶片',   v: { bright: 102, contrast: 96,  saturate: 82,  temp: 16, tint: -4, vignette: 24, fade: 14 } },
  { id: 'cool',  name: '冷调',   v: { contrast: 106, saturate: 104, temp: -24, tint: 2, vignette: 6 } },
  { id: 'warm',  name: '暖调',   v: { bright: 103, contrast: 104, saturate: 110, temp: 26, vignette: 6 } },
  { id: 'punch', name: '高反差', v: { bright: 98,  contrast: 138, saturate: 108, vignette: 16 } },
  { id: 'fade',  name: '褪色',   v: { bright: 104, contrast: 88,  saturate: 60,  temp: 6,  fade: 26 } }
];

const IE_EDITABLE = ['rot', 'flipH', 'flipV', 'crop', 'ratio', 'bright', 'contrast', 'saturate', 'temp', 'tint', 'vignette', 'fade', 'scale'];

const ieState = {
  id: '', name: '', baseName: '', origExt: '', origSize: 0,
  img: null,
  rot: 0, flipH: false, flipV: false,
  crop: { x: 0, y: 0, w: 1, h: 1 }, ratio: 'free',
  tool: 'adjust', zoom: 'fit',
  fmt: 'png', quality: 92,
  busy: '', tip: '', tipKind: '', dirty: false, compare: false,
  history: [], hIndex: -1,
  outW: 0, outH: 0, _cw: 1, _ch: 1
};
Object.assign(ieState, IE_DEFAULTS);

let ieBaseCache = { key: '', canvas: null, w: 0, h: 0 };
let ieRaf = 0;
let ieCropDrag = null;
let ieBound = false;
let ieKeyUpBound = false;
let ieTipTimer = 0;

function ieClamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function ieDesk() { return (typeof window !== 'undefined' && window.openagiDesktop) ? window.openagiDesktop : null; }

function ieExtOf(name) {
  const m = String(name || '').match(/\.([A-Za-z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}
function ieExtNorm(ext) {
  const s = String(ext || '').toLowerCase();
  return s === 'jpeg' ? 'jpg' : s;
}
function ieExtForFmt(fmt) { return fmt === 'jpeg' ? 'jpg' : fmt; }
function ieFmtLabel(fmt) { return fmt === 'jpeg' ? 'JPEG' : (fmt === 'webp' ? 'WebP' : 'PNG'); }

function ieEscH(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function ieFmtBytes(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '—';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' KB';
  return (v / 1024 / 1024).toFixed(1) + ' MB';
}

function ieTip(msg, kind) {
  ieState.tip = msg || '';
  ieState.tipKind = kind || '';
  const el = $('ieStatus');
  if (el) {
    el.textContent = msg || '就绪';
    el.className = 'ie-status' + (kind ? ' ' + kind : '');
  }
  if (ieTipTimer) clearTimeout(ieTipTimer);
  if (msg && kind === 'ok') {
    ieTipTimer = setTimeout(() => {
      if (ieState.tip === msg) { ieState.tip = ''; ieState.tipKind = ''; ieTip('就绪'); }
    }, 4000);
  }
}

/* ---------------- 底图：旋转 + 翻转后缓存一张，裁剪/调色都在它上面算 ---------------- */
function ieBaseBuild() {
  const img = ieState.img;
  if (!img) return null;
  const key = [ieState.id, ieState.rot, ieState.flipH ? 1 : 0, ieState.flipV ? 1 : 0].join('|');
  if (ieBaseCache.key === key && ieBaseCache.canvas) return ieBaseCache.canvas;

  const nw = img.naturalWidth || img.width || 1;
  const nh = img.naturalHeight || img.height || 1;
  const rotated = ieState.rot % 180 !== 0;
  const ow = rotated ? nh : nw;
  const oh = rotated ? nw : nh;
  const k = Math.min(1, 4096 / Math.max(ow, oh));
  const cw = Math.max(1, Math.round(ow * k));
  const ch = Math.max(1, Math.round(oh * k));

  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(ieState.rot * Math.PI / 180);
  ctx.scale(ieState.flipH ? -1 : 1, ieState.flipV ? -1 : 1);
  ctx.drawImage(img, -nw * k / 2, -nh * k / 2, nw * k, nh * k);

  ieBaseCache = { key: key, canvas: cv, w: cw, h: ch };
  return cv;
}

/* ---------------- 合成：把底图按裁剪 + 调色画进目标 canvas ---------------- */
function ieCompose(canvas, opts) {
  const base = ieBaseBuild();
  if (!base || !canvas) return null;
  const p = opts.params;
  const crop = opts.crop || { x: 0, y: 0, w: 1, h: 1 };
  const sx = crop.x * base.width;
  const sy = crop.y * base.height;
  const sw = Math.max(1, crop.w * base.width);
  const sh = Math.max(1, crop.h * base.height);
  const scale = (opts.ignoreScale ? 100 : (p.scale || 100)) / 100;
  const outW = Math.max(1, Math.round(sw * scale));
  const outH = Math.max(1, Math.round(sh * scale));
  const maxDim = opts.maxDim || 1600;
  const k = Math.min(1, maxDim / Math.max(outW, outH));
  const cw = Math.max(1, Math.round(outW * k));
  const ch = Math.max(1, Math.round(outH * k));

  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);
  if (opts.opaque) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch); }
  ctx.save();
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = opts.raw ? 'none'
    : 'brightness(' + p.bright + '%) contrast(' + p.contrast + '%) saturate(' + p.saturate + '%)';
  ctx.drawImage(base, sx, sy, sw, sh, 0, 0, cw, ch);
  ctx.restore();

  if (!opts.raw) {
    const W = cw, H = ch;
    if (p.temp) {
      const a = Math.abs(p.temp) / 100 * 0.30;
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = p.temp > 0 ? 'rgba(255,146,58,' + a + ')' : 'rgba(58,138,255,' + a + ')';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    if (p.tint) {
      const a = Math.abs(p.tint) / 100 * 0.24;
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = p.tint > 0 ? 'rgba(220,0,160,' + a + ')' : 'rgba(0,200,120,' + a + ')';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    if (p.vignette) {
      const a = p.vignette / 100 * 0.62;
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.74);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,' + a + ')');
      ctx.save();
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    if (p.fade) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,' + (p.fade / 100 * 0.30) + ')';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }
  return { cw: cw, ch: ch, outW: outW, outH: outH };
}

/* ---------------- 预览渲染 + 缩放适配 ---------------- */
function ieRender() {
  const canvas = $('ieCanvas');
  if (!canvas || !ieState.img) return;
  const cropMode = ieState.tool === 'crop';
  const crop = cropMode ? { x: 0, y: 0, w: 1, h: 1 } : ieState.crop;
  const dims = ieCompose(canvas, {
    crop: crop,
    params: ieState,
    ignoreScale: cropMode,
    maxDim: 1600,
    raw: !!ieState.compare,
    opaque: false
  });
  if (!dims) return;
  ieState._cw = dims.cw;
  ieState._ch = dims.ch;
  ieState.outW = cropMode ? ieBaseBuild().width : dims.outW;
  ieState.outH = cropMode ? ieBaseBuild().height : dims.outH;
  ieApplyView(dims.cw, dims.ch);
  ieCropPaint();
  ieHistogram();
  ieSyncHistory();
  if (ieState.tool === 'info') ieInfoFill();
  const badge = $('ieCompareBadge');
  if (badge) badge.classList.toggle('on', !!ieState.compare);
}

function ieScheduleRender() {
  if (ieRaf) return;
  ieRaf = requestAnimationFrame(() => { ieRaf = 0; ieRender(); });
}

function ieApplyView(cw, ch) {
  const cv = $('ieCanvas');
  const stage = $('ieStage');
  if (!cv || !stage) return;
  let dw, dh;
  if (ieState.zoom === 'fit') {
    const aw = Math.max(80, stage.clientWidth - 48);
    const ah = Math.max(80, stage.clientHeight - 74);
    const s = Math.min(aw / cw, ah / ch, 1);
    dw = Math.max(1, Math.round(cw * s));
    dh = Math.max(1, Math.round(ch * s));
  } else {
    const z = ieState.zoom / 100;
    dw = Math.max(1, Math.round(ieState.outW * z));
    dh = Math.max(1, Math.round(ieState.outH * z));
  }
  cv.style.width = dw + 'px';
  cv.style.height = dh + 'px';
  const lbl = $('ieZoomLabel');
  if (lbl) {
    if (ieState.zoom === 'fit') {
      const pct = ieState.outW ? Math.round(dw / ieState.outW * 100) : 100;
      lbl.textContent = '适应';
      lbl.title = '实际显示 ' + pct + '%';
    } else {
      lbl.textContent = Math.round(ieState.zoom) + '%';
      lbl.title = '';
    }
  }
}

function ieZoomStep(dir) {
  const cv = $('ieCanvas');
  if (!cv || !ieState.outW) return;
  const cur = (cv.clientWidth / ieState.outW) * 100;
  const next = Math.round((cur + dir * 25) / 25) * 25;
  ieState.zoom = ieClamp(next, 10, 400);
  ieRender();
}

/* ---------------- 直方图 ---------------- */
function ieHistogram() {
  const dc = $('ieHist');
  const src = $('ieCanvas');
  if (!dc || !src || !src.width) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.max(80, Math.round((dc.clientWidth || 268) * dpr));
  const H = Math.max(40, Math.round((dc.clientHeight || 62) * dpr));
  if (dc.width !== W || dc.height !== H) { dc.width = W; dc.height = H; }
  const ctx = dc.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(0, 0, W, H);

  const tw = 160;
  const th = Math.max(1, Math.round(tw * src.height / src.width));
  const tmp = document.createElement('canvas');
  tmp.width = tw; tmp.height = th;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  tctx.drawImage(src, 0, 0, tw, th);
  let data;
  try { data = tctx.getImageData(0, 0, tw, th).data; } catch (e) { return; }

  const BINS = 64, counts = [new Float32Array(BINS), new Float32Array(BINS), new Float32Array(BINS)];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    counts[0][data[i] >> 2]++;
    counts[1][data[i + 1] >> 2]++;
    counts[2][data[i + 2] >> 2]++;
  }
  let max = 1;
  for (let c = 0; c < 3; c++) for (let i = 0; i < BINS; i++) if (counts[c][i] > max) max = counts[c][i];

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const colors = ['rgba(228,62,62,.42)', 'rgba(46,158,88,.42)', 'rgba(56,108,228,.42)'];
  for (let c = 0; c < 3; c++) {
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < BINS; i++) {
      const x = (i / (BINS - 1)) * W;
      const y = H - Math.pow(counts[c][i] / max, 0.55) * (H - 3);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = colors[c];
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,.06)';
  ctx.beginPath();
  ctx.moveTo(0, H - 1.5); ctx.lineTo(W, H - 1.5);
  ctx.stroke();
}

/* ---------------- 裁剪覆盖层 ---------------- */
function ieRatioValue() {
  const base = ieBaseBuild();
  if (!base) return 0;
  const r = ieState.ratio;
  if (r === 'free') return 0;
  if (r === 'orig') return base.width / base.height;
  const parts = String(r).split(':').map(Number);
  if (!parts[0] || !parts[1]) return 0;
  return parts[0] / parts[1];
}

function ieCropPaint() {
  const overlay = $('ieCrop');
  const rect = $('ieCropRect');
  if (!overlay || !rect) return;
  const on = ieState.tool === 'crop' && !!ieState.img;
  overlay.classList.toggle('on', on);
  if (!on) return;
  const c = ieState.crop;
  rect.style.left = (c.x * 100) + '%';
  rect.style.top = (c.y * 100) + '%';
  rect.style.width = (c.w * 100) + '%';
  rect.style.height = (c.h * 100) + '%';
  const base = ieBaseBuild();
  const size = $('ieCropSize');
  if (size && base) {
    size.textContent = Math.round(c.w * base.width) + ' × ' + Math.round(c.h * base.height) + ' px';
  }
  ieCropInfoFill();
}

function ieCropInfoFill() {
  const box = $('ieCropInfo');
  if (!box) return;
  const base = ieBaseBuild();
  if (!base) { box.innerHTML = ''; return; }
  const c = ieState.crop;
  const w = Math.round(c.w * base.width);
  const h = Math.round(c.h * base.height);
  const ow = Math.max(1, Math.round(w * ieState.scale / 100));
  const oh = Math.max(1, Math.round(h * ieState.scale / 100));
  box.innerHTML =
    '选区 <b>' + w + ' × ' + h + '</b> px<br>' +
    '输出 <b>' + ow + ' × ' + oh + '</b> px' +
    (ieState.ratio === 'free' ? '' : ' · ' + ieState.ratio.replace('orig', '原始比例'));
}

function ieSetRatio(key) {
  if (!ieState.img) return;
  ieState.ratio = key;
  const r = ieRatioValue();
  if (r > 0) {
    const base = ieBaseBuild();
    let w = base.width, h = w / r;
    if (h > base.height) { h = base.height; w = h * r; }
    ieState.crop = {
      x: ((base.width - w) / 2) / base.width,
      y: ((base.height - h) / 2) / base.height,
      w: w / base.width,
      h: h / base.height
    };
  }
  ieState.dirty = true;
  iePanelRender();
  ieRender();
  iePushHistory();
}

function ieCropDown(e) {
  if (!ieState.img || ieState.busy) return;
  const t = e.target;
  const handle = t && t.getAttribute && t.getAttribute('data-handle');
  const inRect = !!(t && t.closest && t.closest('#ieCropRect'));
  if (!handle && !inRect) return;
  const wrap = $('ieCanvasWrap');
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  ieCropDrag = {
    handle: handle || 'move',
    x: e.clientX, y: e.clientY,
    rect: { w: r.width, h: r.height },
    start: { x: ieState.crop.x, y: ieState.crop.y, w: ieState.crop.w, h: ieState.crop.h }
  };
  window.addEventListener('pointermove', ieCropMove);
  window.addEventListener('pointerup', ieCropUp, { once: true });
  e.preventDefault();
  e.stopPropagation();
}

function ieCropMove(e) {
  const d = ieCropDrag;
  if (!d) return;
  const base = ieBaseBuild();
  if (!base) return;
  const BW = base.width, BH = base.height;
  const s = d.start;
  const dx = (e.clientX - d.x) / d.rect.w;
  const dy = (e.clientY - d.y) / d.rect.h;

  if (d.handle === 'move' || ieState.ratio === 'free') {
    let x = s.x, y = s.y, w = s.w, h = s.h;
    const MIN = 0.03;
    if (d.handle === 'move') {
      x = ieClamp(x + dx, 0, 1 - w);
      y = ieClamp(y + dy, 0, 1 - h);
    } else {
      if (d.handle.indexOf('w') >= 0) { const nx = ieClamp(x + dx, 0, x + w - MIN); w = x + w - nx; x = nx; }
      if (d.handle.indexOf('e') >= 0) { w = ieClamp(w + dx, MIN, 1 - x); }
      if (d.handle.indexOf('n') >= 0) { const ny = ieClamp(y + dy, 0, y + h - MIN); h = y + h - ny; y = ny; }
      if (d.handle.indexOf('s') >= 0) { h = ieClamp(h + dy, MIN, 1 - y); }
    }
    ieState.crop = { x: x, y: y, w: w, h: h };
    ieCropPaint();
    return;
  }

  /* 锁定比例：按底图像素算，避免不同方向拉伸把比例算歪。 */
  const r = ieRatioValue();
  let L = s.x * BW, T = s.y * BH, R = (s.x + s.w) * BW, B = (s.y + s.h) * BH;
  const MINW = Math.max(8, BW * 0.03), MINH = Math.max(8, BH * 0.03);
  const dxPx = dx * BW, dyPx = dy * BH;
  const hnd = d.handle;

  if (hnd === 'n' || hnd === 's' || hnd === 'e' || hnd === 'w') {
    if (hnd === 'e' || hnd === 'w') {
      let nw = hnd === 'w' ? R - (L + dxPx) : (R + dxPx) - L;
      nw = ieClamp(nw, MINW, hnd === 'w' ? R : BW - L);
      let nh = nw / r;
      const maxH = Math.min((T + B) / 2, BH - (T + B) / 2) * 2;
      if (nh > maxH) { nh = maxH; nw = nh * r; }
      L = hnd === 'w' ? R - nw : L;
      R = hnd === 'w' ? R : L + nw;
      const cy = (T + B) / 2;
      T = cy - nh / 2; B = cy + nh / 2;
    } else {
      let nh = hnd === 'n' ? B - (T + dyPx) : (B + dyPx) - T;
      nh = ieClamp(nh, MINH, hnd === 'n' ? B : BH - T);
      let nw = nh * r;
      const maxW = Math.min((L + R) / 2, BW - (L + R) / 2) * 2;
      if (nw > maxW) { nw = maxW; nh = nw / r; }
      T = hnd === 'n' ? B - nh : T;
      B = hnd === 'n' ? B : T + nh;
      const cx = (L + R) / 2;
      L = cx - nw / 2; R = cx + nw / 2;
    }
  } else {
    const ax = hnd.indexOf('w') >= 0 ? R : L;
    const ay = hnd.indexOf('n') >= 0 ? B : T;
    const wantW = Math.abs((hnd.indexOf('w') >= 0 ? L + dxPx : R + dxPx) - ax);
    const wantH = Math.abs((hnd.indexOf('n') >= 0 ? T + dyPx : B + dyPx) - ay);
    let nw, nh;
    if (wantW / r >= wantH) { nw = wantW; nh = nw / r; } else { nh = wantH; nw = nh * r; }
    const maxW = hnd.indexOf('w') >= 0 ? ax : BW - ax;
    const maxH = hnd.indexOf('n') >= 0 ? ay : BH - ay;
    if (nw > maxW) { nw = maxW; nh = nw / r; }
    if (nh > maxH) { nh = maxH; nw = nh * r; }
    if (nw < MINW) { nw = MINW; nh = nw / r; }
    if (nh < MINH) { nh = MINH; nw = nh * r; }
    L = hnd.indexOf('w') >= 0 ? ax - nw : ax;
    R = hnd.indexOf('w') >= 0 ? ax : ax + nw;
    T = hnd.indexOf('n') >= 0 ? ay - nh : ay;
    B = hnd.indexOf('n') >= 0 ? ay : ay + nh;
  }

  ieState.crop = {
    x: ieClamp(L / BW, 0, 1),
    y: ieClamp(T / BH, 0, 1),
    w: ieClamp((R - L) / BW, 0.01, 1),
    h: ieClamp((B - T) / BH, 0.01, 1)
  };
  ieCropPaint();
}

function ieCropUp() {
  window.removeEventListener('pointermove', ieCropMove);
  if (!ieCropDrag) return;
  ieCropDrag = null;
  ieState.dirty = true;
  iePushHistory();
  iePanelRender();
}

/* ---------------- 面板 ---------------- */
function iePanelRender() {
  const panel = $('iePanel');
  const title = $('iePanelTitle');
  if (!panel) return;
  const tool = ieState.tool;
  if (title) title.textContent = { adjust: '调整', crop: '裁剪', filter: '滤镜', info: '信息' }[tool] || '调整';

  if (tool === 'adjust') {
    panel.innerHTML =
      '<div class="ie-grp"><h4>光效</h4>' +
        ieRow('bright', '亮度', 0, 200, 1, '%') +
        ieRow('contrast', '对比度', 0, 200, 1, '%') +
      '</div>' +
      '<div class="ie-grp"><h4>色彩</h4>' +
        ieRow('saturate', '饱和度', 0, 200, 1, '%') +
        ieRow('temp', '色温', -100, 100, 1, '') +
        ieRow('tint', '色调', -100, 100, 1, '') +
      '</div>' +
      '<div class="ie-grp"><h4>效果</h4>' +
        ieRow('vignette', '暗角', 0, 100, 1, '%') +
        ieRow('fade', '褪色', 0, 100, 1, '%') +
      '</div>' +
      '<div class="ie-grp"><h4>输出</h4>' +
        ieRow('scale', '尺寸', 10, 100, 1, '%') +
        '<p class="ie-hint">双击数值或点 ↺ 可单项还原；100% 表示按裁剪后的原始像素输出。</p>' +
      '</div>';
  } else if (tool === 'crop') {
    const ratios = [
      ['free', '自由'], ['orig', '原始'], ['1:1', '1:1'], ['4:3', '4:3'],
      ['3:4', '3:4'], ['16:9', '16:9'], ['9:16', '9:16']
    ];
    panel.innerHTML =
      '<div class="ie-grp"><h4>比例</h4><div class="ie-ratios">' +
        ratios.map(r => '<button class="ie-ratio' + (ieState.ratio === r[0] ? ' on' : '') + '" data-ie-ratio="' + r[0] + '">' + r[1] + '</button>').join('') +
      '</div></div>' +
      '<div class="ie-grp"><h4>旋转与翻转</h4><div class="ie-btns">' +
        '<button class="btn sm" data-ie-act="rotL">↺ 左转 90°</button>' +
        '<button class="btn sm" data-ie-act="rotR">↻ 右转 90°</button>' +
        '<button class="btn sm" data-ie-act="flipH">水平翻转</button>' +
        '<button class="btn sm" data-ie-act="flipV">垂直翻转</button>' +
      '</div></div>' +
      '<div class="ie-grp"><h4>选区</h4>' +
        '<div class="ie-cropinfo" id="ieCropInfo"></div>' +
        '<div class="ie-btns" style="margin-top:8px"><button class="btn sm" data-ie-act="cropReset">重置裁剪</button></div>' +
        '<p class="ie-hint">拖动画面里的矩形移动选区，拖四角/边中点改变大小；选好比例后会自动锁定。</p>' +
      '</div>';
    ieCropInfoFill();
  } else if (tool === 'filter') {
    panel.innerHTML =
      '<div class="ie-grp"><h4>预设</h4><div class="ie-presets" id="iePresets">' +
        IE_PRESETS.map(p => '<button class="ie-preset' + (iePresetActive(p) ? ' on' : '') + '" data-ie-preset="' + p.id + '"><canvas width="96" height="62"></canvas><span>' + p.name + '</span></button>').join('') +
      '</div>' +
      '<p class="ie-hint">预设只改调色参数，套用后仍可到「调整」里继续微调；裁剪与尺寸不会被改动。</p></div>';
    ieDrawPresetThumbs();
  } else {
    panel.innerHTML = '<div class="ie-grp"><h4>图像信息</h4><div class="ie-info" id="ieInfoFields"></div></div>' +
      '<div class="ie-grp"><h4>操作提示</h4><p class="ie-hint">Ctrl+Z 撤销 · Ctrl+Shift+Z 重做 · 空格按住看原图 · 0 适应窗口 · 1 实际像素 · C/F/A/I 切换工具</p></div>';
    ieInfoFill();
  }
  if (tool === 'adjust' || tool === 'crop' || tool === 'filter') ieBindPanelInputs();
}

function ieValLabel(key, v) {
  if (key === 'temp' || key === 'tint') return (v > 0 ? '+' : '') + v;
  return v + '%';
}

function ieRow(key, label, min, max, step, suffix) {
  const v = ieState[key];
  return '<div class="ie-row">' +
    '<span>' + label + '</span>' +
    '<input type="range" data-ie-k="' + key + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + v + '">' +
    '<b data-ie-v="' + key + '">' + ieValLabel(key, v) + '</b>' +
    '<button class="ie-undo-val" data-ie-reset="' + key + '" title="还原为 ' + IE_DEFAULTS[key] + '">↺</button>' +
    '</div>';
}

function ieBindPanelInputs() {
  const panel = $('iePanel');
  if (!panel) return;
  panel.querySelectorAll('input[data-ie-k]').forEach(inp => {
    const key = inp.getAttribute('data-ie-k');
    inp.addEventListener('input', () => {
      ieState[key] = Number(inp.value);
      ieState.dirty = true;
      const b = panel.querySelector('[data-ie-v="' + key + '"]');
      if (b) b.textContent = ieValLabel(key, ieState[key]);
      ieScheduleRender();
    });
    inp.addEventListener('change', () => { iePushHistory(); });
  });
  panel.querySelectorAll('[data-ie-reset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-ie-reset');
      ieState[key] = IE_DEFAULTS[key];
      ieState.dirty = true;
      iePanelRender();
      ieRender();
      iePushHistory();
    });
  });
  panel.querySelectorAll('[data-ie-ratio]').forEach(btn => {
    btn.addEventListener('click', () => ieSetRatio(btn.getAttribute('data-ie-ratio')));
  });
  panel.querySelectorAll('[data-ie-preset]').forEach(btn => {
    btn.addEventListener('click', () => ieApplyPreset(btn.getAttribute('data-ie-preset')));
  });
}

function iePresetActive(p) {
  const keys = Object.keys(IE_DEFAULTS);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === 'scale') continue;
    const want = (k in p.v) ? p.v[k] : IE_DEFAULTS[k];
    if (ieState[k] !== want) return false;
  }
  return true;
}

function ieApplyPreset(id) {
  const p = IE_PRESETS.find(x => x.id === id);
  if (!p || !ieState.img) return;
  const keys = Object.keys(IE_DEFAULTS);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === 'scale') continue;
    ieState[k] = (k in p.v) ? p.v[k] : IE_DEFAULTS[k];
  }
  ieState.dirty = true;
  const panel = $('iePanel');
  if (panel) {
    panel.querySelectorAll('[data-ie-preset]').forEach(b => {
      b.classList.toggle('on', b.getAttribute('data-ie-preset') === id);
    });
  }
  ieRender();
  iePushHistory();
  ieTip('已套用「' + p.name + '」', 'ok');
}

function ieDrawPresetThumbs() {
  const base = ieBaseBuild();
  if (!base) return;
  const box = $('iePresets');
  if (!box) return;
  box.querySelectorAll('[data-ie-preset]').forEach(btn => {
    const id = btn.getAttribute('data-ie-preset');
    const p = IE_PRESETS.find(x => x.id === id);
    const cv = btn.querySelector('canvas');
    if (!p || !cv) return;
    const params = Object.assign({}, IE_DEFAULTS, p.v);
    ieCompose(cv, {
      crop: ieState.crop,
      params: params,
      ignoreScale: true,
      maxDim: 96,
      raw: false,
      opaque: true
    });
  });
}

function ieInfoFill() {
  const box = $('ieInfoFields');
  if (!box) return;
  const base = ieBaseBuild();
  if (!base) { box.innerHTML = ''; return; }
  const outW = ieState.outW || Math.round(ieState.crop.w * base.width);
  const outH = ieState.outH || Math.round(ieState.crop.h * base.height);
  const gw = function (a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a || 1; };
  const g = gw(outW, outH);
  const ar = (outW / g) + ':' + (outH / g);
  const row = (k, v, mono) => '<div class="ie-info-row"><span>' + k + '</span><b' + (mono ? ' class="mono"' : '') + '>' + ieEscH(v) + '</b></div>';
  box.innerHTML =
    row('文件名', ieState.name || '—') +
    row('原始尺寸', base.width + ' × ' + base.height) +
    row('输出尺寸', outW + ' × ' + outH) +
    row('宽高比', ar) +
    row('输出格式', ieFmtLabel(ieState.fmt)) +
    row('源文件大小', ieFmtBytes(ieState.origSize)) +
    row('资产 ID', ieState.id || '—', true);
}

/* ---------------- 历史 ---------------- */
function ieSnapshot() {
  const s = {};
  IE_EDITABLE.forEach(k => {
    s[k] = (k === 'crop') ? { x: ieState.crop.x, y: ieState.crop.y, w: ieState.crop.w, h: ieState.crop.h } : ieState[k];
  });
  return s;
}

function iePushHistory() {
  if (!ieState.img) return;
  const snap = ieSnapshot();
  const js = JSON.stringify(snap);
  const cur = ieState.history[ieState.hIndex];
  if (cur && JSON.stringify(cur) === js) { ieSyncHistory(); return; }
  ieState.history = ieState.history.slice(0, ieState.hIndex + 1);
  ieState.history.push(snap);
  if (ieState.history.length > 60) ieState.history.shift();
  ieState.hIndex = ieState.history.length - 1;
  ieState.dirty = true;
  ieSyncHistory();
}

function ieApplySnapshot(snap) {
  if (!snap) return;
  IE_EDITABLE.forEach(k => {
    if (k === 'crop') {
      const c = snap.crop || { x: 0, y: 0, w: 1, h: 1 };
      ieState.crop = { x: c.x, y: c.y, w: c.w, h: c.h };
    } else {
      ieState[k] = snap[k];
    }
  });
  ieBaseCache.key = '';
  iePanelRender();
  ieRender();
}

function ieUndo() {
  if (ieState.hIndex <= 0) return;
  ieState.hIndex--;
  ieApplySnapshot(ieState.history[ieState.hIndex]);
  ieSyncHistory();
}

function ieRedo() {
  if (ieState.hIndex >= ieState.history.length - 1) return;
  ieState.hIndex++;
  ieApplySnapshot(ieState.history[ieState.hIndex]);
  ieSyncHistory();
}

function ieSyncHistory() {
  const u = $('ieUndoBtn');
  const r = $('ieRedoBtn');
  if (u) u.disabled = ieState.hIndex <= 0;
  if (r) r.disabled = ieState.hIndex >= ieState.history.length - 1;
  const t = $('imgEditTitle');
  if (t) t.textContent = '图片编辑器 · ' + (ieState.name || '未命名') + (ieState.dirty ? ' •' : '');
}

/* ---------------- 工具切换 ---------------- */
function ieSetTab(tool) {
  if (['adjust', 'crop', 'filter', 'info'].indexOf(tool) < 0) return;
  ieState.tool = tool;
  document.querySelectorAll('#ieRail .ie-tool').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-ie-tab') === tool);
  });
  iePanelRender();
  ieRender();
}

/* ---------------- 旋转 / 翻转 / 重置 ---------------- */
function ieRotate(dir) {
  if (!ieState.img) return;
  const c = ieState.crop;
  if (dir > 0) {
    ieState.rot = (ieState.rot + 90) % 360;
    ieState.crop = { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w };
  } else {
    ieState.rot = (ieState.rot + 270) % 360;
    ieState.crop = { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w };
  }
  ieBaseCache.key = '';
  ieState.dirty = true;
  iePanelRender();
  ieRender();
  iePushHistory();
}

function ieFlip(axis) {
  if (!ieState.img) return;
  if (axis === 'h') {
    ieState.flipH = !ieState.flipH;
    ieState.crop = { x: 1 - ieState.crop.x - ieState.crop.w, y: ieState.crop.y, w: ieState.crop.w, h: ieState.crop.h };
  } else {
    ieState.flipV = !ieState.flipV;
    ieState.crop = { x: ieState.crop.x, y: 1 - ieState.crop.y - ieState.crop.h, w: ieState.crop.w, h: ieState.crop.h };
  }
  ieBaseCache.key = '';
  ieState.dirty = true;
  iePanelRender();
  ieRender();
  iePushHistory();
}

function ieResetAll() {
  if (!ieState.img) return;
  Object.assign(ieState, IE_DEFAULTS);
  ieState.rot = 0; ieState.flipH = false; ieState.flipV = false;
  ieState.crop = { x: 0, y: 0, w: 1, h: 1 };
  ieState.ratio = 'free';
  ieBaseCache.key = '';
  ieState.dirty = true;
  iePanelRender();
  ieRender();
  iePushHistory();
  ieTip('已恢复默认调整', 'ok');
}

/* ---------------- 保存 ---------------- */
function ieTargetBaseName() {
  const inp = $('ieName');
  const raw = (inp && inp.value || ieState.baseName || 'image').trim();
  return raw.replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'image';
}

function ieSyncChrome() {
  const ext = ieExtForFmt(ieState.fmt);
  const fe = $('ieFmtExt');
  if (fe) fe.textContent = '.' + ext;
  const fmt = $('ieFmt');
  if (fmt && fmt.value !== ieState.fmt) fmt.value = ieState.fmt;
  const qw = $('ieQualityWrap');
  if (qw) qw.classList.toggle('hide', ieState.fmt === 'png');
  const q = $('ieQuality');
  if (q && Number(q.value) !== ieState.quality) q.value = ieState.quality;
  const qv = $('ieQualityVal');
  if (qv) qv.textContent = ieState.quality;
  const sa = $('ieSaveAsBtn');
  const sv = $('ieSaveBtn');
  if (sa) sa.disabled = !!ieState.busy || !ieState.img;
  if (sv) sv.disabled = !!ieState.busy || !ieState.img;
  ieSyncHistory();
}

async function ieSave(kind) {
  if (!ieState.img || ieState.busy) return;
  const fmt = ieState.fmt;
  const ext = ieExtForFmt(fmt);
  if (kind === 'save' && (ieExtNorm(ieState.origExt) !== ext || ieExtNorm(ieExtOf(ieState.name)) !== ext)) {
    ieTip('原图是 .' + ieExtNorm(ieState.origExt || ieExtOf(ieState.name)) + '，改成 ' + fmt.toUpperCase() + ' 请用「保存副本」', 'err');
    return;
  }
  ieState.busy = 'save';
  ieSyncChrome();
  ieTip('正在合成图片…');

  try {
    const cv = document.createElement('canvas');
    ieCompose(cv, {
      crop: ieState.crop,
      params: ieState,
      maxDim: 8192,
      raw: false,
      opaque: fmt === 'jpeg'
    });
    const mime = 'image/' + fmt;
    const dataURL = cv.toDataURL(mime, ieState.quality / 100);
    const base = ieTargetBaseName();
    let target = base + '.' + ext;
    if (kind === 'saveAs' && target === ieState.name) target = base + ' 编辑.' + ext;

    const d = ieDesk();
    if (!d || typeof d.assetPut !== 'function') {
      const a = document.createElement('a');
      a.href = dataURL;
      a.download = target;
      document.body.appendChild(a);
      a.click();
      a.remove();
      ieTip('浏览器模式：已下载 ' + target, 'ok');
      return;
    }

    const req = { kind: 'image', data: dataURL, name: target, source: 'editor', ext: ext };
    if (kind === 'save') req.id = ieState.id;
    const r = await d.assetPut(req);
    if (!r || !r.ok) throw new Error((r && r.message) || '写入资产库失败');

    if (kind === 'save') {
      ieState.name = target;
      ieState.baseName = base;
      ieState.origExt = ext;
      ieState.origSize = Math.round(dataURL.length * 3 / 4);
      ieTip('已覆盖原图', 'ok');
    } else {
      const a = r.asset || {};
      if (a.id) {
        ieState.id = a.id;
        ieState.name = a.name || target;
        ieState.baseName = String(ieState.name).replace(/\.[^.]+$/, '');
        ieState.origExt = ext;
        ieState.origSize = Math.round(dataURL.length * 3 / 4);
        const inp = $('ieName');
        if (inp) inp.value = ieState.baseName;
      }
      ieTip('已保存副本「' + target + '」', 'ok');
    }
    ieState.dirty = false;
    if (typeof libForgetThumb === 'function') { try { libForgetThumb(ieState.id); } catch (e) {} }
    if (typeof libRefresh === 'function') { try { libRefresh(); } catch (e) {} }
    iePanelRender();
    ieRender();
  } catch (e) {
    ieTip('保存失败：' + ((e && e.message) || e), 'err');
  } finally {
    ieState.busy = '';
    ieSyncChrome();
  }
}

/* ---------------- 动作分发 ---------------- */
function ieAction(a) {
  if (!a) return;
  if (a === 'undo') { ieUndo(); return; }
  if (a === 'redo') { ieRedo(); return; }
  if (a === 'rotL') { ieRotate(-1); return; }
  if (a === 'rotR') { ieRotate(1); return; }
  if (a === 'flipH') { ieFlip('h'); return; }
  if (a === 'flipV') { ieFlip('v'); return; }
  if (a === 'cropReset') {
    ieState.crop = { x: 0, y: 0, w: 1, h: 1 };
    ieState.ratio = 'free';
    ieState.dirty = true;
    iePanelRender();
    ieRender();
    iePushHistory();
    return;
  }
  if (a === 'zoomIn') { ieZoomStep(1); return; }
  if (a === 'zoomOut') { ieZoomStep(-1); return; }
  if (a === 'zoomFit') { ieState.zoom = 'fit'; ieRender(); return; }
  if (a === 'zoom100') { ieState.zoom = 100; ieRender(); return; }
  if (a === 'reset') { ieResetAll(); return; }
  if (a === 'save' || a === 'saveAs') { ieSave(a); return; }
}

/* ---------------- 绑定 ---------------- */
function ieBind() {
  if (ieBound) return;
  ieBound = true;
  const win = $('imgEditWin');
  if (!win) return;
  win.setAttribute('tabindex', '-1');
  win.style.outline = 'none';

  document.querySelectorAll('#ieRail .ie-tool').forEach(btn => {
    btn.addEventListener('click', () => ieSetTab(btn.getAttribute('data-ie-tab')));
  });

  win.addEventListener('click', e => {
    const act = e.target.closest && e.target.closest('[data-ie-act]');
    if (act) {
      const a = act.getAttribute('data-ie-act');
      if (a === 'compare') return;
      e.preventDefault();
      ieAction(a);
    }
  });

  const cmp = win.querySelector('[data-ie-act="compare"]');
  if (cmp) {
    const on = () => {
      ieState.compare = true;
      cmp.classList.add('on');
      ieRender();
    };
    const off = () => {
      if (!ieState.compare) return;
      ieState.compare = false;
      cmp.classList.remove('on');
      ieRender();
    };
    cmp.addEventListener('pointerdown', e => { e.preventDefault(); on(); });
    cmp.addEventListener('pointerup', off);
    cmp.addEventListener('pointerleave', off);
    cmp.addEventListener('pointercancel', off);
  }

  const crop = $('ieCrop');
  if (crop) crop.addEventListener('pointerdown', ieCropDown);

  const name = $('ieName');
  if (name) {
    name.addEventListener('input', () => { ieState.baseName = name.value; });
  }
  const fmt = $('ieFmt');
  if (fmt) fmt.addEventListener('change', () => { ieState.fmt = fmt.value; ieSyncChrome(); iePanelRender(); });
  const q = $('ieQuality');
  if (q) {
    q.addEventListener('input', () => {
      ieState.quality = Number(q.value);
      const qv = $('ieQualityVal');
      if (qv) qv.textContent = ieState.quality;
    });
  }

  const close = $('btnImgEditClose');
  if (close) close.addEventListener('click', () => {
    ieState.img = null;
    ieBaseCache = { key: '', canvas: null, w: 0, h: 0 };
  });

  document.addEventListener('keydown', ieKeyDown);
  window.addEventListener('resize', () => {
    if (!ieState.img || !win || win.classList.contains('hidden')) return;
    ieRender();
  });
  win.addEventListener('pointerdown', () => { try { win.focus({ preventScroll: true }); } catch (e) {} });
}

function ieEditorActive() {
  const win = $('imgEditWin');
  if (!win || win.classList.contains('hidden') || !ieState.img) return false;
  const ae = document.activeElement;
  return !ae || ae === document.body || win.contains(ae);
}

function ieIsTyping() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = (ae.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || ae.isContentEditable;
}

function ieKeyDown(e) {
  if (!ieEditorActive()) return;
  const k = (e.key || '').toLowerCase();
  const meta = e.ctrlKey || e.metaKey;
  if (meta && k === 'z') {
    e.preventDefault();
    if (e.shiftKey) ieRedo(); else ieUndo();
    return;
  }
  if (meta && k === 'y') { e.preventDefault(); ieRedo(); return; }
  if (ieIsTyping()) return;
  if (k === ' ') {
    if (!ieState.compare) {
      ieState.compare = true;
      const b = $('ieCompareBadge');
      if (b) b.classList.add('on');
      ieRender();
    }
    e.preventDefault();
    return;
  }
  if (k === 'escape') {
    if (ieState.tool === 'crop') ieSetTab('adjust');
    return;
  }
  if (k === '[') { ieRotate(-1); e.preventDefault(); return; }
  if (k === ']') { ieRotate(1); e.preventDefault(); return; }
  if (k === '0') { ieState.zoom = 'fit'; ieRender(); return; }
  if (k === '1') { ieState.zoom = 100; ieRender(); return; }
  if (k === 'c') { ieSetTab('crop'); return; }
  if (k === 'a') { ieSetTab('adjust'); return; }
  if (k === 'f') { ieSetTab('filter'); return; }
  if (k === 'i') { ieSetTab('info'); return; }
}

function ieBindKeyUp() {
  if (ieKeyUpBound) return;
  ieKeyUpBound = true;
  document.addEventListener('keyup', e => {
    if (e.key !== ' ') return;
    if (!ieEditorActive()) return;
    ieState.compare = false;
    const b = $('ieCompareBadge');
    if (b) b.classList.remove('on');
    const c = document.querySelector('.ie-compare');
    if (c) c.classList.remove('on');
    ieRender();
  });
}

/* ---------------- 打开 / 关闭 ---------------- */
function ieResetState() {
  Object.assign(ieState, IE_DEFAULTS);
  Object.assign(ieState, {
    id: '', name: '', baseName: '', origExt: '', origSize: 0,
    img: null, rot: 0, flipH: false, flipV: false,
    crop: { x: 0, y: 0, w: 1, h: 1 }, ratio: 'free',
    tool: 'adjust', zoom: 'fit', fmt: 'png', quality: 92,
    busy: '', tip: '', tipKind: '', dirty: false, compare: false,
    history: [], hIndex: -1, outW: 0, outH: 0, _cw: 1, _ch: 1
  });
  ieBaseCache = { key: '', canvas: null, w: 0, h: 0 };
  if (ieRaf) { cancelAnimationFrame(ieRaf); ieRaf = 0; }
}

function openImageEditor(id, asset, dataURL) {
  const win = $('imgEditWin');
  if (!win || !dataURL) return false;
  ieResetState();
  ieState.id = id;
  ieState.name = (asset && asset.name) || (id + '.png');
  ieState.baseName = String(ieState.name).replace(/\.[^.]+$/, '');
  ieState.origExt = ieExtNorm(ieExtOf(ieState.name));
  ieState.origSize = (asset && asset.size) || 0;
  const known = ['png', 'jpg', 'jpeg', 'webp'];
  ieState.fmt = known.indexOf(ieExtNorm(ieState.origExt)) >= 0
    ? (ieExtNorm(ieState.origExt) === 'jpg' ? 'jpeg' : ieExtNorm(ieState.origExt))
    : 'png';

  ieBind();
  ieBindKeyUp();
  const nameInput = $('ieName');
  if (nameInput) nameInput.value = ieState.baseName;
  const title = $('imgEditTitle');
  if (title) title.textContent = '图片编辑器 · ' + ieState.name;
  win.classList.remove('hidden');
  try { win.focus({ preventScroll: true }); } catch (e) {}

  document.querySelectorAll('#ieRail .ie-tool').forEach(b => {
    b.classList.toggle('on', b.getAttribute('data-ie-tab') === 'adjust');
  });
  ieState.busy = 'load';
  ieSyncChrome();
  iePanelRender();
  ieTip('载入中…');

  const img = new Image();
  img.onload = () => {
    ieState.img = img;
    ieState.busy = '';
    ieBaseCache = { key: '', canvas: null, w: 0, h: 0 };
    ieState.history = [ieSnapshot()];
    ieState.hIndex = 0;
    ieState.dirty = false;
    ieSyncChrome();
    iePanelRender();
    ieRender();
    ieTip('就绪 · 拖动滑杆实时预览', '');
  };
  img.onerror = () => {
    ieState.busy = '';
    ieSyncChrome();
    ieTip('图片载入失败，可能资产已损坏', 'err');
  };
  ieState.img = null;
  ieState.busy = 'load';
  img.src = dataURL;
  return true;
}
