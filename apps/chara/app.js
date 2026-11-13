/* 角色工坊 —— 插画 → 部位图 → 三视图 → Tripo 3D 候选 → 导出。
 *
 * 工作流设计借鉴开源套件 Charakuru（nanocle/Charakuru，source-available）的
 * 「分阶段 + 确认点」理念：每个阶段产出可检查的中间物，用户点了「确认并继续」
 * 才放行下一阶段；本实现全部用本项目已有的能力（云生图 / Tripo API / Model3D），
 * 未搬运其任何代码或素材。VRM 的骨骼与权重需要 Blender，本项目导出 GLB 与制作包。
 *
 * 状态存 localStorage（hf_charaProj），大图走 blob-store 外置（blobPack 存根）。
 */
(function () {
  'use strict';

  var STORE_KEY = 'hf_charaProj';
  var byId = function (id) { return document.getElementById(id); };

  /* ---------- 阶段定义 ---------- */
  var STAGES = [
    { id: 'src',    name: '原画',    desc: '导入一张有权使用的全身角色插画' },
    { id: 'parts',  name: '部位图',  desc: '头部 / 身体各四视图，共 8 张' },
    { id: 'views',  name: '三视图',  desc: '全身 正 / 侧 / 背，建模参考' },
    { id: 'model',  name: '3D 候选', desc: 'Tripo 生成模型，你来挑' },
    { id: 'export', name: '预览导出', desc: '3D 预览 · 四视图 · 导出' }
  ];

  /* 部位图 8 张的提示词模板（英文直出，不再走翻译链）。
   * 部位图的目标是「喂给 Tripo 的干净参考」，不是插画再创作。 */
  var PARTS = [
    { key: 'head.front',  label: '头 · 正面',  prompt: 'character design reference sheet: the character\'s HEAD ONLY (face and hair, cut at the neck, no body), front view, centered on plain light gray background, keep the exact hairstyle, face and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'head.threeq', label: '头 · 四分之三', prompt: 'character design reference sheet: the character\'s HEAD ONLY (face and hair, cut at the neck, no body), three-quarter view, centered on plain light gray background, keep the exact hairstyle, face and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'head.side',   label: '头 · 侧面',  prompt: 'character design reference sheet: the character\'s HEAD ONLY (face and hair, cut at the neck, no body), side profile view, centered on plain light gray background, keep the exact hairstyle and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'head.back',   label: '头 · 背面',  prompt: 'character design reference sheet: the back of the character\'s HEAD ONLY (hair only, no face, no body), back view, centered on plain light gray background, keep the exact hairstyle and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.front',  label: '身 · 正面',  prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), front view, A-pose with arms slightly away, plain light gray background, keep the exact outfit, colors and proportions of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.threeq', label: '身 · 四分之三', prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), three-quarter view, A-pose, plain light gray background, keep the exact outfit, colors and proportions of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.side',   label: '身 · 侧面',  prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), side profile view, A-pose, plain light gray background, keep the exact outfit and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.back',   label: '身 · 背面',  prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), back view, A-pose, plain light gray background, keep the exact outfit and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' }
  ];

  var VIEWS = [
    { key: 'front', label: '全身 · 正面', prompt: 'character turnaround reference sheet: FULL BODY front view of this character, A-pose, plain light gray background, keep the exact design of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'side',  label: '全身 · 侧面', prompt: 'character turnaround reference sheet: FULL BODY side profile view of this character, A-pose, plain light gray background, keep the exact design of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'back',  label: '全身 · 背面', prompt: 'character turnaround reference sheet: FULL BODY back view of this character, A-pose, plain light gray background, keep the exact design of the reference illustration, clean lineart with flat colors, no text, no watermark' }
  ];

  /* ---------- 状态 ---------- */
  function blankPart() { return { img: '', status: '' }; }

  var state = {
    stage: 0,
    src: '', srcName: '', srcInfo: '',
    parts: {},                    // key → {img:stub|dataURL, status}
    views: {},                    // key → {img, status}
    mode: 'full',                 // full=整体 | split=头身分离
    modelSrc: 'views.front',      // 整体建模的输入图
    candN: 2,
    cands: { full: [], head: [], body: [] },   // [{model,preview,credits,version,src}]
    pick: { full: -1, head: -1, body: -1 }
  };
  PARTS.forEach(function (p) { state.parts[p.key] = blankPart(); });
  VIEWS.forEach(function (v) { state.views[v.key] = blankPart(); });

  var busy = {};                // key → true（生成中的格子）
  var candBusy = [];            // 'full' | 'head' | 'body'
  var footMsg = '';

  /* ---------- 存取 ---------- */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, stage: state.stage, mode: state.mode, modelSrc: state.modelSrc,
        candN: state.candN, pick: state.pick,
        src: blobPack(state.src), srcName: state.srcName, srcInfo: state.srcInfo,
        parts: state.parts, views: state.views,
        cands: state.cands
      }));
    } catch (e) { /* 配额满时宁可丢草稿也不打断流程 */ }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (!raw) return;
    var d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || d.v !== 1) return;
    state.stage = Math.min(Math.max(d.stage | 0, 0), STAGES.length - 1);
    state.mode = d.mode === 'split' ? 'split' : 'full';
    state.modelSrc = typeof d.modelSrc === 'string' ? d.modelSrc : 'views.front';
    state.candN = Math.min(Math.max(d.candN | 0, 1), 3);
    state.pick = d.pick && typeof d.pick === 'object' ? d.pick : state.pick;
    state.srcName = d.srcName || '';
    state.srcInfo = d.srcInfo || '';
    state.src = typeof d.src === 'string' ? d.src : '';
    if (d.parts && typeof d.parts === 'object') {
      Object.keys(state.parts).forEach(function (k) {
        if (d.parts[k]) state.parts[k] = { img: d.parts[k].img || '', status: d.parts[k].status || '' };
      });
    }
    if (d.views && typeof d.views === 'object') {
      Object.keys(state.views).forEach(function (k) {
        if (d.views[k]) state.views[k] = { img: d.views[k].img || '', status: d.views[k].status || '' };
      });
    }
    if (d.cands && typeof d.cands === 'object') state.cands = d.cands;
  }

  /* 存根 → 可显示的 dataURL / URL */
  function resolveImg(s) {
    if (!s) return '';
    if (typeof blobResolve === 'function') {
      try { return blobResolve(s, new WeakSet()); } catch (e) {}
    }
    return s;
  }

  /* ---------- 图片工具 ---------- */
  function shrink(dataURL, maxSide) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, (maxSide || 1600) / Math.max(w, h));
        if (scale >= 1) { res(dataURL); return; }
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try { res(c.toDataURL('image/webp', 0.85)); } catch (e) { res(dataURL); }
      };
      img.onerror = function () { res(dataURL); };
      img.src = dataURL;
    });
  }

  function readAsDataURL(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  /* 远程图尽量转 dataURL（持久化更稳）；跨域拿不到就原样保留 URL */
  function toDataURL(url) {
    if (!url || url.indexOf('data:') === 0) return Promise.resolve(url);
    return apiFetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    }).then(function (b) {
      return new Promise(function (res) {
        var fr = new FileReader();
        fr.onload = function () { res(fr.result); };
        fr.onerror = function () { res(url); };
        fr.readAsDataURL(b);
      });
    }).catch(function () { return url; });
  }

  /* ---------- 生图（云 API / Tripo 重绘） ---------- */
  function genImage(prompt, srcImg, onProgress) {
    if (confGet('genEngine') === 'tripo') {
      var src0 = resolveImg(srcImg);
      if (!src0) throw new Error('Tripo 重绘必须有输入图');
      var tModel = confGet('imgModel') || 'seedream_v5';
      return tripoUpload(src0).then(function (token) {
        if (onProgress) onProgress('上传完成，提交任务…');
        return tripoCall('/generation/image-to-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: tModel, input: token, prompt: prompt, size: '2K', output_format: 'png' })
        });
      }).then(function (task) {
        return tripoPoll(task.task_id, function (p) { if (onProgress) onProgress(p + '%'); });
      }).then(function (done) {
        var url = done.output && done.output.generated_image_url;
        if (!url) throw new Error('Tripo 任务完成但未返回图片');
        return toDataURL(url);
      });
    }
    if (typeof imgMode === 'function' && imgMode() === 'local') {
      return Promise.reject(new Error('角色工坊需要云生图或 Tripo（设置 → 生图引擎）；本地 ComfyUI 无图生图编辑链路'));
    }
    var base = (confGet('imgBaseUrl') || confGet('llmBaseUrl') || '').replace(/\/$/, '');
    var model = confGet('imgModel') || confGet('llmModel');
    var key = confGet('imgKey') || confGet('llmKey');
    var endpoint = confGet('imgEndpoint');
    var size = confGet('imgSize') || '1024x1024';
    if (!base || !model || !key) {
      return Promise.reject(new Error('请先在设置里填写生图 Base URL / Model / API Key'));
    }
    var src = resolveImg(srcImg);
    var useImage = !!src && state.refSource !== false;
    var p;
    if (useImage && /edit/i.test(endpoint || '')) {
      /* OpenAI 兼容 /images/edits：必须 multipart/form-data（与工作台 generate() 同款） */
      p = fetch(base + endpoint, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key },
        body: (function () {
          var fd = new FormData();
          fd.append('model', model); fd.append('prompt', prompt); fd.append('size', size);
          var bin = atob(src.split(',')[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          fd.append('image', new Blob([arr], { type: 'image/png' }), 'source.png');
          return fd;
        })()
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ': 生成请求失败');
        return r.json();
      });
    } else {
      var body = { model: model, prompt: prompt, size: size };
      if (useImage) body.image = src.split(',')[1];
      p = post(base, key, endpoint, body);
    }
    return p.then(function (data) {
      var url = lookupPath(data, confGet('respPath') || 'data[0].url');
      if (!url) {
        var b64 = lookupPath(data, 'data[0].b64_json');
        if (b64) url = 'data:image/png;base64,' + b64;
      }
      if (!url) throw new Error('未找到图片地址（可在设置 → 高级里调整响应路径）');
      return toDataURL(url);
    });
  }

  /* ---------- Tripo 建模候选 ---------- */
  function genCandidate(srcImg, onProgress) {
    var src = resolveImg(srcImg);
    if (!src) return Promise.reject(new Error('缺少建模输入图'));
    var version = confGet('tripoVersion');
    if (!confGet('tripoKey')) return Promise.reject(new Error('请先在设置里填写 Tripo API Key'));
    return tripoUpload(src).then(function (token) {
      if (onProgress) onProgress('上传完成，提交建模任务…');
      return tripoCall('/generation/image-to-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: version, input: token, texture: true, pbr: true })
      });
    }).then(function (task) {
      return tripoPoll(task.task_id, function (p) { if (onProgress) onProgress(p + '%'); });
    }).then(function (done) {
      var out = done.output || {};
      return {
        model: out.model_url || out.pbr_model || '',
        preview: out.rendered_image_url || '',
        credits: done.credits_consumed,
        version: version
      };
    });
  }

  /* ---------- 渲染 ---------- */
  var host = null, stageEl = null, railEl = null, footEl = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render() {
    if (!host) return;
    renderRail();
    renderStage();
    renderFoot();
  }

  function stageDone(i) {
    if (i === 0) return !!state.src;
    if (i === 1) return !!(state.parts['head.front'] && state.parts['head.front'].img &&
                            state.parts['body.front'] && state.parts['body.front'].img);
    if (i === 2) return !!(state.views.front && state.views.front.img);
    if (i === 3) return (state.mode === 'full' ? state.pick.full >= 0 : state.pick.head >= 0 && state.pick.body >= 0);
    return true;
  }

  function renderRail() {
    var html = STAGES.map(function (s, i) {
      var cls = 'chara-step' + (i === state.stage ? ' cur' : '') + (stageDone(i) ? ' done' : '');
      return '<button type="button" class="' + cls + '" data-act="goto" data-i="' + i + '">' +
        '<span class="chara-step-dot"></span>' +
        '<span class="chara-step-txt"><b>' + (i + 1) + '. ' + esc(s.name) + '</b><i>' + esc(s.desc) + '</i></span>' +
        '</button>';
    }).join('');
    railEl.innerHTML = '<div class="chara-rail-t">制作流程</div>' + html +
      '<div class="chara-rail-foot">' +
      '<button type="button" class="btn sm ghost" data-act="reset">新建项目</button>' +
      (state.srcInfo ? '<div class="chara-projinfo">' + esc(state.srcInfo) + '</div>' : '') +
      '</div>';
  }

  function cellHTML(key, item, label, actKind) {
    var busyKey = actKind + ':' + key;
    var img = resolveImg(item.img);
    var isBusy = !!busy[busyKey];
    var body;
    if (isBusy) {
      body = '<div class="chara-cell-busy"><span class="chara-spin"></span><i>' + esc(item.status || '生成中…') + '</i></div>';
    } else if (img) {
      body = '<img src="' + esc(img) + '" alt="' + esc(label) + '" draggable="false">';
    } else {
      body = '<div class="chara-cell-empty">' + esc(item.status || '未生成') + '</div>';
    }
    return '<div class="chara-cell">' +
      '<div class="chara-cell-img">' + body + '</div>' +
      '<div class="chara-cell-bar"><span>' + esc(label) + '</span>' +
      '<button type="button" class="btn sm' + (img ? ' ghost' : '') + '" data-act="' + actKind + '" data-key="' + key + '"' +
      (isBusy ? ' disabled' : '') + '>' + (img ? '重生成' : '生成') + '</button></div>' +
      '</div>';
  }

  function renderStageSrc() {
    var img = resolveImg(state.src);
    return '<div class="chara-grid-2">' +
      '<div class="chara-drop' + (img ? ' has' : '') + '" data-act="dropzone">' +
      (img
        ? '<img src="' + esc(img) + '" alt="原画" draggable="false">'
        : '<div class="chara-drop-hint"><b>点击选择或拖入图片</b><i>PNG / JPEG / WebP，建议全身角色图</i></div>') +
      '</div>' +
      '<div class="chara-src-side">' +
      '<div class="chara-note"><b>开工前</b>' +
      '<ul><li>使用你有权使用的插画；输出模型的使用范围跟随原画授权。</li>' +
      '<li>全身、站姿、道具少，Tripo 的成功率最高。</li>' +
      '<li>图片会压缩到长边 1600 再使用，原图不会上传到任何服务。</li></ul></div>' +
      '<div class="chara-row">' +
      '<button type="button" class="btn sm" data-act="pick-src">选择图片</button>' +
      (img ? '<button type="button" class="btn sm ghost" data-act="clear-src">移除</button>' : '') +
      '</div>' +
      '<div class="chara-hint">生图走「设置 → 生图引擎」里的云 API；重绘也可以选 Tripo。</div>' +
      '</div>' +
      '</div>' +
      '<input type="file" id="charaSrcFile" accept="image/*" hidden>';
  }

  function renderStageParts() {
    var head = PARTS.filter(function (p) { return p.key.indexOf('head.') === 0; })
      .map(function (p) { return cellHTML(p.key, state.parts[p.key], p.label, 'gen-part'); }).join('');
    var body = PARTS.filter(function (p) { return p.key.indexOf('body.') === 0; })
      .map(function (p) { return cellHTML(p.key, state.parts[p.key], p.label, 'gen-part'); }).join('');
    return '<div class="chara-sec"><div class="chara-sec-t">头部（含发型）<span>喂给建模的头件参考</span>' +
      '<button type="button" class="btn sm ghost" data-act="gen-row" data-key="head">生成整排</button></div>' +
      '<div class="chara-grid-4">' + head + '</div></div>' +
      '<div class="chara-sec"><div class="chara-sec-t">身体（颈部以下）<span>喂给建模的身件参考</span>' +
      '<button type="button" class="btn sm ghost" data-act="gen-row" data-key="body">生成整排</button></div>' +
      '<div class="chara-grid-4">' + body + '</div></div>' +
      '<div class="chara-hint">提示词已按「参考图同款设计 + 纯色底 + 单部件」写死；建模最低要求头·正面与身·正面两张，其余可后补。</div>';
  }

  function renderStageViews() {
    var cells = VIEWS.map(function (v) { return cellHTML(v.key, state.views[v.key], v.label, 'gen-view'); }).join('');
    return '<div class="chara-sec"><div class="chara-sec-t">全身三视图<span>整体建模的主输入</span>' +
      '<button type="button" class="btn sm ghost" data-act="gen-row" data-key="views">生成整排</button></div>' +
      '<div class="chara-grid-3">' + cells + '</div></div>' +
      '<div class="chara-hint">三视图用于「整体建模」路线；走「头身分离」时只用部位图。</div>';
  }

  function srcPickList() {
    var opts = [];
    VIEWS.forEach(function (v) {
      if (state.views[v.key] && state.views[v.key].img) opts.push({ k: 'views.' + v.key, n: v.label });
    });
    PARTS.forEach(function (p) {
      if (state.parts[p.key] && state.parts[p.key].img) opts.push({ k: 'parts.' + p.key, n: p.label });
    });
    if (state.src) opts.push({ k: 'src', n: '原画' });
    return opts;
  }

  function candListHTML(kind) {
    var list = state.cands[kind] || [];
    if (!list.length) return '<div class="chara-cell-empty chara-cand-empty">还没有候选</div>';
    return '<div class="chara-cands">' + list.map(function (c, i) {
      var on = state.pick[kind] === i;
      return '<button type="button" class="chara-cand' + (on ? ' on' : '') + '" data-act="pick-cand" data-kind="' + kind + '" data-i="' + i + '">' +
        (c.preview ? '<img src="' + esc(c.preview) + '" alt="候选 ' + (i + 1) + '" draggable="false">' : '<div class="chara-cell-empty">无预览图</div>') +
        '<span class="chara-cand-tag">候选 ' + (i + 1) + (c.credits != null ? ' · ' + c.credits + ' 积分' : '') + '</span>' +
        '<span class="chara-cand-ver">' + esc(c.version || '') + '</span>' +
        (on ? '<b class="chara-cand-ok">已选</b>' : '') +
        '</button>';
    }).join('') + '</div>';
  }

  function renderStageModel() {
    var opts = srcPickList();
    var splitReady = !!(state.parts['head.front'] && state.parts['head.front'].img &&
                          state.parts['body.front'] && state.parts['body.front'].img);
    var modeFull = state.mode === 'full';
    var inputHtml;
    if (modeFull) {
      inputHtml = opts.length
        ? '<div class="chara-inputs">' + opts.map(function (o) {
            return '<label class="chara-radio"><input type="radio" name="chara-msrc" value="' + o.k + '"' +
              (state.modelSrc === o.k ? ' checked' : '') + '> ' + esc(o.n) + '</label>';
          }).join('') + '</div>'
        : '<div class="chara-cell-empty">前几阶段还没有图：先生成三视图或部位图</div>';
    } else {
      inputHtml = splitReady
        ? '<div class="chara-inputs"><label class="chara-radio"><input type="radio" checked disabled> 头·正面 + 身·正面（分别建模，后期拼装）</label></div>'
        : '<div class="chara-cell-empty">头身分离需要部位图的「头·正面」和「身·正面」</div>';
    }
    return '<div class="chara-sec"><div class="chara-sec-t">建模路线<span>整体 = 一个模型直接出；分离 = 头 / 身各建再拼</span></div>' +
      '<div class="chara-modes">' +
      '<button type="button" class="chara-mode' + (modeFull ? ' on' : '') + '" data-act="mode" data-v="full"><b>整体建模</b><i>用一张全身图，简单直接</i></button>' +
      '<button type="button" class="chara-mode' + (!modeFull ? ' on' : '') + '" data-act="mode" data-v="split"><b>头身分离</b><i>Tripo 对单部件效果更好，需要后期拼装</i></button>' +
      '</div></div>' +
      '<div class="chara-sec"><div class="chara-sec-t">输入图<span>' + (modeFull ? '选一张作为建模输入' : '固定使用两张部位正面图') + '</span></div>' +
      inputHtml + '</div>' +
      '<div class="chara-sec"><div class="chara-sec-t">候选' +
      '<label class="chara-candn">数量 <select id="charaCandN">' +
      [1, 2, 3].map(function (n) { return '<option value="' + n + '"' + (state.candN === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
      '</select></label>' +
      '<button type="button" class="btn sm" data-act="gen-cand"' + (candBusy.indexOf(state.mode) >= 0 ? ' disabled' : '') + '>' +
      (candBusy.indexOf(state.mode) >= 0 ? '生成中…' : '生成候选') + '</button></div>' +
      candListHTML(modeFull ? 'full' : 'head') +
      (!modeFull ? '<div class="chara-subt">身体候选</div>' + candListHTML('body') : '') +
      '<div class="chara-hint">候选由你挑选，软件不会替你做视觉判断；每次生成消耗 Tripo 积分。</div>';
  }

  function renderStageExport() {
    var modeFull = state.mode === 'full';
    var picked = [];
    if (modeFull && state.pick.full >= 0 && state.cands.full[state.pick.full]) {
      picked.push({ kind: '整体模型', c: state.cands.full[state.pick.full] });
    }
    if (!modeFull) {
      if (state.pick.head >= 0 && state.cands.head[state.pick.head]) picked.push({ kind: '头部', c: state.cands.head[state.pick.head] });
      if (state.pick.body >= 0 && state.cands.body[state.pick.body]) picked.push({ kind: '身体', c: state.cands.body[state.pick.body] });
    }
    var pickedHtml = picked.length
      ? picked.map(function (p) {
          return '<div class="chara-out-row"><b>' + esc(p.kind) + '</b>' +
            (p.c.model ? '<a class="btn sm" href="' + esc(p.c.model) + '" download="chara_model.glb">下载 GLB</a>' +
              '<button type="button" class="btn sm ghost" data-act="preview3d" data-url="' + esc(p.c.model) + '">3D 预览</button>' +
              '<button type="button" class="btn sm ghost" data-act="quad" data-url="' + esc(p.c.model) + '">导出四视图</button>'
              : '<span class="chara-hint">该候选缺少模型文件</span>') +
            '</div>';
        }).join('')
      : '<div class="chara-cell-empty">上一阶段还没挑选候选</div>';
    return '<div class="chara-sec"><div class="chara-sec-t">模型产物</div>' + pickedHtml + '</div>' +
      '<div class="chara-sec"><div class="chara-sec-t">制作包<span>所有中间图 + 选择记录，一键带走</span></div>' +
      '<div class="chara-row"><button type="button" class="btn sm" data-act="export-json">导出项目 JSON</button>' +
      '<button type="button" class="btn sm ghost" data-act="export-parts">打包部位图</button></div></div>' +
      '<div class="chara-note"><b>关于 VRM</b>' +
      '<ul><li>本项目导出 GLB 与制作包；VRM 的骨骼绑定、权重和弹簧物理需要 Blender + VRM 插件完成。</li>' +
      '<li>把制作包交给编码助手，按「权重传递 → 弹簧骨骼 → VRM 导出」的顺序可完成最后一步。</li></ul></div>';
  }

  var STAGE_RENDER = [renderStageSrc, renderStageParts, renderStageViews, renderStageModel, renderStageExport];

  function renderStage() {
    stageEl.innerHTML = STAGE_RENDER[state.stage]();
    var file = byId('charaSrcFile');
    if (file) file.addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importSrc(e.target.files[0]);
    });
    var sel = byId('charaCandN');
    if (sel) sel.addEventListener('change', function () { state.candN = sel.value | 0; save(); });
    var radios = stageEl.querySelectorAll('input[name="chara-msrc"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function () { state.modelSrc = this.value; save(); });
    }
  }

  function footReq() {
    if (state.stage === 0) return state.src ? '原画就绪' : '请先导入原画';
    if (state.stage === 1) return stageDone(1) ? '部位图最低要求已满足' : '至少生成 头·正面 与 身·正面';
    if (state.stage === 2) return stageDone(2) ? '三视图就绪' : '至少生成 正面 视图（走分离路线可跳过）';
    if (state.stage === 3) return stageDone(3) ? '已选定候选' : '请挑选一个候选';
    return '可随时导出';
  }

  function renderFoot() {
    var last = state.stage === STAGES.length - 1;
    footEl.innerHTML =
      '<span class="chara-foot-msg">' + esc(footMsg || footReq()) + '</span>' +
      '<div class="chara-foot-btns">' +
      (state.stage > 0 ? '<button type="button" class="btn sm ghost" data-act="back">上一阶段</button>' : '') +
      (!last ? '<button type="button" class="btn sm" data-act="next"' + (stageDone(state.stage) ? '' : ' disabled') + '>确认并继续 →</button>' : '') +
      '</div>';
  }

  /* ---------- 交互 ---------- */
  function importSrc(file) {
    if (!file || !/^image\//.test(file.type)) { footMsg = '请选择图片文件'; render(); return; }
    readAsDataURL(file).then(shrink).then(function (durl) {
      state.src = durl;
      state.srcName = file.name || '';
      state.srcInfo = file.name + ' · ' + Math.round(file.size / 1024) + ' KB';
      footMsg = '';
      save(); render();
    }).catch(function (e) { footMsg = '导入失败：' + e.message; render(); });
  }

  function setCell(kind, key, patch) {
    var bag = kind === 'part' ? state.parts : state.views;
    if (!bag[key]) bag[key] = blankPart();
    Object.keys(patch).forEach(function (k) { bag[key][k] = patch[k]; });
  }

  function genRow(group) {
    var items;
    if (group === 'views') items = VIEWS.map(function (v) { return ['view', v.key, 'gen-view']; });
    else items = PARTS.filter(function (p) { return p.key.indexOf(group + '.') === 0; })
      .map(function (p) { return ['part', p.key, 'gen-part']; });
    /* 整排串行生成：同时打 4 个请求容易触发限流，串行也方便逐张检查 */
    var chain = Promise.resolve();
    items.forEach(function (it) {
      chain = chain.then(function () { return genCellWait(it[0], it[1], it[2]); });
    });
  }

  function genCellWait(kind, key, actKind) {
    var busyKey = actKind + ':' + key;
    if (busy[busyKey]) return Promise.resolve();
    var bag = kind === 'part' ? state.parts : state.views;
    var item = bag[key];
    var prompt = null;
    PARTS.forEach(function (p) { if (p.key === key) prompt = p.prompt; });
    VIEWS.forEach(function (v) { if (v.key === key) prompt = v.prompt; });
    if (!prompt) return Promise.resolve();
    if (!state.src) { footMsg = '先在阶段 1 导入原画'; render(); return Promise.resolve(); }
    busy[busyKey] = true;
    setCell(kind, key, { status: '生成中…' });
    render();
    return genImage(prompt, state.src, function (msg) {
      setCell(kind, key, { status: typeof msg === 'number' ? '生成中 ' + msg : msg });
      render();
    }).then(function (durl) {
      return shrink(durl, 1280).then(function (small) {
        setCell(kind, key, { img: blobPack(small), status: '' });
      });
    }).catch(function (e) {
      setCell(kind, key, { status: '失败：' + (typeof friendlyErr === 'function' ? friendlyErr(e) : e.message) });
    }).then(function () {
      busy[busyKey] = false;
      save(); render();
    });
  }

  function genCandidates() {
    var kind = state.mode;                       // 'full' | 'split'
    if (candBusy.indexOf(kind) >= 0) return;
    var jobs = [];                               // [{ck, srcKey}]
    if (kind === 'full') {
      jobs.push({ ck: 'full', srcKey: state.modelSrc });
    } else {
      jobs.push({ ck: 'head', srcKey: 'parts.head.front' });
      jobs.push({ ck: 'body', srcKey: 'parts.body.front' });
    }
    /* 输入图检查 */
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var img = j.srcKey === 'src' ? state.src : (j.srcKey.indexOf('views.') === 0 ? (state.views[j.srcKey.slice(6)] || {}).img : (state.parts[j.srcKey.slice(6)] || {}).img);
      if (!img) { footMsg = '缺少输入图：' + j.srcKey; render(); return; }
      j.src = img;
    }
    candBusy.push(kind);
    footMsg = '';
    render();

    var chain = Promise.resolve();
    jobs.forEach(function (j) {
      chain = chain.then(function () {
        var list = state.cands[j.ck] = state.cands[j.ck] || [];
        var n = state.candN;
        var seq = Promise.resolve();
        for (var i = 0; i < n; i++) {
          (function (idx) {
            seq = seq.then(function () {
              footMsg = '候选 ' + (idx + 1) + '/' + n + ' 建模中…';
              render();
              return genCandidate(j.src, function (m) {
                footMsg = '候选 ' + (idx + 1) + '/' + n + '：' + m;
                render();
              }).then(function (cand) {
                list.push(cand);
                if (state.pick[j.ck] < 0) state.pick[j.ck] = 0;
                save(); render();
              });
            });
          })(i);
        }
        return seq;
      });
    });
    chain.catch(function (e) {
      footMsg = '建模失败：' + (typeof friendlyErr === 'function' ? friendlyErr(e) : e.message);
    }).then(function () {
      candBusy = candBusy.filter(function (k) { return k !== kind; });
      if (!footMsg) footMsg = '候选生成完毕，请挑选';
      save(); render();
    });
  }

  function exportJSON() {
    var out = {
      kit: 'openagi-chara', v: 1,
      created: new Date().toISOString(),
      source: { name: state.srcName, info: state.srcInfo, image: resolveImg(state.src) },
      parts: {}, views: {}, mode: state.mode, picks: state.pick,
      models: state.cands
    };
    Object.keys(state.parts).forEach(function (k) {
      out.parts[k] = { image: resolveImg(state.parts[k].img) };
    });
    Object.keys(state.views).forEach(function (k) {
      out.views[k] = { image: resolveImg(state.views[k].img) };
    });
    var url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'chara-project.json'; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    footMsg = '项目 JSON 已导出';
    render();
  }

  function exportParts() {
    var imgs = [];
    Object.keys(state.parts).forEach(function (k) {
      var v = resolveImg(state.parts[k].img);
      if (v) imgs.push([k, v]);
    });
    Object.keys(state.views).forEach(function (k) {
      var v = resolveImg(state.views[k].img);
      if (v) imgs.push(['views.' + k, v]);
    });
    if (!imgs.length) { footMsg = '还没有可导出的图'; render(); return; }
    var seq = Promise.resolve();
    imgs.forEach(function (it) {
      seq = seq.then(function () {
        return new Promise(function (res) {
          var a = document.createElement('a');
          a.href = it[1];
          a.download = 'chara_' + it[0].replace('.', '_') + '.png';
          a.click();
          setTimeout(res, 350);   /* 连续下载给浏览器留间隔，防止被弹窗拦截吞掉 */
        });
      });
    });
    seq.then(function () { footMsg = '已导出 ' + imgs.length + ' 张图'; render(); });
  }

  function resetProject() {
    if (!window.confirm('新建项目会清空当前进度（原画、部位图、候选选择），确定？')) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    state.stage = 0; state.src = ''; state.srcName = ''; state.srcInfo = '';
    PARTS.forEach(function (p) { state.parts[p.key] = blankPart(); });
    VIEWS.forEach(function (v) { state.views[v.key] = blankPart(); });
    state.mode = 'full'; state.modelSrc = 'views.front';
    state.cands = { full: [], head: [], body: [] };
    state.pick = { full: -1, head: -1, body: -1 };
    footMsg = '已新建项目';
    save(); render();
  }

  function onClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'goto') { state.stage = el.getAttribute('data-i') | 0; footMsg = ''; save(); render(); return; }
    if (act === 'next') { if (stageDone(state.stage)) { state.stage++; footMsg = ''; save(); render(); } return; }
    if (act === 'back') { if (state.stage > 0) { state.stage--; footMsg = ''; save(); render(); } return; }
    if (act === 'reset') { resetProject(); return; }
    if (act === 'pick-src') { var f = byId('charaSrcFile'); if (f) f.click(); return; }
    if (act === 'clear-src') { state.src = ''; state.srcName = ''; state.srcInfo = ''; save(); render(); return; }
    if (act === 'dropzone') { var f2 = byId('charaSrcFile'); if (f2) f2.click(); return; }
    if (act === 'gen-part') { genCellWait('part', el.getAttribute('data-key'), 'gen-part'); return; }
    if (act === 'gen-view') { genCellWait('view', el.getAttribute('data-key'), 'gen-view'); return; }
    if (act === 'gen-row') { genRow(el.getAttribute('data-key')); return; }
    if (act === 'mode') {
      state.mode = el.getAttribute('data-v') === 'split' ? 'split' : 'full';
      save(); render(); return;
    }
    if (act === 'gen-cand') { genCandidates(); return; }
    if (act === 'pick-cand') {
      var kind = el.getAttribute('data-kind'), i = el.getAttribute('data-i') | 0;
      state.pick[kind] = i; footMsg = ''; save(); render(); return;
    }
    if (act === 'preview3d') {
      var url = el.getAttribute('data-url');
      if (window.Model3D && Model3D.ready()) {
        footMsg = '3D 预览已打开';
        Model3D.openPreview(url, { title: '角色模型预览' }).catch(function (e2) { footMsg = '预览失败：' + friendlyErr(e2); render(); });
      } else footMsg = '3D 组件未就绪';
      render(); return;
    }
    if (act === 'quad') {
      var qurl = el.getAttribute('data-url');
      if (!(window.Model3D && Model3D.ready())) { footMsg = '3D 组件未就绪'; render(); return; }
      el.disabled = true;
      Model3D.quadViews(qurl, { size: 2048, mode: 'line' }).then(function (u) {
        var a = document.createElement('a');
        a.href = u; a.download = 'chara_quad_views.png'; a.click();
        footMsg = '四视图已导出';
      }).catch(function (e2) { footMsg = '四视图失败：' + friendlyErr(e2); })
        .then(function () { render(); });
      return;
    }
    if (act === 'export-json') { exportJSON(); return; }
    if (act === 'export-parts') { exportParts(); return; }
  }

  /* ---------- 装配 ---------- */
  function open() {
    host = byId('charaHost');
    if (!host || host.dataset.ready === '1') return;
    host.dataset.ready = '1';
    if (typeof blobEnsure === 'function') { try { blobEnsure(); } catch (e) {} }
    load();
    host.innerHTML =
      '<div class="chara-layout">' +
      '<aside class="chara-rail" id="charaRail"></aside>' +
      '<section class="chara-main">' +
      '<header class="chara-head"><b>角色工坊</b><span>插画 → 部位图 → 三视图 → 3D 候选 → 导出</span></header>' +
      '<div class="chara-body" id="charaStage"></div>' +
      '<footer class="chara-foot" id="charaFoot"></footer>' +
      '</section></div>';
    railEl = byId('charaRail');
    stageEl = byId('charaStage');
    footEl = byId('charaFoot');
    host.addEventListener('click', onClick);
    /* 拖放导入 */
    host.addEventListener('dragover', function (e) { e.preventDefault(); });
    host.addEventListener('drop', function (e) {
      e.preventDefault();
      if (state.stage !== 0) return;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importSrc(f);
    });
    render();
  }

  window.charaKit = { open: open };

  registerApp({
    id: 'chara',
    name: '角色工坊',
    title: '角色工坊',
    sub: '插画 → 部位图 → 3D 候选',
    glyph: 'chara',
    order: 15,
    cls: 'chara',
    win: 'charaWin',
    css: ['apps/chara/app.css'],
    body: '<div class="chara-host" id="charaHost"></div>',
    open: function () { open(); }
  });
})();
