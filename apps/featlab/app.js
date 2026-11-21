/* 特征提取台（featlab）
 *
 * 把工作流里的「特征提取」节点拆成一个可人工干预的编辑器：
 *   · 人工：在图上拖框、改名、排序、微调边界（四边 ±像素 / 外扩 / 内缩 / 1:1 / 锁比例）；
 *   · AI：按「工作要求」自行定位并命名特征，可逐格复核、补齐、给手工框命名；
 *   · 产物：3×3 图集（每格一个特征区域）+「左上为图1人物的发髻…」式标注，
 *     可导出 PNG / JSON，标注、填表式提示词、区域小图 / 整张源图 / 图集都能一键复制。
 *
 * 复制图片只走 navigator.clipboard + ClipboardItem（app:// 与 file:// 都是安全上下文）；
 * 写不进剪贴板时降级成下载，并如实说明，不假装成功。
 *
 * 模型调用只走 llmConn() + llmStreamRequest()；图片草稿走 blob-store 外置。
 * 不读 localStorage 的 llmKey，不碰 window.openagiDesktop。
 */
(function () {
  'use strict';

  var STORE_KEY = 'hf_featlab.v1';
  var MAX_SRC = 3;
  var MAX_REG = 9;
  var MAX_SIDE = 2048;              // 导入时压到这个边长，兼顾清晰度与草稿体积
  var MIN_BOX_PX = 8;               // 区域最小边长（像素），防止拖成一条线
  var POS = ['左上', '中上', '右上', '左中', '正中', '右中', '左下', '中下', '右下'];
  var COLORS = ['#e35d5d', '#e0953a', '#c9b037', '#5aa469', '#4a9ec9', '#5b8fd9', '#8a6fd1', '#d16fae', '#7a8797'];
  var TAB_LIST = ['ext', 'atlas', 'prompt', 'ann'];

  /* 中文选项 → 英文关键词。CLIP 只懂英文，所以「英文」模式必须真给英文，
   * 没收录的自定义中文词直接丢掉（并在状态栏说清丢了几个），不能原样塞进去当 <unk>。 */
  var PM_EN = {
    subject: {
      '人物': 'character', '少女': 'young girl', '男性': 'man', '产品': 'product',
      '手办': 'figurine', '机械': 'mech', '建筑': 'architecture', '动物': 'animal', '场景': 'scene'
    },
    style: {
      '写实摄影': 'photorealistic photography', '电影感': 'cinematic lighting',
      '二次元插画': 'anime illustration', '3D 渲染': '3d render',
      '国风水墨': 'chinese ink painting', '厚涂': 'thick painterly strokes',
      '线稿': 'line art', '像素': 'pixel art', '手办模型': 'toy figure',
      '赛博朋克': 'cyberpunk'
    },
    use: {
      '图生图参考': 'reference sheet', '局部重绘': 'inpainting region',
      '三视图': 'three-view turnaround', '纹理参考': 'texture reference',
      '通用生图': 'concept art'
    },
    material: {
      '树脂': 'resin', '黏土': 'clay', '金属': 'metal', '布料': 'fabric',
      '陶瓷': 'ceramic', '次表面散射皮肤': 'subsurface scattering skin', '塑料': 'plastic'
    },
    palette: {
      '低饱和': 'muted colors', '高对比': 'high contrast', '莫兰迪': 'morandi palette',
      '冷暖对比': 'warm-cool contrast', '单色': 'monochrome', '金属灰': 'metallic grey'
    },
    light: {
      '柔和侧光': 'soft side light', '顶光': 'top light', '伦勃朗光': 'rembrandt lighting',
      '边缘光': 'rim light', '环境光': 'ambient light', '棚拍柔光': 'studio softbox'
    },
    angle: {
      '正面': 'front view', '四分之三侧': 'three-quarter view', '侧面': 'side view',
      '俯视': 'top-down view', '仰视': 'low angle', '特写': 'close-up', '全身': 'full body'
    },
    bg: {
      '纯白背景': 'pure white background', '浅灰渐变': 'light grey gradient',
      '透明背景': 'transparent background', '影棚背景': 'studio backdrop',
      '虚化景深': 'blurred depth of field', '纯黑背景': 'pure black background'
    },
    q: {
      '超清细节': 'ultra detailed', '高精度纹理': 'high texture fidelity',
      '锐利边缘': 'sharp edges', '电影级调色': 'cinematic color grading', '8K': '8k'
    }
  };

  var S = {
    sources: [],                    // [{id, name, w, h, _img, _packed}]
    regions: [],                    // [{id, name, srcId, box:[x,y,w,h]}] — 数组顺序 = 图集顺序
    activeId: '',
    selId: '',
    opt: {
      req: '', subject: '人物', scope: 'all', verify: true,
      cell: 512, margin: 30, gap: 0, bg: '#15181d', badge: true, labels: false
    },
    pmt: {                          // 填表式提示词（唯一真源；主体复用 S.opt.subject，不另存一份）
      use: '图生图参考', style: '', angle: '', material: '',
      palette: '', light: '', bg: '', details: '', quality: [], extra: '',
      neg: '模糊，低清，畸变，多余肢体，水印，文字，logo，噪点', lang: 'zh'
    },
    pmEdited: false,                // 用户手改过生成结果就不再自动覆盖
    pmOut: '',
    tab: 'ext',
    edgeStep: 1,                    // 边界微调步进（像素）
    lockRatio: false,               // 拖角点时是否锁定宽高比
    ann: '',
    annEdited: false,
    busy: false,
    abort: null,
    tool: 'select'
  };

  var IMG = Object.create(null);    // srcId -> dataURL（内存里的真图）
  var VIEW = { s: 1, ox: 0, oy: 0, touched: false };
  var UNDO = [];
  var REDO = [];
  var E = {};
  var ctx = null;
  var root = null;
  var DPR = 1;
  var drag = null;
  var spaceDown = false;
  var saveTimer = null;
  var previewTimer = null;
  var seq = 0;

  /* ---------------- 小工具 ---------------- */

  function $(sel, r) { return (r || root).querySelector(sel); }
  function uid(p) { seq++; return (p || 'r') + Date.now().toString(36) + seq.toString(36); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { var n = Number(v); return isFinite(n) ? n : d; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function round(v, p) { var k = Math.pow(10, p || 0); return Math.round(v * k) / k; }
  function stripExt(n) { return String(n || '').replace(/\.[^.]+$/, ''); }
  function friendly(e) {
    var m = String((e && e.message) || e || '未知错误');
    if (/未配置|not configured/i.test(m)) return '语言模型未配置，请先在设置里填写模型';
    if (/Failed to fetch|NetworkError/i.test(m)) return '网络请求失败（检查模型地址与网络）';
    if (/401|403/.test(m)) return '鉴权失败（检查 API Key）';
    if (/429/.test(m)) return '请求过于频繁或额度不足';
    return m.length > 160 ? m.slice(0, 160) + '…' : m;
  }
  function isTyping(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
  }

  /* ---------------- 状态存取 ---------------- */

  function activeSource() {
    for (var i = 0; i < S.sources.length; i++) if (S.sources[i].id === S.activeId) return S.sources[i];
    return S.sources[0] || null;
  }
  function sourceById(id) {
    for (var i = 0; i < S.sources.length; i++) if (S.sources[i].id === id) return S.sources[i];
    return null;
  }
  function sourceIndex(id) {
    for (var i = 0; i < S.sources.length; i++) if (S.sources[i].id === id) return i;
    return -1;
  }
  function regionById(id) {
    for (var i = 0; i < S.regions.length; i++) if (S.regions[i].id === id) return S.regions[i];
    return null;
  }
  function activeRegions() {
    return S.regions.filter(function (r) { return r.srcId === S.activeId; });
  }
  function regionColor(i) { return COLORS[i % COLORS.length]; }

  function saveNow() {
    try {
      var sources = S.sources.map(function (s) {
        var live = IMG[s.id] || '';
        return {
          id: s.id, name: s.name, w: s.w, h: s.h,
          /* 图还没从 IDB 还原时，必须写回原来的存根，不能写成空串 */
          img: live ? ((typeof blobPack === 'function') ? blobPack(live) : live) : (s._packed || '')
        };
      });
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1,
        sources: sources,
        regions: S.regions,
        activeId: S.activeId,
        opt: S.opt,
        pmt: S.pmt,
        pmEdited: S.pmEdited,
        pmOut: S.pmEdited ? S.pmOut : '',
        tab: S.tab,
        edgeStep: S.edgeStep,
        lockRatio: S.lockRatio,
        ann: S.ann,
        annEdited: S.annEdited,
        updatedAt: Date.now()
      }));
    } catch (e) {
      status('草稿保存失败（本地存储空间可能已满）');
    }
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 350);
  }

  function loadState() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
    if (!raw) return false;
    var d = null;
    try { d = JSON.parse(raw); } catch (e) { d = null; }
    if (!d || d.v !== 1) return false;
    S.sources = (Array.isArray(d.sources) ? d.sources : []).filter(function (s) {
      return s && typeof s.id === 'string';
    }).slice(0, MAX_SRC).map(function (s) {
      return {
        id: s.id,
        name: String(s.name || '图片'),
        w: Math.max(1, num(s.w, 1)),
        h: Math.max(1, num(s.h, 1)),
        _packed: String(s.img || '')
      };
    });
    S.regions = (Array.isArray(d.regions) ? d.regions : []).filter(function (r) {
      return r && typeof r.id === 'string' && Array.isArray(r.box) && r.box.length === 4 && sourceById(String(r.srcId || ''));
    }).slice(0, MAX_REG).map(function (r) {
      return {
        id: r.id,
        name: String(r.name || '特征'),
        note: String(r.note || ''),
        srcId: String(r.srcId || ''),
        box: r.box.map(function (v) { return clamp(num(v, 0), 0, 1); })
      };
    });
    S.activeId = sourceById(d.activeId) ? d.activeId : (S.sources[0] ? S.sources[0].id : '');
    S.selId = '';
    if (d.opt && typeof d.opt === 'object') {
      ['req', 'subject', 'scope', 'cell', 'margin', 'gap', 'bg'].forEach(function (k) {
        if (d.opt[k] != null) S.opt[k] = d.opt[k];
      });
      S.opt.verify = d.opt.verify !== false;
      S.opt.badge = d.opt.badge !== false;
      S.opt.labels = !!d.opt.labels;
      S.opt.cell = clamp(num(S.opt.cell, 512), 128, 1024);
      if ([256, 384, 512].indexOf(S.opt.cell) < 0) S.opt.cell = 512;
      S.opt.margin = clamp(num(S.opt.margin, 30), 0, 100);
      S.opt.gap = clamp(num(S.opt.gap, 0), 0, 64);
      if ([0, 6, 12].indexOf(S.opt.gap) < 0) S.opt.gap = 0;
    }
    S.ann = typeof d.ann === 'string' ? d.ann : '';
    S.annEdited = !!d.annEdited;
    if (d.pmt && typeof d.pmt === 'object') {
      var pk = ['use', 'style', 'angle', 'material', 'palette', 'light', 'bg', 'details', 'extra', 'neg', 'lang'];
      pk.forEach(function (k) {
        if (typeof d.pmt[k] === 'string') S.pmt[k] = d.pmt[k];
      });
      if (Array.isArray(d.pmt.quality)) {
        S.pmt.quality = d.pmt.quality.filter(function (q) { return typeof q === 'string'; }).slice(0, 8);
      }
    }
    if (['zh', 'en', 'both'].indexOf(S.pmt.lang) < 0) S.pmt.lang = 'zh';
    S.pmEdited = !!d.pmEdited;
    S.pmOut = typeof d.pmOut === 'string' ? d.pmOut : '';
    S.tab = TAB_LIST.indexOf(d.tab) >= 0 ? d.tab : 'ext';
    S.edgeStep = [1, 5, 10].indexOf(Number(d.edgeStep)) >= 0 ? Number(d.edgeStep) : 1;
    S.lockRatio = !!d.lockRatio;
    hydrateImages();
    return true;
  }

  /* 草稿里的图是 blob-store 存根；blobEnsure 读完 IDB 之前解析会原样返回 */
  function hydrateImages() {
    S.sources.forEach(function (s) {
      if (!s._packed) return;
      var v = s._packed;
      if (typeof blobResolve === 'function') {
        try { v = blobResolve(v); } catch (e) { v = s._packed; }
      }
      if (typeof v === 'string' && v.indexOf('data:') === 0) {
        IMG[s.id] = v;
        loadSourceImage(s);
      }
    });
  }

  function loadSourceImage(s) {
    if (!s || !IMG[s.id] || s._img || s._loading) return;
    s._loading = true;
    var im = new Image();
    im.onload = function () {
      s._loading = false;
      s._img = im;
      s.w = im.naturalWidth || im.width || s.w;
      s.h = im.naturalHeight || im.height || s.h;
      if (S.activeId === s.id) { syncUI(); draw(); }
      else renderSources();
      schedulePreview();
    };
    im.onerror = function () {
      s._loading = false;
      log('图像解码失败：' + s.name, 'err');
    };
    im.src = IMG[s.id];
  }

  /* ---------------- 源图 ---------------- */

  function readFileDataURL(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result || '')); };
      fr.onerror = function () { rej(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  function shrinkDataURL(dataURL, maxSide) {
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () {
        var w = im.naturalWidth, h = im.naturalHeight;
        var k = Math.min(1, (maxSide || MAX_SIDE) / Math.max(w, h));
        if (k >= 1) { res({ url: dataURL, w: w, h: h }); return; }
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        var out = dataURL;
        try { out = c.toDataURL('image/webp', 0.9); } catch (e) { out = dataURL; }
        res({ url: out, w: c.width, h: c.height });
      };
      im.onerror = function () { res({ url: dataURL, w: 0, h: 0 }); };
      im.src = dataURL;
    });
  }

  async function importFiles(files) {
    var list = Array.prototype.slice.call(files || []).filter(function (f) {
      return f && (/^image\//.test(f.type || '') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || ''));
    });
    if (!list.length) { status('没有可导入的图片'); return; }
    var room = MAX_SRC - S.sources.length;
    if (room <= 0) { status('最多 3 张源图，先删掉一张再导入'); return; }
    if (list.length > room) {
      log('最多 3 张源图，只导入前 ' + room + ' 张', 'warn');
      list = list.slice(0, room);
    }
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      setBusyText(true, '导入图片', f.name);
      try {
        var raw = await readFileDataURL(f);
        var shrunk = await shrinkDataURL(raw, MAX_SIDE);
        if (!shrunk.w || !shrunk.h) throw new Error('图片解码失败');
        var src = {
          id: uid('s'),
          name: stripExt(f.name) || ('图' + (S.sources.length + 1)),
          w: shrunk.w, h: shrunk.h
        };
        IMG[src.id] = shrunk.url;
        S.sources.push(src);
        loadSourceImage(src);
        S.activeId = src.id;
        log('导入「' + src.name + '」· ' + src.w + '×' + src.h, 'ok');
      } catch (e) {
        log('导入失败：' + friendly(e), 'err');
      }
    }
    setBusyText(false);
    VIEW.touched = false;
    fitView();
    syncUI();
    saveNow();
  }

  function removeSource(id) {
    var src = sourceById(id);
    if (!src) return;
    var n = S.regions.filter(function (r) { return r.srcId === id; }).length;
    if (n && !window.confirm('「' + src.name + '」上还有 ' + n + ' 个特征区域，一并删除？')) return;
    pushUndo();
    S.sources = S.sources.filter(function (s) { return s.id !== id; });
    S.regions = S.regions.filter(function (r) { return r.srcId !== id; });
    if (S.activeId === id) S.activeId = S.sources[0] ? S.sources[0].id : '';
    if (S.selId && !regionById(S.selId)) S.selId = '';
    /* 不删 IMG：删图也能用 Ctrl+Z 找回来 */
    fitView();
    syncUI();
    saveNow();
  }

  function setActive(id) {
    if (!sourceById(id) || S.activeId === id) return;
    S.activeId = id;
    VIEW.touched = false;
    fitView();
    syncUI();
    saveSoon();
  }

  /* ---------------- 撤销 / 重做 ---------------- */

  function snapshot() {
    return JSON.stringify({
      sources: S.sources.map(function (s) { return { id: s.id, name: s.name, w: s.w, h: s.h }; }),
      regions: S.regions,
      activeId: S.activeId,
      selId: S.selId
    });
  }
  function pushUndo() {
    UNDO.push(snapshot());
    if (UNDO.length > 50) UNDO.shift();
    REDO.length = 0;
  }
  function applySnapshot(str) {
    var d = null;
    try { d = JSON.parse(str); } catch (e) { d = null; }
    if (!d) return;
    S.sources = (d.sources || []).filter(function (s) { return IMG[s.id] || sourceById(s.id); });
    S.regions = d.regions || [];
    S.activeId = sourceById(d.activeId) ? d.activeId : (S.sources[0] ? S.sources[0].id : '');
    S.selId = regionById(d.selId) ? d.selId : '';
    fitView();
    syncUI();
    saveNow();
  }
  function undo() {
    if (!UNDO.length) { status('没有可撤销的操作'); return; }
    REDO.push(snapshot());
    applySnapshot(UNDO.pop());
    status('已撤销');
  }
  function redo() {
    if (!REDO.length) { status('没有可重做的操作'); return; }
    UNDO.push(snapshot());
    applySnapshot(REDO.pop());
    status('已重做');
  }

  /* ---------------- 区域 ---------------- */

  function addRegion(data) {
    if (S.regions.length >= MAX_REG) return null;
    var r = {
      id: uid('r'),
      name: String((data && data.name) || ('特征 ' + (S.regions.length + 1))),
      note: String((data && data.note) || ''),
      srcId: String((data && data.srcId) || S.activeId),
      box: (data && data.box ? data.box : [0.35, 0.35, 0.3, 0.3]).map(function (v) { return clamp(num(v, 0), 0, 1); })
    };
    S.regions.push(r);
    return r;
  }
  function removeRegion(id, noUndo) {
    var r = regionById(id);
    if (!r) return;
    if (!noUndo) pushUndo();
    S.regions = S.regions.filter(function (x) { return x.id !== id; });
    if (S.selId === id) S.selId = '';
    syncUI();
    saveSoon();
  }
  function moveRegion(id, dir) {
    var i = S.regions.findIndex(function (r) { return r.id === id; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= S.regions.length) return;
    pushUndo();
    var t = S.regions[i];
    S.regions[i] = S.regions[j];
    S.regions[j] = t;
    syncUI();
    saveSoon();
  }
  function selectRegion(id) {
    S.selId = id || '';
    var rows = root.querySelectorAll('[data-region]');
    Array.prototype.forEach.call(rows, function (el) {
      el.classList.toggle('sel', el.getAttribute('data-region') === S.selId);
    });
    renderInspector();
    draw();
  }

  /* ---------------- 界面渲染 ---------------- */

  function renderSources() {
    if (!E.srcs) return;
    var html = '';
    S.sources.forEach(function (s, i) {
      var url = IMG[s.id] || '';
      html += '<div class="featlab-src' + (s.id === S.activeId ? ' on' : '') + '" data-src="' + s.id + '">' +
        '<span class="featlab-src-thumb">' + (url ? '<img src="' + url + '" alt="">' : '<i>…</i>') + '</span>' +
        '<span class="featlab-src-meta"><b>图' + (i + 1) + ' · ' + esc(s.name) + '</b><i>' + s.w + '×' + s.h + '</i></span>' +
        '<button type="button" class="featlab-x" data-ract="del-src" data-src="' + s.id + '" title="移除这张图">×</button>' +
        '</div>';
    });
    if (S.sources.length < MAX_SRC) {
      html += '<button type="button" class="featlab-src-add" data-act="import">＋ 添加源图</button>';
    }
    E.srcs.innerHTML = html;
    E.srcHint.textContent = S.sources.length + ' / ' + MAX_SRC + ' 张';
  }

  function renderList() {
    if (!E.list) return;
    if (!S.regions.length) {
      E.list.innerHTML = '<div class="featlab-none">还没有特征区域。<br>用「框选」工具在图上拖一个框，或点「AI 提取特征」。</div>';
    } else {
      var html = '';
      S.regions.forEach(function (r, i) {
        var si = sourceIndex(r.srcId);
        var b = r.box;
        html += '<div class="featlab-row' + (r.id === S.selId ? ' sel' : '') + '" data-region="' + r.id + '">' +
          '<span class="featlab-num" style="--c:' + regionColor(i) + '">' + (i + 1) + '</span>' +
          '<span class="featlab-row-main">' +
            '<input class="featlab-row-name" data-rename="' + r.id + '" value="' + esc(r.name) + '" spellcheck="false">' +
            /* 每一格自己那一句标注就写在这里，整段标注由这些句子拼出来 */
            '<input class="featlab-row-note" data-note="' + r.id + '" value="' + esc(r.note || '') +
              '" spellcheck="false" placeholder="写这一格的标注（留空用名称）" title="这一格在整段标注里怎么写">' +
            '<i>图' + (si + 1) + ' · ' + Math.round(b[0] * 100) + ',' + Math.round(b[1] * 100) + ' · ' +
              Math.round(b[2] * 100) + '×' + Math.round(b[3] * 100) + '%</i>' +
          '</span>' +
          '<span class="featlab-row-acts">' +
            '<button type="button" data-ract="up" title="上移">↑</button>' +
            '<button type="button" data-ract="down" title="下移">↓</button>' +
            '<button type="button" data-ract="del" title="删除">×</button>' +
          '</span>' +
        '</div>';
      });
      E.list.innerHTML = html;
    }
    E.count.textContent = S.regions.length + ' / ' + MAX_REG;
  }

  function edgeGroup(side, label) {
    return '<span class="featlab-edgegrp"><b>' + label + '</b>' +
      '<button type="button" data-edge="' + side + '" data-dir="-1" title="' + label + '边向内收 ' + S.edgeStep + 'px">−</button>' +
      '<button type="button" data-edge="' + side + '" data-dir="1" title="' + label + '边向外扩 ' + S.edgeStep + 'px">＋</button>' +
      '</span>';
  }

  function renderInspector() {
    if (!E.inspect) return;
    var r = regionById(S.selId);
    if (!r) {
      E.inspect.innerHTML = '<div class="featlab-insp-empty">' +
        '<b>画布</b><span>V 选择 / R 框选 / H 平移 · 滚轮缩放 · 空格拖动画布 · 选中区域后可拖动边角或按像素微调边界（方向键移动，Alt+方向键调边）</span></div>';
      return;
    }
    var i = S.regions.indexOf(r);
    var si = sourceIndex(r.srcId);
    var src = sourceById(r.srcId);
    var b = r.box;
    var pw = src ? Math.round(b[2] * src.w) : 0;
    var ph = src ? Math.round(b[3] * src.h) : 0;
    E.inspect.innerHTML =
      '<div class="featlab-insp-head"><span class="featlab-num" style="--c:' + regionColor(i) + '">' + (i + 1) + '</span>' +
        '<b>区域 ' + (i + 1) + '</b><i id="featlabInspMeta">图' + (si + 1) + ' · ' + pw + '×' + ph + ' px · 拖动边框或角点调整</i></div>' +
      '<div class="featlab-insp-fields">' +
        '<label class="wide"><span>名称</span><input id="featlabSelName" value="' + esc(r.name) + '" spellcheck="false"></label>' +
        '<label><span>X%</span><input type="number" data-box="0" value="' + round(b[0] * 100, 1) + '" step="0.5" min="0" max="100"></label>' +
        '<label><span>Y%</span><input type="number" data-box="1" value="' + round(b[1] * 100, 1) + '" step="0.5" min="0" max="100"></label>' +
        '<label><span>W%</span><input type="number" data-box="2" value="' + round(b[2] * 100, 1) + '" step="0.5" min="0.5" max="100"></label>' +
        '<label><span>H%</span><input type="number" data-box="3" value="' + round(b[3] * 100, 1) + '" step="0.5" min="0.5" max="100"></label>' +
        '<button type="button" class="featlab-btn sm" data-act="focus-region">定位</button>' +
        '<button type="button" class="featlab-btn sm ghost" data-act="del-region">删除</button>' +
      '</div>' +
      '<div class="featlab-edge">' +
        '<span class="featlab-edge-lbl">边界</span>' +
        '<span class="featlab-stepgrp">' +
          [1, 5, 10].map(function (n) {
            return '<button type="button" data-step="' + n + '"' + (S.edgeStep === n ? ' class="on"' : '') + '>' + n + 'px</button>';
          }).join('') +
        '</span>' +
        '<button type="button" class="featlab-btn sm" data-act="edge-expand" title="四边同时向外扩 ' + S.edgeStep + 'px">外扩</button>' +
        '<button type="button" class="featlab-btn sm" data-act="edge-shrink" title="四边同时向内收 ' + S.edgeStep + 'px">内缩</button>' +
        '<button type="button" class="featlab-btn sm" data-act="edge-square" title="按中心调成 1:1（图集格子是正方形，后面裁切不会跑偏）">1:1</button>' +
        '<label class="featlab-check"><input type="checkbox" id="featlabLock"' + (S.lockRatio ? ' checked' : '') + '> 锁比例</label>' +
        '<span class="featlab-edgepad">' +
          edgeGroup('l', '左') + edgeGroup('t', '上') + edgeGroup('r', '右') + edgeGroup('b', '下') +
        '</span>' +
      '</div>';
  }

  function updateMeta() {
    if (E.empty) E.empty.classList.toggle('hide', S.sources.length > 0);
    var total = S.opt.cell * 3 + S.opt.gap * 2;
    if (E.atlasInfo) E.atlasInfo.textContent = '3×3 · ' + total + 'px';
    var src = activeSource();
    if (E.hudInfo) {
      E.hudInfo.textContent = src ? ('图' + (sourceIndex(src.id) + 1) + ' · ' + src.w + '×' + src.h + ' · ' + S.regions.length + '/9 格') : '';
    }
  }

  /* 一格在标注里怎么写：优先用这一格自己写的描述，没写就退回名称。
   * 这样「逐格编写 → 整段自动生成」不需要维护两份文本。 */
  function regText(reg) {
    if (!reg) return '特征';
    var note = trimStr(reg.note);
    return note || trimStr(reg.name) || '特征';
  }

  /* 单格标注短语：「左上为图1人物的发髻」。标注全文与行右键复制共用这一份口径。 */
  function regPhrase(i, reg) {
    if (!reg) return '';
    var subject = String(S.opt.subject || '').trim() || '人物';
    return (POS[i] || ('第' + (i + 1) + '格')) + '为图' + (sourceIndex(reg.srcId) + 1) + subject + '的' + regText(reg);
  }

  function makeAnnotation() {
    if (!S.regions.length) return '3行3列 · 还没有特征区域（先框选或 AI 提取）。';
    var rows = [];
    for (var r = 0; r < 3; r++) {
      var row = [];
      for (var c = 0; c < 3; c++) {
        var k = r * 3 + c;
        var reg = S.regions[k];
        if (!reg) continue;
        row.push(regPhrase(k, reg));
      }
      if (row.length) rows.push(row.join('，'));
    }
    return '3行3列，' + rows.join('；') + '。';
  }

  function updateAnnotation() {
    if (!S.annEdited) {
      S.ann = makeAnnotation();
      if (E.ann && E.ann.value !== S.ann) E.ann.value = S.ann;
      if (E.annState) E.annState.textContent = '自动';
    } else if (E.annState) {
      E.annState.textContent = '手动';
    }
  }

  /* ---------------- 提示词（填表 → 文本） ----------------
   * 填表是唯一入口：字段改一下立刻出词，没有隐藏的模板状态。
   * 中文按自然语言串句，英文按关键词逗号串（给 ComfyUI / CLIP 用）。
   * 中文自定义词进英文会变成 <unk>，所以英文模式只映射已知词，其余计数上报。 */

  var PM_LANG_LABEL = { zh: '中文', en: '英文', both: '双语' };

  function hasCJK(s) { return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(s || '')); }
  function trimStr(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

  function enWord(group, v) {
    var s = trimStr(v);
    if (!s) return '';
    var map = PM_EN[group] || {};
    if (map[s]) return map[s];
    if (hasCJK(s)) return '';
    return s;
  }

  /* 细节可能是一串中文名词，英文模式下无法翻译：只留纯 ASCII 片段，其余计数上报。 */
  function enDetails(str) {
    var segs = String(str || '').split(/[，,、;；\n]+/);
    var keep = [], drop = 0;
    segs.forEach(function (t) {
      t = trimStr(t);
      if (!t) return;
      if (!hasCJK(t) && /^[a-z0-9][a-z0-9 \-_'()/.]*$/i.test(t)) keep.push(t);
      else drop++;
    });
    return { text: keep.join(', '), dropped: drop };
  }

  function buildPromptZh() {
    var p = S.pmt, parts = [];
    if (p.style) parts.push(p.style + '风格');
    if (trimStr(S.opt.subject)) parts.push(trimStr(S.opt.subject));
    if (p.use) parts.push(p.use);
    if (p.angle) parts.push(p.angle + '构图');
    if (trimStr(p.details)) parts.push(trimStr(p.details));
    if (p.material) parts.push(p.material + '材质');
    if (p.palette) parts.push(p.palette);
    if (p.light) parts.push(p.light);
    if (p.bg) parts.push(p.bg);
    if (p.quality && p.quality.length) parts.push(p.quality.join('、'));
    if (trimStr(p.extra)) parts.push(trimStr(p.extra));
    return parts.length ? parts.join('，') + '。' : '';
  }

  function buildPromptEn() {
    var p = S.pmt, parts = [], drop = 0;
    function add(group, val, suffix) {
      var s = trimStr(val);
      if (!s) return;
      var w = enWord(group, s);
      if (!w) { drop++; return; }
      parts.push(suffix ? w + suffix : w);
    }
    add('style', p.style);
    add('subject', S.opt.subject);
    add('use', p.use);
    add('angle', p.angle);
    var d = enDetails(p.details);
    drop += d.dropped;
    if (d.text) parts.push(d.text);
    add('material', p.material);
    add('palette', p.palette);
    add('light', p.light);
    add('bg', p.bg);
    (p.quality || []).forEach(function (q) {
      var w = enWord('q', q);
      if (w) parts.push(w); else if (trimStr(q)) drop++;
    });
    var ex = enDetails(p.extra);
    drop += ex.dropped;
    if (ex.text) parts.push(ex.text);
    return { text: parts.join(', '), dropped: drop };
  }

  function buildPromptOut() {
    var zh = buildPromptZh();
    var en = buildPromptEn();
    var lang = S.pmt.lang || 'zh';
    if (lang === 'en') {
      return { text: en.text, note: en.dropped ? '跳过 ' + en.dropped + ' 个中文词' : '' };
    }
    if (lang === 'both') {
      var seg = [];
      if (zh) seg.push('中文：' + zh);
      if (en.text) seg.push('English: ' + en.text);
      return { text: seg.join('\n\n'), note: en.dropped ? '英文侧跳过 ' + en.dropped + ' 个中文词' : '' };
    }
    return { text: zh, note: '' };
  }

  function updatePrompt() {
    if (S.pmEdited) {
      if (E.pmState) E.pmState.textContent = '手动';
      return;
    }
    var r = buildPromptOut();
    S.pmOut = r.text;
    if (E.pmOut && E.pmOut.value !== r.text) E.pmOut.value = r.text;
    if (E.pmState) E.pmState.textContent = (PM_LANG_LABEL[S.pmt.lang] || '中文') + (r.note ? ' · ' + r.note : '');
  }

  function renderChips() {
    if (!E.pmQuality) return;
    var arr = S.pmt.quality || [];
    Array.prototype.forEach.call(E.pmQuality.querySelectorAll('[data-q]'), function (b) {
      b.classList.toggle('on', arr.indexOf(b.getAttribute('data-q')) >= 0);
    });
  }

  function renderLangSeg() {
    if (!E.pmSeg) return;
    var lang = S.pmt.lang || 'zh';
    Array.prototype.forEach.call(E.pmSeg.querySelectorAll('[data-pmlang]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-pmlang') === lang);
    });
  }

  function setPmLang(lang) {
    S.pmt.lang = ['zh', 'en', 'both'].indexOf(lang) >= 0 ? lang : 'zh';
    S.pmEdited = false;
    renderLangSeg();
    updatePrompt();
    saveSoon();
  }

  function applyPmtToFields() {
    var p = S.pmt;
    if (!E.pmSubject) return;
    E.pmSubject.value = S.opt.subject || '';
    if (E.pmUse) E.pmUse.value = p.use || '图生图参考';
    if (E.pmStyle) E.pmStyle.value = p.style || '';
    E.pmAngle.value = p.angle || '';
    E.pmMaterial.value = p.material || '';
    E.pmPalette.value = p.palette || '';
    E.pmLight.value = p.light || '';
    E.pmBg.value = p.bg || '';
    E.pmDetails.value = p.details || '';
    E.pmExtra.value = p.extra || '';
    E.pmNeg.value = p.neg || '';
    if (S.pmEdited && S.pmOut && E.pmOut) E.pmOut.value = S.pmOut;
    renderChips();
    renderLangSeg();
  }

  function readPmtField(el) {
    if (!el || !el.id) return false;
    var p = S.pmt;
    switch (el.id) {
      case 'featlabPmSubject':
        /* 与「AI 提取」的主体是同一个值：改一处，标注与提取要求一起变 */
        S.opt.subject = el.value;
        if (E.subject && E.subject.value !== el.value) E.subject.value = el.value;
        updateAnnotation();
        break;
      case 'featlabPmUse': p.use = el.value; break;
      case 'featlabPmStyle': p.style = el.value; break;
      case 'featlabPmAngle': p.angle = el.value; break;
      case 'featlabPmMaterial': p.material = el.value; break;
      case 'featlabPmPalette': p.palette = el.value; break;
      case 'featlabPmLight': p.light = el.value; break;
      case 'featlabPmBg': p.bg = el.value; break;
      case 'featlabPmDetails': p.details = el.value; break;
      case 'featlabPmExtra': p.extra = el.value; break;
      case 'featlabPmNeg': p.neg = el.value; return true;   /* 负面词不进正向正文 */
      case 'featlabPmOut':
        S.pmOut = el.value;
        S.pmEdited = true;
        if (E.pmState) E.pmState.textContent = '手动';
        saveSoon();
        return true;
      default: return false;
    }
    /* 表单项只更新表单，不动正文：手改稿是用户自己写的，被表单悄悄覆盖＝丢数据。
     * 想按新表单重算，点「恢复自动」（或切输出语言）。 */
    updatePrompt();
    saveSoon();
    return true;
  }

  function toggleQuality(q) {
    var arr = S.pmt.quality || (S.pmt.quality = []);
    var i = arr.indexOf(q);
    if (i >= 0) arr.splice(i, 1); else arr.push(q);
    renderChips();
    updatePrompt();
    saveSoon();
  }

  function fillDetailsFromRegions() {
    var names = S.regions.map(function (r) { return trimStr(r.name); }).filter(Boolean);
    if (!names.length) { status('还没有特征区域，先框选或 AI 提取'); return; }
    S.pmt.details = names.join('、');
    if (E.pmDetails) E.pmDetails.value = S.pmt.details;
    S.pmEdited = false;
    updatePrompt();
    saveSoon();
    status('已把 ' + names.length + ' 个特征名填进细节');
  }

  /* ---------------- 右栏分页 ---------------- */

  function applyTab(tab) {
    var t = TAB_LIST.indexOf(tab) >= 0 ? tab : 'ext';
    S.tab = t;
    if (E.tabs) {
      Array.prototype.forEach.call(E.tabs.querySelectorAll('[data-ftab]'), function (b) {
        var on = b.getAttribute('data-ftab') === t;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    if (E.tabWrap) {
      Array.prototype.forEach.call(E.tabWrap.querySelectorAll('[data-tab]'), function (p) {
        p.classList.toggle('on', p.getAttribute('data-tab') === t);
      });
      /* 换页从头看起：上一页滚到一半的位置带过来，会让人以为表单缺了一截 */
      E.tabWrap.scrollTop = 0;
    }
    saveSoon();
  }

  function syncUI() {
    renderSources();
    renderList();
    renderInspector();
    updateMeta();
    updateAnnotation();
    updatePrompt();
    updateZoomUI();
    draw();
    schedulePreview();
    saveSoon();
  }

  /* ---------------- 状态栏 / 日志 / 忙碌 ---------------- */

  function status(msg) {
    if (E.status) E.status.textContent = msg || '就绪';
  }
  function log(msg, tone) {
    if (!E.log) return;
    var d = new Date();
    var p = function (n) { return ('0' + n).slice(-2); };
    var row = document.createElement('div');
    row.className = 'featlab-log-row' + (tone ? ' ' + tone : '');
    row.innerHTML = '<i>' + p(d.getHours()) + ':' + p(d.getMinutes()) + '</i><span>' + esc(msg) + '</span>';
    E.log.insertBefore(row, E.log.firstChild);
    while (E.log.children.length > 6) E.log.removeChild(E.log.lastChild);
  }
  function setBusyText(on, text, sub) {
    if (!E.busy) return;
    if (!on) { E.busy.hidden = true; return; }
    E.busy.hidden = false;
    if (E.busyText) E.busyText.textContent = text || '处理中…';
    if (E.busySub) E.busySub.textContent = sub || '';
  }

  async function runBusy(title, fn) {
    if (S.busy) return;
    S.busy = true;
    S.abort = new AbortController();
    setBusyText(true, title, '准备中…');
    status(title + '…');
    try {
      await fn();
    } catch (e) {
      if (e && (e._stopped || e.name === 'AbortError')) {
        log('已手动停止', 'warn');
        status('已停止');
      } else {
        log(friendly(e), 'err');
        status('失败：' + friendly(e));
      }
    } finally {
      S.busy = false;
      S.abort = null;
      setBusyText(false);
    }
  }

  /* ---------------- 表单 ---------------- */

  function applyOptToFields() {
    if (!E.req) return;
    E.req.value = S.opt.req;
    E.subject.value = S.opt.subject;
    E.scope.value = S.opt.scope === 'active' ? 'active' : 'all';
    E.verify.checked = !!S.opt.verify;
    E.cell.value = String(S.opt.cell);
    E.margin.value = String(S.opt.margin);
    E.gap.value = String(S.opt.gap);
    E.bg.value = S.opt.bg;
    E.badge.checked = !!S.opt.badge;
    E.labels.checked = !!S.opt.labels;
    if (E.ann) E.ann.value = S.ann || '';
  }

  function readOptField(el) {
    if (!el || !el.id) return;
    switch (el.id) {
      case 'featlabReq': S.opt.req = el.value; break;
      case 'featlabSubject':
        S.opt.subject = el.value;
        if (E.pmSubject && E.pmSubject.value !== el.value) E.pmSubject.value = el.value;
        updateAnnotation();
        break;
      case 'featlabScope': S.opt.scope = el.value; break;
      case 'featlabVerify': S.opt.verify = !!el.checked; break;
      case 'featlabCell': S.opt.cell = clamp(num(el.value, 512), 128, 1024); updateMeta(); break;
      case 'featlabMargin': S.opt.margin = clamp(num(el.value, 30), 0, 100); break;
      case 'featlabGap': S.opt.gap = clamp(num(el.value, 0), 0, 64); updateMeta(); break;
      case 'featlabBg': S.opt.bg = el.value || '#15181d'; break;
      case 'featlabBadge': S.opt.badge = !!el.checked; break;
      case 'featlabLabels': S.opt.labels = !!el.checked; break;
      case 'featlabAnn': S.ann = el.value; S.annEdited = true; if (E.annState) E.annState.textContent = '手动'; break;
      default: return;
    }
    updatePrompt();
    saveSoon();
    schedulePreview();
  }

  /* ---------------- 画布 ---------------- */

  function viewRect() {
    return E.viewport ? E.viewport.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 };
  }

  function resizeCanvas() {
    if (!E.canvas || !E.viewport) return;
    var r = viewRect();
    DPR = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(r.width));
    var h = Math.max(1, Math.round(r.height));
    var cw = Math.round(w * DPR);
    var ch = Math.round(h * DPR);
    if (E.canvas.width !== cw || E.canvas.height !== ch) {
      E.canvas.width = cw;
      E.canvas.height = ch;
    }
    if (!ctx) ctx = E.canvas.getContext('2d');
    draw();
  }

  function updateZoomUI() {
    if (E.zoom) E.zoom.textContent = Math.round(VIEW.s * 100) + '%';
  }

  function fitView() {
    var src = activeSource();
    var r = viewRect();
    if (!src || !src.w || !src.h || !r.width || !r.height) {
      updateZoomUI();
      draw();
      return;
    }
    var k = Math.min((r.width - 64) / src.w, (r.height - 64) / src.h);
    VIEW.s = clamp(k, 0.01, 8);
    VIEW.ox = (r.width - src.w * VIEW.s) / 2;
    VIEW.oy = (r.height - src.h * VIEW.s) / 2;
    VIEW.touched = false;
    updateZoomUI();
    draw();
  }

  function zoomAt(mx, my, factor) {
    var old = VIEW.s;
    var ns = clamp(old * factor, 0.02, 16);
    if (ns === old) return;
    VIEW.ox = mx - (mx - VIEW.ox) * (ns / old);
    VIEW.oy = my - (my - VIEW.oy) * (ns / old);
    VIEW.s = ns;
    VIEW.touched = true;
    updateZoomUI();
    draw();
  }

  function screenToImg(cx, cy) {
    var r = viewRect();
    return { x: (cx - r.left - VIEW.ox) / VIEW.s, y: (cy - r.top - VIEW.oy) / VIEW.s };
  }
  function clampToImg(p) {
    var src = activeSource();
    if (!src) return p;
    return { x: clamp(p.x, 0, src.w), y: clamp(p.y, 0, src.h) };
  }
  function regionScreenRect(r) {
    var src = sourceById(r.srcId);
    if (!src) return { x: 0, y: 0, w: 0, h: 0 };
    return {
      x: r.box[0] * src.w * VIEW.s + VIEW.ox,
      y: r.box[1] * src.h * VIEW.s + VIEW.oy,
      w: r.box[2] * src.w * VIEW.s,
      h: r.box[3] * src.h * VIEW.s
    };
  }
  function rgba(hex, a) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return 'rgba(91,143,217,' + a + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function roundRect(g, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function drawGrid(g, w, h) {
    g.save();
    g.strokeStyle = 'rgba(255,255,255,.035)';
    g.lineWidth = 1;
    var step = 36;
    for (var x = (VIEW.ox % step); x < w; x += step) {
      g.beginPath(); g.moveTo(Math.round(x) + .5, 0); g.lineTo(Math.round(x) + .5, h); g.stroke();
    }
    for (var y = (VIEW.oy % step); y < h; y += step) {
      g.beginPath(); g.moveTo(0, Math.round(y) + .5); g.lineTo(w, Math.round(y) + .5); g.stroke();
    }
    g.restore();
  }

  function drawBox(g, reg, idx, selected) {
    var rect = regionScreenRect(reg);
    var color = regionColor(idx);
    g.save();
    g.fillStyle = rgba(color, selected ? 0.16 : 0.09);
    g.fillRect(rect.x, rect.y, rect.w, rect.h);
    g.strokeStyle = color;
    g.lineWidth = selected ? 2 : 1.3;
    g.setLineDash(selected ? [] : [7, 4]);
    g.strokeRect(rect.x + .5, rect.y + .5, Math.max(0, rect.w - 1), Math.max(0, rect.h - 1));
    g.setLineDash([]);
    /* 左上序号 */
    var rad = selected ? 10 : 8.5;
    g.beginPath();
    g.arc(rect.x + rad + 2, rect.y + rad + 2, rad, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.fillStyle = '#fff';
    g.font = '600 ' + (selected ? 11 : 10) + 'px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(idx + 1), rect.x + rad + 2, rect.y + rad + 3);
    /* 名称条 */
    var label = String(reg.name || '未命名');
    g.font = '500 11px system-ui, sans-serif';
    var tw = g.measureText(label).width;
    var chipW = Math.min(rect.w - 4, tw + 14);
    if (chipW > 18) {
      var chipY = rect.y - 21;
      if (chipY < 2) chipY = rect.y + 3;
      var chipX = clamp(rect.x, 2, Math.max(2, viewRect().width - chipW - 4));
      g.fillStyle = rgba(color, 0.92);
      roundRect(g, chipX, chipY, chipW, 18, 5);
      g.fill();
      g.fillStyle = '#fff';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.save();
      g.beginPath();
      g.rect(chipX + 6, chipY, chipW - 10, 18);
      g.clip();
      g.fillText(label, chipX + 7, chipY + 9.5);
      g.restore();
    }
    if (selected) {
      var hs = 4;
      var pts = [
        [rect.x, rect.y], [rect.x + rect.w / 2, rect.y], [rect.x + rect.w, rect.y],
        [rect.x + rect.w, rect.y + rect.h / 2], [rect.x + rect.w, rect.y + rect.h],
        [rect.x + rect.w / 2, rect.y + rect.h], [rect.x, rect.y + rect.h],
        [rect.x, rect.y + rect.h / 2]
      ];
      pts.forEach(function (p) {
        g.fillStyle = '#fff';
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.fillRect(p[0] - hs, p[1] - hs, hs * 2, hs * 2);
        g.strokeRect(p[0] - hs, p[1] - hs, hs * 2, hs * 2);
      });
    }
    g.restore();
  }

  function draw() {
    if (!E.canvas || !E.viewport) return;
    if (!ctx) ctx = E.canvas.getContext('2d');
    var r = viewRect();
    var w = r.width, h = r.height;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#12161d';
    ctx.fillRect(0, 0, w, h);
    drawGrid(ctx, w, h);
    var src = activeSource();
    if (src && src._img) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,.5)';
      ctx.shadowBlur = 24;
      ctx.drawImage(src._img, VIEW.ox, VIEW.oy, src.w * VIEW.s, src.h * VIEW.s);
      ctx.restore();
      /* 画布外的部分压暗，避免误以为图变小了 */
      ctx.save();
      ctx.fillStyle = 'rgba(10,13,18,.55)';
      var ix = VIEW.ox, iy = VIEW.oy, iw = src.w * VIEW.s, ih = src.h * VIEW.s;
      if (ix > 0) ctx.fillRect(0, 0, ix, h);
      if (iy > 0) ctx.fillRect(0, 0, w, iy);
      if (ix + iw < w) ctx.fillRect(ix + iw, 0, w - ix - iw, h);
      if (iy + ih < h) ctx.fillRect(0, iy + ih, w, h - iy - ih);
      ctx.restore();

      activeRegions().forEach(function (reg) {
        var idx = S.regions.indexOf(reg);
        drawBox(ctx, reg, idx, reg.id === S.selId);
      });
      if (drag && drag.mode === 'create') {
        var a = drag.start, b = drag.cur;
        var x = Math.min(a.x, b.x) * VIEW.s + VIEW.ox;
        var y = Math.min(a.y, b.y) * VIEW.s + VIEW.oy;
        var bw = Math.abs(b.x - a.x) * VIEW.s;
        var bh = Math.abs(b.y - a.y) * VIEW.s;
        ctx.save();
        ctx.fillStyle = 'rgba(245,196,81,.14)';
        ctx.strokeStyle = '#f5c451';
        ctx.lineWidth = 1.6;
        ctx.setLineDash([6, 4]);
        ctx.fillRect(x, y, bw, bh);
        ctx.strokeRect(x + .5, y + .5, bw, bh);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(245,196,81,.95)';
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.fillText(Math.round(bw / VIEW.s) + ' × ' + Math.round(bh / VIEW.s) + ' px', x + 4, Math.max(12, y - 6));
        ctx.restore();
      }
    } else if (src) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,.5)';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('图像加载中…', w / 2, h / 2);
      ctx.restore();
    }
  }

  /* ---------------- 命中 / 光标 ---------------- */

  function zoneIn(rect, x, y) {
    if (rect.w <= 0 || rect.h <= 0) return null;
    var h = 7;
    var inX = x >= rect.x - h && x <= rect.x + rect.w + h;
    var inY = y >= rect.y - h && y <= rect.y + rect.h + h;
    if (!inX || !inY) return null;
    var nearL = Math.abs(x - rect.x) <= h;
    var nearR = Math.abs(x - (rect.x + rect.w)) <= h;
    var nearT = Math.abs(y - rect.y) <= h;
    var nearB = Math.abs(y - (rect.y + rect.h)) <= h;
    if (nearL && nearT) return 'nw';
    if (nearR && nearT) return 'ne';
    if (nearL && nearB) return 'sw';
    if (nearR && nearB) return 'se';
    if (nearT) return 'n';
    if (nearB) return 's';
    if (nearL) return 'w';
    if (nearR) return 'e';
    if (x > rect.x && x < rect.x + rect.w && y > rect.y && y < rect.y + rect.h) return 'move';
    return null;
  }

  function hitTest(cx, cy) {
    var r = viewRect();
    var x = cx - r.left, y = cy - r.top;
    var regs = activeRegions();
    for (var i = regs.length - 1; i >= 0; i--) {
      var rect = regionScreenRect(regs[i]);
      var zone = zoneIn(rect, x, y);
      if (zone) return { id: regs[i].id, zone: zone };
    }
    return null;
  }

  function cursorForHit(hit) {
    if (S.tool === 'pan') return 'grab';
    if (S.tool === 'add') return 'crosshair';
    if (!hit) return 'default';
    if (hit.zone === 'move') return 'move';
    if (hit.zone === 'nw' || hit.zone === 'se') return 'nwse-resize';
    if (hit.zone === 'ne' || hit.zone === 'sw') return 'nesw-resize';
    if (hit.zone === 'n' || hit.zone === 's') return 'ns-resize';
    return 'ew-resize';
  }

  function updateCanvasCursor(e) {
    if (!E.canvas) return;
    if (drag) return;
    if (spaceDown) { E.canvas.style.cursor = 'grab'; return; }
    if (!e) { E.canvas.style.cursor = S.tool === 'pan' ? 'grab' : (S.tool === 'add' ? 'crosshair' : 'default'); return; }
    E.canvas.style.cursor = cursorForHit(hitTest(e.clientX, e.clientY));
  }

  function setTool(t) {
    S.tool = t === 'add' || t === 'pan' ? t : 'select';
    root.querySelectorAll('[data-tool]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tool') === S.tool);
    });
    if (!drag) updateCanvasCursor();
    status(S.tool === 'add' ? '框选：在图上拖出特征区域' : (S.tool === 'pan' ? '平移：拖动画布' : '选择：拖动区域或角点'));
  }

  /* ---------------- 指针交互 ---------------- */

  function clampBox(b) {
    var x = clamp(b[0], 0, 1), y = clamp(b[1], 0, 1);
    var w = clamp(b[2], 0.002, 1 - x), h = clamp(b[3], 0.002, 1 - y);
    return [x, y, w, h];
  }

  /* ---- 边界精确调整：一律以「图像像素」为单位，再换算回归一化 ---- */

  function boxPx(reg) {
    var src = sourceById(reg.srcId);
    if (!src) return { w: 0, h: 0, x: 0, y: 0 };
    return {
      x: Math.round(reg.box[0] * src.w),
      y: Math.round(reg.box[1] * src.h),
      w: Math.round(reg.box[2] * src.w),
      h: Math.round(reg.box[3] * src.h)
    };
  }

  function refreshInspMeta() {
    var r = regionById(S.selId);
    var el = $('#featlabInspMeta');
    if (!r || !el) return;
    var p = boxPx(r);
    el.textContent = '图' + (sourceIndex(r.srcId) + 1) + ' · ' + p.w + '×' + p.h + ' px · ' +
      '拖动边框或角点调整';
  }

  /* 只动一条边：对边固定，最小边长 MIN_BOX_PX，越界夹回图内。 */
  function nudgeEdge(reg, side, px) {
    var src = sourceById(reg.srcId);
    if (!src || !px) return false;
    var b = reg.box.slice();
    var minW = MIN_BOX_PX / src.w, minH = MIN_BOX_PX / src.h;
    var dw = px / src.w, dh = px / src.h;
    if (side === 'l') {
      var nx = clamp(b[0] + dw, 0, b[0] + b[2] - minW);
      b[2] = b[2] + (b[0] - nx);
      b[0] = nx;
    } else if (side === 'r') {
      b[2] = clamp(b[2] + dw, minW, 1 - b[0]);
    } else if (side === 't') {
      var ny = clamp(b[1] + dh, 0, b[1] + b[3] - minH);
      b[3] = b[3] + (b[1] - ny);
      b[1] = ny;
    } else if (side === 'b') {
      b[3] = clamp(b[3] + dh, minH, 1 - b[1]);
    } else {
      return false;
    }
    var nb = clampBox(b);
    if (nb.join() === reg.box.join()) return false;
    reg.box = nb;
    return true;
  }

  function expandShrink(reg, dir) {
    var src = sourceById(reg.srcId);
    if (!src) return false;
    var step = S.edgeStep * dir;
    var before = reg.box.join();
    ['l', 't', 'r', 'b'].forEach(function (s) { nudgeEdge(reg, s, s === 'l' || s === 't' ? -step : step); });
    return reg.box.join() !== before;
  }

  /* 以中心为准调成 1:1（单位：像素）。图集每格是正方形，先切成正方形后面裁切不跑偏。 */
  function squareBox(reg) {
    var src = sourceById(reg.srcId);
    if (!src) return false;
    var p = boxPx(reg);
    var side = Math.max(p.w, p.h, MIN_BOX_PX);
    var cx = reg.box[0] * src.w + reg.box[2] * src.w / 2;
    var cy = reg.box[1] * src.h + reg.box[3] * src.h / 2;
    var w = Math.min(side, src.w) / src.w;
    var h = Math.min(side, src.h) / src.h;
    var x = clamp(cx / src.w - w / 2, 0, 1 - w);
    var y = clamp(cy / src.h - h / 2, 0, 1 - h);
    var nb = clampBox([x, y, w, h]);
    if (nb.join() === reg.box.join()) return false;
    reg.box = nb;
    return true;
  }

  /* 微调统一入口：一次操作一个撤销点，避免连点十次要靠十次 Ctrl+Z 退回去 */
  function setEdgeStep(n) {
    var v = Number(n);
    S.edgeStep = [1, 5, 10].indexOf(v) >= 0 ? v : 1;
    if (E.inspect) {
      Array.prototype.forEach.call(E.inspect.querySelectorAll('[data-step]'), function (b) {
        b.classList.toggle('on', Number(b.getAttribute('data-step')) === S.edgeStep);
      });
    }
    /* 按钮 title 里写着步进值，重画一遍才能同步（不重画会显示旧数字） */
    if (regionById(S.selId)) renderInspector();
    saveSoon();
    status('边界步进 ' + S.edgeStep + 'px');
  }

  function tuneBox(fn, label) {
    var reg = regionById(S.selId);
    if (!reg) { status('先选中一个区域'); return; }
    pushUndo();
    var ok = fn(reg);
    if (!ok) { UNDO.pop(); status('已经到边界了'); return; }
    syncInspectorBoxValues();
    refreshInspMeta();
    draw();
    schedulePreview();
    saveSoon();
    status((label || '已调整边界') + ' · ' + boxPx(reg).w + '×' + boxPx(reg).h + ' px');
  }

  function syncInspectorBoxValues() {
    var r = regionById(S.selId);
    if (!r || !E.inspect) return;
    var inputs = E.inspect.querySelectorAll('[data-box]');
    Array.prototype.forEach.call(inputs, function (el) {
      if (document.activeElement === el) return;
      var k = Number(el.getAttribute('data-box'));
      el.value = round(r.box[k] * 100, 1);
    });
  }

  function onPointerDown(e) {
    if (e.button === 1 || (e.button === 0 && (S.tool === 'pan' || spaceDown))) {
      e.preventDefault();
      try { E.canvas.setPointerCapture(e.pointerId); } catch (_) {}
      drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: VIEW.ox, oy: VIEW.oy };
      E.canvas.style.cursor = 'grabbing';
      return;
    }
    if (e.button !== 0) return;
    var src = activeSource();
    if (!src || !src._img) return;
    if (S.tool === 'add') {
      var p = clampToImg(screenToImg(e.clientX, e.clientY));
      drag = { mode: 'create', start: p, cur: p };
      try { E.canvas.setPointerCapture(e.pointerId); } catch (_) {}
      draw();
      return;
    }
    var hit = hitTest(e.clientX, e.clientY);
    if (!hit) {
      selectRegion('');
      return;
    }
    if (S.selId !== hit.id) selectRegion(hit.id);
    pushUndo();
    var reg = regionById(hit.id);
    drag = {
      mode: hit.zone === 'move' ? 'move' : 'resize',
      id: hit.id,
      zone: hit.zone,
      startBox: reg.box.slice(),
      startImg: clampToImg(screenToImg(e.clientX, e.clientY))
    };
    try { E.canvas.setPointerCapture(e.pointerId); } catch (_) {}
  }

  function onPointerMove(e) {
    if (!drag) {
      updateCanvasCursor(e);
      var src0 = activeSource();
      if (src0 && src0._img && E.hudPos) {
        var p0 = screenToImg(e.clientX, e.clientY);
        if (p0.x >= 0 && p0.y >= 0 && p0.x <= src0.w && p0.y <= src0.h) {
          E.hudPos.textContent = Math.round(p0.x) + ', ' + Math.round(p0.y) + ' px · ' +
            Math.round(p0.x / src0.w * 100) + '%, ' + Math.round(p0.y / src0.h * 100) + '%';
        } else {
          E.hudPos.textContent = '—';
        }
      }
      return;
    }
    if (drag.mode === 'pan') {
      VIEW.ox = drag.ox + (e.clientX - drag.sx);
      VIEW.oy = drag.oy + (e.clientY - drag.sy);
      VIEW.touched = true;
      draw();
      return;
    }
    var src = activeSource();
    if (!src) return;
    var p = clampToImg(screenToImg(e.clientX, e.clientY));
    if (drag.mode === 'create') {
      drag.cur = p;
      draw();
      return;
    }
    var reg = regionById(drag.id);
    if (!reg) return;
    var dx = (p.x - drag.startImg.x) / src.w;
    var dy = (p.y - drag.startImg.y) / src.h;
    var b = drag.startBox.slice();
    if (drag.mode === 'move') {
      b[0] = clamp(b[0] + dx, 0, 1 - b[2]);
      b[1] = clamp(b[1] + dy, 0, 1 - b[3]);
    } else if (S.lockRatio && drag.zone.length === 2) {
      /* 锁比例：以「对边对角」为锚点，宽高比按起始框的像素比例；
       * 取宽高里较大的那个方向，保证指针始终落在框内。 */
      var z0 = drag.zone;
      var ratio = (drag.startBox[2] * src.w) / Math.max(1e-6, drag.startBox[3] * src.h);
      var sx = drag.startBox[0] * src.w, sy = drag.startBox[1] * src.h;
      var sw = drag.startBox[2] * src.w, sh = drag.startBox[3] * src.h;
      var rawW = z0.indexOf('w') >= 0 ? (sx + sw) - p.x : p.x - sx;
      var rawH = z0.indexOf('n') >= 0 ? (sy + sh) - p.y : p.y - sy;
      var w = Math.max(MIN_BOX_PX, Math.max(rawW, rawH * ratio));
      var h = w / ratio;
      var nx2 = z0.indexOf('w') >= 0 ? (sx + sw) - w : sx;
      var ny2 = z0.indexOf('n') >= 0 ? (sy + sh) - h : sy;
      b = clampBox([nx2 / src.w, ny2 / src.h, w / src.w, h / src.h]);
    } else {
      var z = drag.zone;
      var minW = 6 / src.w, minH = 6 / src.h;
      if (z.indexOf('w') >= 0) { var nw = b[2] - dx; if (nw >= minW) { b[0] += dx; b[2] = nw; } }
      if (z.indexOf('e') >= 0) { b[2] = Math.max(minW, b[2] + dx); }
      if (z.indexOf('n') >= 0) { var nh = b[3] - dy; if (nh >= minH) { b[1] += dy; b[3] = nh; } }
      if (z.indexOf('s') >= 0) { b[3] = Math.max(minH, b[3] + dy); }
      b = clampBox(b);
    }
    reg.box = b;
    syncInspectorBoxValues();
    draw();
  }

  function onPointerUp(e) {
    if (!drag) return;
    var mode = drag.mode;
    var d = drag;
    drag = null;
    try { E.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (mode === 'create') {
      var src = activeSource();
      if (src) {
        var w = Math.abs(d.cur.x - d.start.x);
        var h = Math.abs(d.cur.y - d.start.y);
        if (w >= 4 && h >= 4) {
          pushUndo();
          var box = [
            Math.min(d.start.x, d.cur.x) / src.w,
            Math.min(d.start.y, d.cur.y) / src.h,
            w / src.w,
            h / src.h
          ];
          var reg = addRegion({ srcId: src.id, box: clampBox(box) });
          if (reg) {
            S.selId = reg.id;
            log('新增区域「' + reg.name + '」', 'ok');
            status('已新增区域，可在下方改名或微调边框');
          }
          syncUI();
          saveSoon();
        } else {
          draw();
        }
      }
    } else if (mode === 'move' || mode === 'resize') {
      syncUI();
      saveNow();
    } else {
      updateCanvasCursor(e);
    }
  }

  function onWheel(e) {
    if (!activeSource() || !activeSource()._img) return;
    e.preventDefault();
    var r = viewRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }

  /* ---------------- 键盘 / 粘贴 ---------------- */

  function appVisible() {
    var win = root && root.closest('.os-win');
    return !!win && !win.classList.contains('hidden');
  }

  function onKeyDown(e) {
    if (!appVisible()) return;
    if (isTyping(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    var k = String(e.key || '').toLowerCase();
    var mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (k === 'delete' || k === 'backspace') {
      if (S.selId) { e.preventDefault(); removeRegion(S.selId); }
      return;
    }
    /* 方向键：微调选中区域。Alt 按住时改为拉那条边（默认外扩，Shift 反向内收）；
     * 不加 Alt 时按住 Shift 是 ×10 步进。步进值就是检查器上的 1/5/10px。 */
    var arrow = { arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down' }[k];
    if (arrow) {
      if (!S.selId) return;
      e.preventDefault();
      var step = S.edgeStep * (e.shiftKey && !e.altKey ? 10 : 1);
      if (e.altKey) {
        var sideOf = { left: 'l', right: 'r', up: 't', down: 'b' }[arrow];
        var outward = sideOf === 'l' || sideOf === 't' ? -1 : 1;
        var delta = (e.shiftKey ? -outward : outward) * S.edgeStep;
        tuneBox(function (reg) { return nudgeEdge(reg, sideOf, delta); }, '已调整' + ({ l: '左', r: '右', t: '上', b: '下' }[sideOf]) + '边');
      } else {
        tuneBox(function (reg) {
          var src = sourceById(reg.srcId);
          if (!src) return false;
          var ddx = arrow === 'left' ? -step / src.w : (arrow === 'right' ? step / src.w : 0);
          var ddy = arrow === 'up' ? -step / src.h : (arrow === 'down' ? step / src.h : 0);
          var nb = clampBox([reg.box[0] + ddx, reg.box[1] + ddy, reg.box[2], reg.box[3]]);
          if (nb.join() === reg.box.join()) return false;
          reg.box = nb;
          return true;
        }, '已移动');
      }
      return;
    }
    if (e.key === '[' ) { e.preventDefault(); setEdgeStep(S.edgeStep === 10 ? 5 : (S.edgeStep === 5 ? 1 : 1)); return; }
    if (e.key === ']' ) { e.preventDefault(); setEdgeStep(S.edgeStep === 1 ? 5 : (S.edgeStep === 5 ? 10 : 10)); return; }
    if (k === 'escape') { drag = null; ctxHide(); selectRegion(''); draw(); updateCanvasCursor(); return; }
    if (k === 'v') { setTool('select'); return; }
    if (k === 'r') { setTool('add'); return; }
    if (k === 'h') { setTool('pan'); return; }
    if (k === 'f') { fitView(); return; }
    if (e.key === ' ') {
      spaceDown = true;
      e.preventDefault();
      updateCanvasCursor();
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ') {
      spaceDown = false;
      updateCanvasCursor();
    }
  }

  function onPaste(e) {
    if (!appVisible() || !e.clipboardData) return;
    var files = [];
    var items = e.clipboardData.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      importFiles(files);
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function doAction(act) {
    switch (act) {
      case 'import': E.file && E.file.click(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'zoom-in': zoomAt(viewRect().width / 2, viewRect().height / 2, 1.2); break;
      case 'zoom-out': zoomAt(viewRect().width / 2, viewRect().height / 2, 1 / 1.2); break;
      case 'fit': fitView(); break;
      case 'add-region':
        if (!activeSource()) { status('先导入一张源图'); break; }
        pushUndo();
        var nr = addRegion({});
        if (nr) { S.selId = nr.id; }
        syncUI();
        saveSoon();
        status('已新增区域，拖动边框或改名');
        break;
      case 'clear-regions':
        if (!S.regions.length) break;
        if (!window.confirm('清空全部 ' + S.regions.length + ' 个特征区域？可以用 Ctrl+Z 撤销。')) break;
        pushUndo();
        S.regions = [];
        S.selId = '';
        syncUI();
        saveSoon();
        break;
      case 'focus-region': focusRegion(); break;
      case 'del-region':
        if (S.selId) removeRegion(S.selId);
        break;
      case 'ai-extract': aiExtract(); break;
      case 'ai-name': aiName(); break;
      case 'ai-verify': aiVerify(); break;
      case 'build': buildAction(); break;
      case 'copy-atlas': copyAtlasImage(); break;
      case 'export-png': exportPNG(); break;
      case 'export-json': exportJSON(); break;
      case 'copy-ann': copyAnnotation(); break;
      case 'copy-prompt': copyPrompt(); break;
      case 'copy-negative': copyNegative(); break;
      case 'pm-regions': fillDetailsFromRegions(); break;
      case 'pm-reset':
        S.pmEdited = false;
        updatePrompt();
        saveSoon();
        status('提示词已恢复自动生成');
        break;
      case 'edge-expand': tuneBox(function (reg) { return expandShrink(reg, 1); }, '四边外扩'); break;
      case 'edge-shrink': tuneBox(function (reg) { return expandShrink(reg, -1); }, '四边内缩'); break;
      case 'edge-square': tuneBox(function (reg) { return squareBox(reg); }, '已调成 1:1'); break;
      case 'auto-ann':
        S.annEdited = false;
        updateAnnotation();
        saveSoon();
        status('标注已恢复自动生成');
        break;
      case 'cancel-ai':
        if (S.abort) { try { S.abort.abort(); } catch (_) {} status('正在停止…'); }
        break;
      default: break;
    }
  }

  function focusRegion() {
    var r = regionById(S.selId);
    if (!r) return;
    if (r.srcId !== S.activeId) setActive(r.srcId);
    var src = activeSource();
    var vw = viewRect().width, vh = viewRect().height;
    VIEW.s = clamp(Math.min(vw * 0.5 / Math.max(1, r.box[2] * src.w), vh * 0.5 / Math.max(1, r.box[3] * src.h)), 0.05, 12);
    VIEW.ox = vw / 2 - (r.box[0] + r.box[2] / 2) * src.w * VIEW.s;
    VIEW.oy = vh / 2 - (r.box[1] + r.box[3] / 2) * src.h * VIEW.s;
    VIEW.touched = true;
    updateZoomUI();
    draw();
  }

  function bindEvents() {
    E.srcs = $('#featlabSrcs');
    E.list = $('#featlabList');
    E.inspect = $('#featlabInspect');
    E.viewport = $('#featlabViewport');
    E.canvas = $('#featlabCanvas');
    E.empty = $('#featlabEmpty');
    E.busy = $('#featlabBusy');
    E.busyText = $('#featlabBusyText');
    E.busySub = $('#featlabBusySub');
    E.hudPos = $('#featlabHudPos');
    E.hudInfo = $('#featlabHudInfo');
    E.zoom = $('#featlabZoom');
    E.file = $('#featlabFile');
    E.count = $('#featlabCount');
    E.srcHint = $('#featlabSrcHint');
    E.atlasInfo = $('#featlabAtlasInfo');
    E.preview = $('#featlabPreview');
    E.previewHint = $('#featlabPreviewHint');
    E.ann = $('#featlabAnn');
    E.annState = $('#featlabAnnState');
    E.log = $('#featlabLog');
    E.status = $('#featlabStatus');
    E.req = $('#featlabReq');
    E.subject = $('#featlabSubject');
    E.scope = $('#featlabScope');
    E.verify = $('#featlabVerify');
    E.cell = $('#featlabCell');
    E.margin = $('#featlabMargin');
    E.gap = $('#featlabGap');
    E.bg = $('#featlabBg');
    E.badge = $('#featlabBadge');
    E.labels = $('#featlabLabels');
    E.previewWrap = $('#featlabPreviewWrap');
    E.tabs = root.querySelector('.featlab-tabs');
    E.tabWrap = root.querySelector('.featlab-tabwrap');
    E.ctx = $('#featlabCtx');
    E.panel = root.querySelector('.featlab-panel');
    E.pmSubject = $('#featlabPmSubject');
    E.pmUse = $('#featlabPmUse');
    E.pmStyle = $('#featlabPmStyle');
    E.pmAngle = $('#featlabPmAngle');
    E.pmMaterial = $('#featlabPmMaterial');
    E.pmPalette = $('#featlabPmPalette');
    E.pmLight = $('#featlabPmLight');
    E.pmBg = $('#featlabPmBg');
    E.pmDetails = $('#featlabPmDetails');
    E.pmExtra = $('#featlabPmExtra');
    E.pmNeg = $('#featlabPmNeg');
    E.pmOut = $('#featlabPmOut');
    E.pmState = $('#featlabPmState');
    E.pmSeg = root.querySelector('.featlab-seg');
    E.pmQuality = $('#featlabPmQuality');

    root.addEventListener('click', function (e) {
      ctxHide();
      var ftab = e.target.closest('[data-ftab]');
      if (ftab) { applyTab(ftab.getAttribute('data-ftab')); return; }
      var stepBtn = e.target.closest('[data-step]');
      if (stepBtn) { setEdgeStep(stepBtn.getAttribute('data-step')); return; }
      var edgeBtn = e.target.closest('[data-edge]');
      if (edgeBtn) {
        var side = edgeBtn.getAttribute('data-edge');
        var dir = Number(edgeBtn.getAttribute('data-dir')) || 1;
        tuneBox(function (reg) { return nudgeEdge(reg, side, dir * S.edgeStep); }, '已调整边界');
        return;
      }
      var qBtn = e.target.closest('[data-q]');
      if (qBtn) { toggleQuality(qBtn.getAttribute('data-q')); return; }
      var langBtn = e.target.closest('[data-pmlang]');
      if (langBtn) { setPmLang(langBtn.getAttribute('data-pmlang')); return; }
      var toolBtn = e.target.closest('[data-tool]');
      if (toolBtn) { setTool(toolBtn.getAttribute('data-tool')); return; }
      var actBtn = e.target.closest('[data-act]');
      if (actBtn) { e.preventDefault(); doAction(actBtn.getAttribute('data-act')); return; }
      var ract = e.target.closest('[data-ract]');
      if (ract) {
        var kind = ract.getAttribute('data-ract');
        if (kind === 'del-src') { removeSource(ract.getAttribute('data-src')); return; }
        var row = ract.closest('[data-region]');
        if (row) {
          var rid = row.getAttribute('data-region');
          if (kind === 'del') removeRegion(rid);
          else if (kind === 'up') moveRegion(rid, -1);
          else if (kind === 'down') moveRegion(rid, 1);
          return;
        }
        return;
      }
      var srcEl = e.target.closest('[data-src]');
      if (srcEl && !e.target.closest('[data-act]')) { setActive(srcEl.getAttribute('data-src')); return; }
      var rowEl = e.target.closest('[data-region]');
      if (rowEl) {
        var id = rowEl.getAttribute('data-region');
        if (e.target.closest('input')) { selectRegion(id); return; }
        selectRegion(id);
      }
    });

    root.addEventListener('input', function (e) {
      var t = e.target;
      if (t.id === 'featlabLock') {
        S.lockRatio = !!t.checked;
        saveSoon();
        status(S.lockRatio ? '拖角点将锁定宽高比' : '已取消锁比例');
        return;
      }
      if (t.id === 'featlabSelName') {
        var r = regionById(S.selId);
        if (r) {
          r.name = t.value;
          var listName = root.querySelector('[data-rename="' + r.id + '"]');
          if (listName && listName !== t) listName.value = t.value;
          updateAnnotation();
          updatePrompt();
          schedulePreview();
          saveSoon();
        }
        return;
      }
      var b = t.getAttribute && t.getAttribute('data-box');
      if (b != null && S.selId) {
        var reg = regionById(S.selId);
        if (reg) {
          var k = Number(b);
          var v = clamp(num(t.value, 0) / 100, 0, 1);
          reg.box[k] = v;
          reg.box = clampBox(reg.box);
          refreshInspMeta();
          draw();
          schedulePreview();
          saveSoon();
        }
        return;
      }
      if (t.getAttribute && t.getAttribute('data-note')) {
        /* 逐格写标注 → 整段标注立刻重算（用户手改过整段就不覆盖，状态栏那个「手动」说了算） */
        var rn = regionById(t.getAttribute('data-note'));
        if (rn) {
          rn.note = t.value;
          updateAnnotation();
          if (S.annEdited) status('整段标注是手动稿，点「恢复自动」才会按逐格描述重算');
          saveSoon();
        }
        return;
      }
      if (t.getAttribute && t.getAttribute('data-rename')) {
        var rr = regionById(t.getAttribute('data-rename'));
        if (rr) {
          rr.name = t.value;
          if (S.selId === rr.id) {
            var ins = $('#featlabSelName');
            if (ins && ins !== t) ins.value = t.value;
          }
          updateAnnotation();
          updatePrompt();
          schedulePreview();
          saveSoon();
        }
        return;
      }
      if (readPmtField(t)) return;
      readOptField(t);
    });

    root.addEventListener('change', function (e) {
      if (readPmtField(e.target)) return;
      readOptField(e.target);
    });

    /* 单行框打完字会停在中段（光标在末尾），失焦后拉回开头才看得见这句话从哪起 */
    root.addEventListener('focusout', function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains('featlab-row-note')) t.scrollLeft = 0;
    });

    E.file.addEventListener('change', function () {
      var files = E.file.files;
      if (files && files.length) importFiles(files);
      E.file.value = '';
    });

    root.addEventListener('dragover', function (e) { e.preventDefault(); });
    root.addEventListener('drop', function (e) {
      e.preventDefault();
      var dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) importFiles(dt.files);
    });

    E.canvas.addEventListener('pointerdown', onPointerDown);
    E.canvas.addEventListener('pointermove', onPointerMove);
    E.canvas.addEventListener('pointerup', onPointerUp);
    E.canvas.addEventListener('pointercancel', onPointerUp);
    E.canvas.addEventListener('dblclick', function (e) {
      var hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        selectRegion(hit.id);
        var input = $('#featlabSelName');
        if (input) { input.focus(); input.select(); }
      }
    });
    E.viewport.addEventListener('wheel', onWheel, { passive: false });

    /* ---- 右键菜单：画布 / 源图 / 区域行 / 图集预览 ---- */
    if (E.ctx) {
      E.ctx.addEventListener('click', function (e) {
        e.stopPropagation();
        var btn = e.target.closest('[data-ci]');
        if (!btn) return;
        var it = ctxItems[Number(btn.getAttribute('data-ci'))];
        ctxHide();
        if (it && !it.off && typeof it.run === 'function') it.run();
      });
    }
    if (E.canvas) {
      E.canvas.addEventListener('contextmenu', function (e) {
        if (!appVisible()) return;
        e.preventDefault();
        var hit = hitTest(e.clientX, e.clientY);
        if (hit) selectRegion(hit.id);
        ctxShow(e.clientX, e.clientY, canvasMenu(hit));
      });
    }
    if (E.srcs) {
      E.srcs.addEventListener('contextmenu', function (e) {
        var el = e.target.closest('[data-src]');
        if (!el) return;
        var src = sourceById(el.getAttribute('data-src'));
        if (!src) return;
        e.preventDefault();
        ctxShow(e.clientX, e.clientY, sourceMenu(src));
      });
    }
    if (E.list) {
      E.list.addEventListener('contextmenu', function (e) {
        var row = e.target.closest('[data-region]');
        if (!row) return;
        var reg = regionById(row.getAttribute('data-region'));
        if (!reg) return;
        e.preventDefault();
        selectRegion(reg.id);
        ctxShow(e.clientX, e.clientY, regionMenu(reg));
      });
    }
    if (E.previewWrap) {
      E.previewWrap.addEventListener('contextmenu', function (e) {
        if (!S.regions.length) return;
        e.preventDefault();
        ctxShow(e.clientX, e.clientY, previewMenu());
      });
    }

    /* 点别处 / 滚动 / 改窗口大小，菜单就该消失（不然会浮在别的内容上） */
    document.addEventListener('pointerdown', function (e) {
      if (!E.ctx || E.ctx.hidden) return;
      if (E.ctx.contains(e.target)) return;
      ctxHide();
    }, true);
    if (E.panel) E.panel.addEventListener('scroll', ctxHide, true);
    window.addEventListener('resize', ctxHide);
    window.addEventListener('blur', ctxHide);

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('paste', onPaste);

    if (typeof ResizeObserver === 'function' && E.viewport) {
      var ro = new ResizeObserver(function () {
        resizeCanvas();
        if (!VIEW.touched) fitView();
        else draw();
      });
      ro.observe(E.viewport);
    }
    window.addEventListener('resize', function () {
      resizeCanvas();
      if (!VIEW.touched) fitView();
    });
  }

  /* ---------------- 图集 ---------------- */

  function renderCell(src, box, cell, margin, bg) {
    if (!src || !src._img) return null;
    var c = document.createElement('canvas');
    c.width = cell;
    c.height = cell;
    var g = c.getContext('2d');
    g.fillStyle = bg || S.opt.bg;
    g.fillRect(0, 0, cell, cell);
    /* 与工作流「特征提取」节点同一套裁切：归一化 box → 原图像素（外扩 margin/2）
       → 夹到图内 → 取居中方形 → cover 铺满格子。 */
    var w = src.w;
    var h = src.h;
    var bw = Math.max(0, box[2]);
    var bh = Math.max(0, box[3]);
    if (bw <= 0 || bh <= 0) return c;
    var m = clamp(num(margin, 30), 0, 100) / 100;
    var mx = bw * m / 2;
    var my = bh * m / 2;
    var sx = (box[0] - mx) * w;
    var sy = (box[1] - my) * h;
    var sw = (bw + mx * 2) * w;
    var sh = (bh + my * 2) * h;
    sx = Math.max(0, Math.min(w - 4, sx));
    sy = Math.max(0, Math.min(h - 4, sy));
    sw = Math.max(4, Math.min(w - sx, sw));
    sh = Math.max(4, Math.min(h - sy, sh));
    var sr = sw / sh;
    var cw = sw;
    var ch = sh;
    if (sr > 1) cw = sh;
    else ch = sw;
    var cx = sx + (sw - cw) / 2;
    var cy = sy + (sh - ch) / 2;
    try {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(src._img, cx, cy, cw, ch, 0, 0, cell, cell);
    } catch (e) {
      return c;
    }
    return c;
  }

  function drawIndexBadge(g, x, y, cell, n) {
    var pad = Math.round(cell * 0.028);
    var size = Math.round(cell * 0.088);
    var r = Math.round(size * 0.28);
    g.save();
    g.fillStyle = 'rgba(0,0,0,.55)';
    roundRect(g, x + pad, y + pad, size, size, r);
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.lineWidth = Math.max(1, cell * 0.003);
    roundRect(g, x + pad, y + pad, size, size, r);
    g.stroke();
    g.fillStyle = '#fff';
    g.font = '600 ' + Math.round(size * 0.54) + 'px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(n), x + pad + size / 2, y + pad + size / 2 + 1);
    g.restore();
  }

  function fitText(g, text, maxW) {
    var t = String(text || '');
    if (g.measureText(t).width <= maxW) return t;
    while (t.length > 1 && g.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function drawNameStrip(g, x, y, cell, name) {
    var h = Math.round(cell * 0.18);
    var grad = g.createLinearGradient(0, y + cell - h, 0, y + cell);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.45, 'rgba(0,0,0,.45)');
    grad.addColorStop(1, 'rgba(0,0,0,.78)');
    g.save();
    g.fillStyle = grad;
    g.fillRect(x, y + cell - h, cell, h);
    var fs = Math.max(10, Math.round(cell * 0.058));
    g.font = '600 ' + fs + 'px system-ui, sans-serif';
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    var label = fitText(g, name, cell * 0.86);
    g.shadowColor = 'rgba(0,0,0,.6)';
    g.shadowBlur = 4;
    g.fillText(label, x + cell / 2, y + cell - h / 2);
    g.restore();
  }

  function buildAtlasCanvas(cell, margin, gap, bg, badge, labels) {
    var total = cell * 3 + gap * 2;
    var c = document.createElement('canvas');
    c.width = total;
    c.height = total;
    var g = c.getContext('2d');
    g.fillStyle = bg || '#15181d';
    g.fillRect(0, 0, total, total);
    var n = Math.min(S.regions.length, MAX_REG);
    for (var k = 0; k < n; k++) {
      var reg = S.regions[k];
      var src = sourceById(reg.srcId);
      var x = (k % 3) * (cell + gap);
      var y = Math.floor(k / 3) * (cell + gap);
      var one = renderCell(src, reg.box, cell, margin, bg);
      if (one) g.drawImage(one, x, y);
      else {
        g.save();
        g.strokeStyle = 'rgba(255,255,255,.18)';
        g.strokeRect(x + .5, y + .5, cell - 1, cell - 1);
        g.fillStyle = 'rgba(255,255,255,.35)';
        g.font = Math.round(cell * 0.05) + 'px system-ui, sans-serif';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('源图未加载', x + cell / 2, y + cell / 2);
        g.restore();
      }
      if (badge) drawIndexBadge(g, x, y, cell, k + 1);
      if (labels) drawNameStrip(g, x, y, cell, reg.name);
    }
    return c;
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(previewAtlas, 140);
  }

  function previewAtlas() {
    if (!E.preview) return;
    var host = E.preview.parentElement ? E.preview.parentElement.clientWidth - 24 : 260;
    var cell = Math.max(120, Math.round(Math.min(360, host || 260) / 3) * 2);
    var gap = Math.round(S.opt.gap * cell / Math.max(1, S.opt.cell));
    var c = buildAtlasCanvas(cell, S.opt.margin, gap, S.opt.bg, S.regions.length > 0 && S.opt.badge, S.opt.labels);
    E.preview.width = c.width;
    E.preview.height = c.height;
    var g = E.preview.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(c, 0, 0);
    if (E.previewHint) {
      E.previewHint.hidden = S.regions.length > 0;
      E.previewHint.textContent = S.regions.length ? '' : '还没有可拼的区域';
    }
  }

  function buildAction() {
    if (!S.regions.length) {
      status('先框选或 AI 提取特征，再拼图集');
      log('没有可拼的区域', 'warn');
      return;
    }
    var c = buildAtlasCanvas(S.opt.cell, S.opt.margin, S.opt.gap, S.opt.bg, S.opt.badge, S.opt.labels);
    previewAtlas();
    var empty = MAX_REG - Math.min(S.regions.length, MAX_REG);
    status('已拼图集 ' + c.width + '×' + c.height + ' · ' + S.regions.length + '/9 格' + (empty ? ' · 空 ' + empty + ' 格' : ''));
    log('拼图集 ' + c.width + '×' + c.height + '（' + S.regions.length + ' 格）', 'ok');
  }

  /* ---------------- 导出 ---------------- */

  function stamp() {
    var d = new Date();
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function downloadURL(url, filename) {
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    downloadURL(url, filename);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function exportPNG() {
    if (!S.regions.length) { status('没有可导出的区域'); return; }
    var c = buildAtlasCanvas(S.opt.cell, S.opt.margin, S.opt.gap, S.opt.bg, S.opt.badge, S.opt.labels);
    var url = c.toDataURL('image/png');
    downloadURL(url, 'featlab-atlas-' + stamp() + '.png');
    log('导出图集 PNG · ' + c.width + '×' + c.height, 'ok');
    status('已导出 PNG');
  }

  function exportJSON() {
    if (!S.regions.length) { status('没有可导出的区域'); return; }
    var c = buildAtlasCanvas(S.opt.cell, S.opt.margin, S.opt.gap, S.opt.bg, S.opt.badge, S.opt.labels);
    var annotation = S.ann || makeAnnotation();
    var sources = S.sources.map(function (s, i) {
      return { index: i + 1, name: s.name, width: s.w, height: s.h };
    });
    var regions = S.regions.map(function (r, i) {
      var si = sourceIndex(r.srcId);
      var src = sourceById(r.srcId);
      return {
        index: i + 1,
        position: POS[i] || '',
        name: r.name,
        note: r.note || '',
        line: regPhrase(i, r),
        source: si + 1,
        sourceName: src ? src.name : '',
        box: { x: round(r.box[0], 4), y: round(r.box[1], 4), w: round(r.box[2], 4), h: round(r.box[3], 4) },
        boxPixels: src ? {
          x: Math.round(r.box[0] * src.w), y: Math.round(r.box[1] * src.h),
          w: Math.round(r.box[2] * src.w), h: Math.round(r.box[3] * src.h)
        } : null
      };
    });
    var data = {
      generator: 'featlab',
      version: 1,
      createdAt: new Date().toISOString(),
      subject: S.opt.subject,
      annotation: annotation,
      atlas: {
        columns: 3, rows: 3,
        cell: S.opt.cell, margin: S.opt.margin, gap: S.opt.gap,
        width: c.width, height: c.height, background: S.opt.bg
      },
      sources: sources,
      regions: regions
    };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'featlab-atlas-' + stamp() + '.json');
    log('导出图集 JSON + 标注', 'ok');
    status('已导出 JSON');
  }

  /* ---------------- 文本复制 ---------------- */

  function copyText(text, okMsg) {
    var s = String(text == null ? '' : text);
    if (!s) { status('没有可复制的文本'); return; }
    var done = function () { status(okMsg || '已复制'); log(okMsg || '已复制文本', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done).catch(function () { fallbackCopy(s, done); });
    } else {
      fallbackCopy(s, done);
    }
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { status('复制失败，请手动选择文本'); }
    ta.remove();
  }

  function copyAnnotation() {
    var text = E.ann ? E.ann.value : (S.ann || makeAnnotation());
    if (!text) { status('还没有标注文本'); return; }
    copyText(text, '标注已复制');
  }

  function copyPrompt() {
    var text = E.pmOut ? E.pmOut.value : (S.pmOut || buildPromptOut().text);
    if (!text) { status('提示词还是空的：先在上面填几项'); return; }
    copyText(text, '提示词已复制');
  }

  function copyNegative() {
    var text = E.pmNeg ? E.pmNeg.value : S.pmt.neg;
    if (!text) { status('没有负面提示词'); return; }
    copyText(text, '负面提示词已复制');
  }

  /* ---------------- 剪贴板（右键复制图片） ----------------
   * 图片进系统剪贴板只有一条可靠路径：navigator.clipboard.write + ClipboardItem。
   * 两个细节必须照做：
   *   ① 直接传 Promise 给 ClipboardItem —— 转码是异步的，先把 Promise 交出去，
   *      用户点击手势才不会在中途失效（等 await 完再 write 会被判「没有用户激活」）；
   *   ② 失败必须降级成下载并如实说明，不能只弹一句「已复制」骗人。 */

  function canvasPNG(canvas) {
    return new Promise(function (res, rej) {
      try {
        canvas.toBlob(function (b) {
          if (b) res(b); else rej(new Error('图片转码失败'));
        }, 'image/png');
      } catch (e) { rej(e); }
    });
  }

  async function copyCanvas(canvas) {
    if (!canvas) throw new Error('没有可复制的图片');
    var p = canvasPNG(canvas);
    p.catch(function () {});
    if (navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': p })]);
        return 'clipboard';
      } catch (e) {
        try {
          var blob = await p;
          await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
          return 'clipboard';
        } catch (e2) { /* 落到下载 */ }
      }
    }
    downloadBlob(await p, 'featlab-' + stamp() + '.png');
    return 'download';
  }

  function sourceCanvas(src) {
    if (!src || !src._img) return null;
    var c = document.createElement('canvas');
    c.width = Math.max(1, src.w);
    c.height = Math.max(1, src.h);
    c.getContext('2d').drawImage(src._img, 0, 0);
    return c;
  }

  /* 三种复制入口共用；okName 写进状态栏，让人知道剪贴板里是哪一张 */
  async function copyImageCanvas(canvas, okName) {
    try {
      var how = await copyCanvas(canvas);
      if (how === 'clipboard') {
        status('已复制' + okName + ' · ' + canvas.width + '×' + canvas.height);
        log('复制' + okName + '到剪贴板', 'ok');
      } else {
        status('剪贴板写入被系统拒绝，已改为下载 PNG');
        log('剪贴板不可用，已改为下载', 'warn');
      }
      return how;
    } catch (e) {
      status('复制失败：' + friendly(e));
      log('复制图片失败：' + friendly(e), 'err');
      return 'fail';
    }
  }

  function copyRegionImage(reg, size) {
    if (!reg) return;
    var src = sourceById(reg.srcId);
    var c = renderCell(src, reg.box, size || S.opt.cell, S.opt.margin, S.opt.bg);
    if (!c) { status('源图还没加载完成，稍等再试'); return; }
    copyImageCanvas(c, '「' + (reg.name || '未命名') + '」小图');
  }

  function copySourceImage(src) {
    var s = src || activeSource();
    if (!s) { status('还没有源图'); return; }
    var c = sourceCanvas(s);
    if (!c) { status('源图还没加载完成，稍等再试'); return; }
    copyImageCanvas(c, '整张源图（' + s.name + '）');
  }

  function copyAtlasImage() {
    if (!S.regions.length) { status('还没有可拼的区域'); return; }
    var c = buildAtlasCanvas(S.opt.cell, S.opt.margin, S.opt.gap, S.opt.bg, S.opt.badge, S.opt.labels);
    copyImageCanvas(c, '九宫格图集');
  }

  /* ---------------- 右键菜单 ---------------- */

  var ctxItems = [];

  function ctxHide() {
    if (E.ctx) { E.ctx.hidden = true; E.ctx.innerHTML = ''; }
    ctxItems = [];
  }

  function ctxShow(x, y, items) {
    if (!E.ctx) return;
    ctxItems = items;
    var html = '';
    items.forEach(function (it, i) {
      if (it === '-') { html += '<span class="featlab-ctx-sep"></span>'; return; }
      html += '<button type="button" role="menuitem" class="featlab-ctx-item' + (it.off ? ' off' : '') +
        '" data-ci="' + i + '"><span>' + esc(it.label) + '</span>' +
        (it.hint ? '<i>' + esc(it.hint) + '</i>' : '') + '</button>';
    });
    E.ctx.innerHTML = html;
    E.ctx.hidden = false;
    /* 先量再定位：绝对定位的基准是 .featlab-shell（clientX/Y 换成它内部的坐标），
       贴边时往回收，别让菜单跑出 App 之外。 */
    E.ctx.style.left = '0px';
    E.ctx.style.top = '0px';
    var host = E.ctx.offsetParent || root;   /* = .featlab-shell（比 root 更准，root 带 body padding） */
    var cr = host.getBoundingClientRect();
    var mr = E.ctx.getBoundingClientRect();
    var maxL = Math.max(6, cr.width - mr.width - 6);
    var maxT = Math.max(6, cr.height - mr.height - 6);
    E.ctx.style.left = clamp(x - cr.left, 6, maxL) + 'px';
    E.ctx.style.top = clamp(y - cr.top, 6, maxT) + 'px';
  }

  function focusNameInput() {
    var input = $('#featlabSelName');
    if (input) { input.focus(); input.select(); }
  }

  function canvasMenu(hit) {
    var src = activeSource();
    var items = [];
    if (hit) {
      var reg = regionById(hit.id);
      items.push({
        label: '复制「' + ((reg && reg.name) || '未命名') + '」小图',
        hint: '进剪贴板',
        run: function () { copyRegionImage(reg); }
      });
    }
    items.push({
      label: '复制整张源图',
      hint: src ? src.w + '×' + src.h : '',
      off: !src,
      run: function () { copySourceImage(src); }
    });
    items.push({
      label: '复制九宫格图集',
      hint: S.regions.length ? S.regions.length + '/9 格' : '还没有区域',
      off: !S.regions.length,
      run: copyAtlasImage
    });
    if (hit) {
      items.push('-');
      items.push({ label: '重命名该区域', run: function () { selectRegion(hit.id); focusNameInput(); } });
      items.push({ label: '定位到该区域', run: function () { selectRegion(hit.id); focusRegion(); } });
      items.push({ label: '删除该区域', run: function () { removeRegion(hit.id); } });
    } else if (src) {
      items.push('-');
      items.push({ label: '适应窗口', hint: 'F', run: fitView });
    }
    return items;
  }

  function sourceMenu(src) {
    var mine = S.regions.filter(function (r) { return r.srcId === src.id; });
    return [
      { label: '复制这张图', hint: src.w + '×' + src.h, run: function () { copySourceImage(src); } },
      { label: '复制这张图上的 ' + mine.length + ' 个小图', off: !mine.length, run: function () { copyRegionsGrid(mine, '「' + src.name + '」的 ' + mine.length + ' 个小图'); } },
      '-',
      { label: '设为当前源图', off: src.id === S.activeId, run: function () { setActive(src.id); } },
      { label: '移除这张图', run: function () { removeSource(src.id); } }
    ];
  }

  function regionMenu(reg) {
    var i = S.regions.indexOf(reg);
    return [
      { label: '复制小图', hint: '与图集同款裁切', run: function () { copyRegionImage(reg); } },
      { label: '复制这一行标注', run: function () { copyText(regPhrase(i, reg), '已复制「' + reg.name + '」的标注短语'); } },
      '-',
      { label: '定位到该区域', run: function () { selectRegion(reg.id); focusRegion(); } },
      { label: '上移一格', off: i <= 0, run: function () { moveRegion(reg.id, -1); } },
      { label: '下移一格', off: i >= S.regions.length - 1, run: function () { moveRegion(reg.id, 1); } },
      '-',
      { label: '删除', run: function () { removeRegion(reg.id); } }
    ];
  }

  function previewMenu() {
    return [
      { label: '复制九宫格图集', hint: S.regions.length + '/9 格', off: !S.regions.length, run: copyAtlasImage },
      { label: '导出 PNG', run: exportPNG },
      '-',
      { label: '复制图集标注', run: copyAnnotation }
    ];
  }

  /* 把若干区域拼成一张等宽多行的小图合集（不做九宫格留白，只排实际有的格子） */
  function copyRegionsGrid(list, okName) {
    if (!list || !list.length) { status('没有可复制的区域'); return; }
    var cell = Math.min(S.opt.cell, 512);
    var c = document.createElement('canvas');
    c.width = cell * Math.min(3, list.length);
    c.height = cell * Math.ceil(list.length / 3);
    var g = c.getContext('2d');
    g.fillStyle = S.opt.bg;
    g.fillRect(0, 0, c.width, c.height);
    list.forEach(function (reg, k) {
      var one = renderCell(sourceById(reg.srcId), reg.box, cell, S.opt.margin, S.opt.bg);
      if (one) g.drawImage(one, (k % 3) * cell, Math.floor(k / 3) * cell);
    });
    copyImageCanvas(c, okName || ('区域小图合集（' + list.length + ' 格）'));
  }

  /* ---------------- AI ---------------- */

  function ensureConn() {
    if (typeof llmStreamRequest !== 'function' || typeof llmConn !== 'function') {
      throw new Error('模型通道未就绪，请刷新桌面后再试');
    }
    var conn = null;
    try { conn = llmConn(); } catch (e) { conn = null; }
    if (!conn || !conn.model) throw new Error('语言模型未配置，请先在设置里填写模型');
    return conn;
  }

  function aiCompress(src, maxSide) {
    return new Promise(function (res, rej) {
      if (!src || !src._img) { rej(new Error('“' + ((src && src.name) || '源图') + '”还没加载完成')); return; }
      var w = src.w, h = src.h;
      var k = Math.min(1, (maxSide || 768) / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      var g = c.getContext('2d');
      g.fillStyle = S.opt.bg;
      g.fillRect(0, 0, c.width, c.height);
      try {
        g.drawImage(src._img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.72));
      } catch (e) {
        rej(new Error('图片编码失败'));
      }
    });
  }

  function cropDataURL(src, box, size) {
    if (!src || !src._img) throw new Error('源图还没加载完成');
    var c = renderCell(src, box, size || 224, S.opt.margin, S.opt.bg);
    return c.toDataURL('image/jpeg', 0.72);
  }

  function parseJSONLoose(raw) {
    if (raw && typeof raw === 'object') return raw;
    var s = String(raw == null ? '' : raw).trim();
    s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* 继续尝试整段 */ }
    }
    try { return JSON.parse(s); } catch (e) {
      throw new Error('模型没有返回可解析的 JSON');
    }
  }

  function normalizeRegion(raw) {
    if (!raw || !Array.isArray(raw.box) || raw.box.length !== 4) return null;
    var b = raw.box.map(Number);
    if (b.some(function (v) { return !isFinite(v); })) return null;
    var x = clamp(b[0], 0, 0.995);
    var y = clamp(b[1], 0, 0.995);
    var w = clamp(b[2], 0.004, 1 - x);
    var h = clamp(b[3], 0.004, 1 - y);
    if (w < 0.01 || h < 0.01) return null;
    var name = String(raw.name || '').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').slice(0, 12);
    /* note 是这一格在标注里的那句描述；模型没给就留空，标注退回用名称 */
    var note = String(raw.note || raw.desc || '').trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').slice(0, 40);
    return { name: name || '特征', note: note, box: [x, y, w, h] };
  }

  async function aiRequest(sys, text, images) {
    var conn = ensureConn();
    var content = [{ type: 'text', text: text }];
    (images || []).forEach(function (u) {
      if (u) content.push({ type: 'image_url', image_url: { url: u } });
    });
    var raw = await llmStreamRequest(sys, [{ role: 'user', content: content }], null, {
      conn: conn,
      app: 'featlab',
      timeoutMs: 180000,
      signal: S.abort ? S.abort.signal : undefined
    });
    return parseJSONLoose(raw);
  }

  async function aiLocate(imgDataURL, avoid, need) {
    var subject = String(S.opt.subject || '').trim() || '人物';
    var requirement = String(S.opt.req || '').trim();
    var text = '主体：' + subject + '\n' +
      (requirement ? '工作要求：' + requirement : '工作要求：挑出图中最值得关注的细节区域（部位、配件、纹理等），最多 9 个。') + '\n' +
      (avoid && avoid.length ? '以下特征已经找过（含未通过复核的），这次必须避开，另找不同的：' + avoid.slice(0, 20).join('、') + '\n' : '') +
      '以图片左上角为原点，坐标归一化到 0~1（保留 3 位小数）。\n' +
      '只返回这个 JSON：\n{"regions":[{"name":"眼睛","box":[0.41,0.32,0.18,0.09],"note":"细长的丹凤眼，眼尾上挑"}]}\n' +
      'box 是该区域的最小外接矩形 [左, 上, 宽, 高]；name 用 2~6 字的部位 / 物件名；' +
      'note 用一句话写清这一格里看到的样子（不超过 20 字，会直接进图集标注）；按重要程度排序；这次最多 ' + need + ' 个。';
    var data = await aiRequest(
      '你是图像特征定位器。只返回 JSON，不要解释。name 用简短中文部位 / 物件名，note 用一句话描述该区域外观，' +
      'box 用归一化 [左, 上, 宽, 高]，必须落在图片范围内。',
      text,
      [imgDataURL]
    );
    var arr = (data && data.regions) || [];
    if (!Array.isArray(arr)) return [];
    return arr.map(normalizeRegion).filter(Boolean).slice(0, need);
  }

  async function aiVerifyCrops(targets, crops) {
    var list = targets.map(function (r, i) { return (i + 1) + '. ' + (r.name || '未命名'); }).join('\n');
    var text = '这是一张拼图上的候选特征区域（按顺序编号）：\n' + list + '\n\n' +
      '请逐个判断：小图里是否真的能清楚看到对应的部位 / 物件，且它是该部位的主体而不是大片背景或无关内容。\n' +
      '只返回 JSON：\n{"checks":{"1":{"ok":true,"reason":""},"2":{"ok":false,"reason":"只拍到背景"}}}';
    var data = await aiRequest('你是图像标注复核员。只返回 JSON，不要解释。', text, crops);
    return (data && data.checks) || data || {};
  }

  async function aiNameCrops(targets, crops) {
    var list = targets.map(function (r, i) { return (i + 1) + '. ' + (r.name || '（未命名）'); }).join('\n');
    var subject = String(S.opt.subject || '').trim() || '人物';
    var text = '给下面这些小图命名。它们是从同一张原图上按区域裁下来的，按顺序编号：\n' + list + '\n\n' +
      '主体：' + subject + '\n每个名字 2~6 个字，说清画面里是哪个部位 / 物件 / 纹理，不要带编号。\n' +
      '只返回 JSON：\n{"names":{"1":"发髻","2":"眼睛"}}';
    var data = await aiRequest('你是图像部位命名器。只返回 JSON，不要解释。', text, crops);
    return (data && data.names) || data || {};
  }

  function verifyCropObj(c) {
    var src = sourceById(c.srcId);
    return cropDataURL(src, c.box, 224);
  }

  async function locateRound(targets, want, used) {
    var cands = [];
    var lastErr = null;
    for (var i = 0; i < targets.length && cands.length < want; i++) {
      var src = targets[i];
      if (!src || !src._img) continue;
      var si = sourceIndex(src.id) + 1;
      setBusyText(true, 'AI 定位特征', '分析 图' + si + ' · ' + (i + 1) + '/' + targets.length);
      log('AI 定位 图' + si + '（' + src.name + '）');
      var small = null;
      var arr = [];
      try {
        small = await aiCompress(src, 768);
        arr = await aiLocate(small, Array.from(used), Math.max(1, want - cands.length));
      } catch (e) {
        if (e && e._stopped) throw e;
        lastErr = e;
        log('图' + si + ' 定位失败：' + friendly(e), 'err');
        continue;
      }
      if (!arr.length) log('图' + si + ' 没有定位到新区域', 'warn');
      for (var j = 0; j < arr.length && cands.length < want; j++) {
        var key = arr[j].name.toLowerCase();
        if (used.has(key)) continue;
        used.add(key);
        cands.push({ srcId: src.id, name: arr[j].name, note: arr[j].note || '', box: arr[j].box });
      }
    }
    if (!cands.length) {
      if (lastErr) throw lastErr;
      log('没有定位到新的特征区域', 'warn');
      return { added: 0, dropped: 0 };
    }
    var dropped = 0;
    if (S.opt.verify) {
      setBusyText(true, 'AI 逐格复核', cands.length + ' 个候选');
      var checks = null;
      try {
        checks = await aiVerifyCrops(cands, cands.map(verifyCropObj));
      } catch (e) {
        if (e && e._stopped) throw e;
        log('复核失败，已跳过：' + friendly(e), 'warn');
      }
      if (checks) {
        cands.forEach(function (c, k) {
          var chk = checks[k + 1];
          if (chk && !chk.ok) {
            c.drop = true;
            dropped++;
            log('复核剔除「' + c.name + '」：' + (chk.reason || '不像'), 'warn');
          }
        });
      }
    }
    var added = 0;
    var keep = cands.filter(function (c) { return !c.drop; }).length;
    if (keep) pushUndo();
    cands.forEach(function (c) {
      if (!c.drop && S.regions.length < MAX_REG) {
        addRegion(c);
        added++;
      }
    });
    syncUI();
    return { added: added, dropped: dropped };
  }

  async function aiExtract() {
    if (S.busy) return;
    if (!S.sources.length) { status('先导入源图'); return; }
    var targets = S.opt.scope === 'active' ? [activeSource()] : S.sources.slice();
    targets = targets.filter(function (s) { return s && s._img; });
    if (!targets.length) { status('源图还没加载完成，稍等再试'); return; }
    await runBusy('AI 提取特征', async function () {
      var need = MAX_REG - S.regions.length;
      if (need <= 0) {
        log('已经 9 格，先删掉一些再提取', 'warn');
        status('已满 9 格');
        return;
      }
      var used = new Set();
      S.regions.forEach(function (r) { used.add(String(r.name).toLowerCase()); });
      var before = S.regions.length;
      var r1 = await locateRound(targets, need, used);
      var dropped = r1.dropped;
      var rounds = 0;
      while (dropped > 0 && rounds < 2 && S.regions.length < MAX_REG) {
        rounds++;
        log('复核剔除 ' + dropped + ' 格，尝试补齐（第 ' + rounds + ' 轮）', 'warn');
        var r2 = await locateRound(targets, dropped, used);
        dropped = r2.dropped;
        if (!r2.added) break;
      }
      var added = S.regions.length - before;
      if (!added) {
        log('这次没有新增区域，可以改工作要求再试', 'warn');
        status('AI 未新增区域');
        return;
      }
      log('AI 提取完成：新增 ' + added + ' 格 · 共 ' + S.regions.length + '/9', 'ok');
      status('AI 提取完成 · 新增 ' + added + ' 格');
    });
  }

  async function aiVerify() {
    if (S.busy) return;
    var targets = S.selId ? [regionById(S.selId)].filter(Boolean) : S.regions.slice();
    if (!targets.length) { status('没有可复核的区域'); return; }
    await runBusy('AI 复核', async function () {
      setBusyText(true, 'AI 复核', targets.length + ' 个区域');
      var crops = targets.map(function (r) {
        return cropDataURL(sourceById(r.srcId), r.box, 224);
      });
      var checks = await aiVerifyCrops(targets, crops);
      var bad = [];
      targets.forEach(function (r, i) {
        var c = checks[i + 1];
        if (c && !c.ok) {
          bad.push(r.id);
          log('复核剔除「' + r.name + '」：' + (c.reason || '不像'), 'warn');
        }
      });
      if (!bad.length) {
        log('复核通过 ' + targets.length + ' 个区域', 'ok');
        status('AI 复核通过');
        return;
      }
      pushUndo();
      var badSet = new Set(bad);
      S.regions = S.regions.filter(function (r) { return !badSet.has(r.id); });
      if (badSet.has(S.selId)) S.selId = '';
      syncUI();
      saveNow();
      log('复核完成：保留 ' + (targets.length - bad.length) + ' / ' + targets.length, 'ok');
      status('AI 复核完成 · 保留 ' + (targets.length - bad.length) + ' 格');
    });
  }

  async function aiName() {
    if (S.busy) return;
    var targets;
    if (S.selId) {
      var one = regionById(S.selId);
      targets = one ? [one] : [];
    } else {
      targets = S.regions.filter(function (r) { return !r.name || /^特征\s*\d*$/.test(r.name); });
    }
    if (!targets.length) {
      status('没有待命名的区域；选中一个区域可强制重命名');
      log('没有待命名区域', 'warn');
      return;
    }
    await runBusy('AI 命名', async function () {
      setBusyText(true, 'AI 命名', targets.length + ' 个区域');
      var crops = targets.map(function (r) { return cropDataURL(sourceById(r.srcId), r.box, 224); });
      var names = await aiNameCrops(targets, crops);
      pushUndo();
      var n = 0;
      targets.forEach(function (r, i) {
        var nm = names[i + 1];
        if (nm) {
          r.name = String(nm).replace(/^\s+|\s+$/g, '').slice(0, 12);
          n++;
        }
      });
      syncUI();
      saveNow();
      log('AI 命名完成：' + n + ' / ' + targets.length, 'ok');
      status('AI 命名完成 · ' + n + ' 个区域');
    });
  }

  /* ---------------- 挂载 ---------------- */

  function mount(body, win) {
    root = body;
    if (!root) return;
    if (root.dataset.ready === '1') {
      if (!E.srcs) bindEvents();
      resizeCanvas();
      if (!VIEW.touched) fitView();
      else draw();
      applyTab(S.tab);
      syncUI();
      return;
    }
    if (!root.querySelector('.featlab-shell') && window.FEATLAB_BODY) {
      root.innerHTML = window.FEATLAB_BODY;
    }
    bindEvents();
    var restored = loadState();
    if (typeof blobEnsure === 'function') {
      try {
        Promise.resolve(blobEnsure()).then(function () {
          hydrateImages();
          syncUI();
        });
      } catch (e) { /* 没有 IDB 时直接用内联数据 */ }
    }
    applyOptToFields();
    applyPmtToFields();
    applyTab(S.tab);
    syncUI();
    resizeCanvas();
    fitView();
    root.dataset.ready = '1';
    log(restored
      ? '已恢复上次草稿 · ' + S.sources.length + ' 张图 / ' + S.regions.length + ' 个区域'
      : '就绪 · 导入图片开始提取特征', restored ? 'ok' : '');
  }

  registerApp({
    id: 'featlab',
    name: '特征提取台',
    title: '特征提取台',
    sub: '人工框选 · AI 提取 · 九宫格图集标注',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="3.4" width="17.2" height="17.2" rx="3"/><path d="M9.1 3.4v17.2M14.9 3.4v17.2M3.4 9.1h17.2M3.4 14.9h17.2"/><rect x="9.9" y="9.9" width="9.4" height="9.4" rx="1.6" fill="currentColor" fill-opacity=".2" stroke="none"/></svg>',
    order: 19,
    cls: 'featlab',
    win: 'featlabWin',
    css: ['apps/featlab/app.css'],
    body: (typeof window.FEATLAB_BODY === 'string' ? window.FEATLAB_BODY : ''),
    mount: mount
  });
})();
