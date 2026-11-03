/* 图像转 SVG App
 *
 * 一个窗口做三件事：选图 → 让 Astra 在空白画布上用钢笔工具作画 → 把本地草稿导出成 SVG。
 * 作画顺序是线稿 → 上色 → 细化 → 校验；原图只作视觉参照，不参与描图。
 * 图片只发一次（放在第一条 user 消息里），之后每轮换成「自己画布的回看」。
 * SVG 不进对话：草稿在 svg-tools.js 的本地缓存里，模型只看得到摘要。
 *
 * 依赖：
 *   llmStreamRequest / toolLoopRun / SVG_TOOLS / svgSetSource / svgDraftNew …
 *   connFor / llmConn（与主对话共用连接配置）
 */
(function (global) {
  'use strict';

  function el(id) { return document.getElementById(id); }

  const SYS = [
    '你是插画师，不是描图工具。用户给你一张参考图，你要在**一张空白画布**上从零作画：',
    '先画线稿，再上色，最后细化。参考图只用来看构图、比例、部件、颜色和文字。',
    '源图来自生图模型，可能带幻觉（多余物体/手指、粘连、断裂线条、乱码文字、穿模）：',
    '按语义画成干净的形状，不要照抄像素级错误。',
    '',
    '像人拿钢笔那样工作：',
    '1. 起稿：先 inspect_raster 看尺寸/主色/复杂分区，想好主体轮廓与主要部件；',
    '   用 draw_paths 一笔一笔画（6~12 笔一批）。曲线用锚点 + 控制柄 in/out（相对锚点的偏移），',
    '   两个柄都为 0 就是直线段。线稿默认 fill="none"、深色描边、宽度 1.5~3。',
    '2. 上色：进入上色阶段后只用 fill_regions，把颜色填进**已经闭合**的线稿路径（引用 draw_paths 返回的 path_id）。',
    '   这一阶段不许新画主体几何；缺闭合就先 edit_paths 补，再填。',
    '3. 细化：加细节线、阴影块、装饰；画歪的点用 edit_paths 移锚点/改柄/删点，不要整笔重画。',
    '4. 每画完一批调 observe_canvas：下一轮你会收到画布的真实渲染图，对照参考图检查闭合、漏色、比例。',
    '5. 收口前调 validate_canvas；gate.pass=false 时按 errors 修完再验一次，不要带着错误结束。',
    '',
    '硬性规则：',
    '- 坐标就是画布像素坐标，viewBox="0 0 W H"（W/H 来自 inspect_raster）。',
    '- 闭合形状才允许填色；填色只引用 path_id，不许新建多边形。',
    '- 图层：底色 layer-background；主体线稿/上色 layer-subject；细节 layer-detail；文字 layer-text。',
    '- 文字用 write_text（带 data-text 与 data-source-bbox），不要用 draw_paths 画字。',
    '- 禁止 <image>、<foreignObject>、<script>、外链 href、滤镜堆叠。',
    '- 任何情况下都不要在回复里贴 SVG 源码——画布在本地。',
    '',
    '阶段由系统按轮次切换：线稿 → 上色 → 细化 → 校验。这一轮看不到某个工具不代表它不存在，',
    '按工作流继续推进；不要在工具不全时收口说「做不到」。',
    '最终回复用中文，最多三行：画了什么、多少笔、还剩什么问题。'
  ].join('\n');

  /* 阶段化工具白名单：按「这一轮该干什么」切，不按固定轮数硬切。
     轮次映射在 stageForRound 里集中定义，SYS 与工具列表必须来自同一份配置。 */
  const TOOL_STAGES = [
    { key: 'sketch', label: '线稿', tools: ['inspect_raster', 'ocr_text', 'draw_paths', 'edit_paths', 'observe_canvas', 'validate_canvas'] },
    { key: 'color', label: '上色', tools: ['fill_regions', 'edit_paths', 'observe_canvas', 'validate_canvas', 'write_text'] },
    { key: 'refine', label: '细化', tools: ['inspect_raster', 'draw_paths', 'edit_paths', 'fill_regions', 'write_text', 'observe_canvas', 'validate_canvas'] },
    { key: 'verify', label: '校验', tools: ['validate_canvas', 'observe_canvas', 'edit_paths', 'fill_regions', 'write_text'] }
  ];
  let curStage = 'sketch';

  function stageForRound(round) {
    if (round >= 9) return 'verify';
    if (round >= 6) return 'refine';
    if (round >= 4) return 'color';
    return 'sketch';
  }
  function toolsForRound(round) {
    const key = stageForRound(round);
    curStage = key;
    const names = (TOOL_STAGES.find(s => s.key === key) || TOOL_STAGES[3]).tools;
    return (global.SVG_TOOLS || []).filter(t => {
      const n = (t.function && t.function.name) || t.name || '';
      return names.indexOf(n) >= 0;
    });
  }
  function stageLabel(key) {
    const s = TOOL_STAGES.find(x => x.key === key);
    return s ? s.label : '执行';
  }

  let busy = false;
  let image = null;          // { dataUrl, name, w, h, el }
  let curBubble = null;      // 当前轮的助手气泡
  let roundSeq = 0;
  let lastTask = '';         // 最近一次发送的任务文本（压缩后重建 user 消息要用）
  let memoFromModel = '';    // 首轮模型自己写的视觉记忆
  let memoFromInspect = '';  // 首轮 inspect 的事实摘要（模型没写字时兜底）

  /* ---------- 连接 ---------- */
  /* 连接：优先用「设置里的接口」（这里通常就是 Astra：视觉 + function calling），
   * 设置没填时才跟随主对话下拉选的模型。与裸聊的顺序相反是有意的——
   * 裸聊比的是「同一模型下不同请求体」，这里要的是「能看图、能调工具的模型」。 */
  function resolvedConn() {
    try {
      const c = global.llmConn();
      if (c && c.base && c.key && c.model) return c;
    } catch (e) { /* 设置还没就绪 */ }
    let val = '';
    try { val = localStorage.getItem('hf_desk_model') || ''; } catch (e) { return null; }
    if (val && typeof global.connFor === 'function') {
      try {
        const c = global.connFor(val);
        if (c && c.base && c.key && c.model) return c;
      } catch (e) {}
    }
    return null;
  }
  function connLabel() {
    const c = resolvedConn();
    if (!c || !c.model) return '未配置模型';
    const via = c.via === 'gateway' ? '网关' : c.via === 'ollama' ? 'Ollama 本地' : '自定义接口';
    const base = String(c.base || '').replace(/^https?:\/\//, '').split('/')[0];
    return via + ' · ' + c.model + (base ? ' · ' + base : '');
  }
  function syncMeta() {
    const m = el('img2svgMeta');
    if (!m) return;
    const info = typeof global.svgSourceInfo === 'function' ? global.svgSourceInfo() : null;
    m.textContent = '连接：' + connLabel() + (info ? '｜草稿 viewBox 0 0 ' + info.w + ' ' + info.h : '');
  }

  /* ---------- 日志 ---------- */
  function logBox() { return el('img2svgLog'); }

  function scrollDown() {
    const box = logBox();
    if (box) box.scrollTop = box.scrollHeight;
  }

  function bubble(role, text, imgUrl) {
    const box = logBox();
    if (!box) return null;
    const row = document.createElement('div');
    row.className = 'dchat-msg' + (role === 'user' ? ' user' : '');
    const ava = document.createElement('div');
    ava.className = 'dchat-ava' + (role === 'user' ? ' user' : '');
    ava.textContent = role === 'user' ? '你' : 'AI';
    const body = document.createElement('div');
    body.className = 'dchat-body';
    const txt = document.createElement('div');
    txt.className = 'dchat-text';
    txt.textContent = text || '';
    body.appendChild(txt);
    if (imgUrl) {
      const im = document.createElement('img');
      im.className = 'dchat-img';
      im.src = imgUrl;
      body.appendChild(im);
    }
    row.append(ava, body);
    box.appendChild(row);
    scrollDown();
    return { row: row, body: body, txt: txt };
  }

  function note(text, isErr) {
    const box = logBox();
    if (!box) return;
    const n = document.createElement('div');
    n.className = 'isvg-note' + (isErr ? ' err' : '');
    n.textContent = text;
    box.appendChild(n);
    scrollDown();
  }

  function stepRow(label) {
    const box = logBox();
    if (!box) return;
    const s = document.createElement('div');
    s.className = 'isvg-step';
    s.textContent = label;
    box.appendChild(s);
    scrollDown();
  }

  function pretty(v, max) {
    let s;
    try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 1); } catch (e) { s = String(v); }
    s = String(s == null ? '' : s);
    return s.length > (max || 2600) ? s.slice(0, max || 2600) + '\n…（已截断）' : s;
  }

  function addToolRow(evt) {
    const box = logBox();
    if (!box) return;
    const wrap = document.createElement('div');
    wrap.className = 'isvg-tool' + (evt.error ? ' err' : '');
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'isvg-tool-head';
    const ok = evt.error ? '失败' : '完成';
    head.textContent = evt.name + ' · ' + ok + ' · ' + evt.ms + 'ms';
    const bodyEl = document.createElement('pre');
    bodyEl.className = 'isvg-tool-json';
    bodyEl.hidden = true;
    bodyEl.textContent = '参数\n' + pretty(evt.args, 1200) + '\n\n结果\n' + pretty(evt.result, 3200);
    head.addEventListener('click', () => { bodyEl.hidden = !bodyEl.hidden; });
    wrap.append(head, bodyEl);
    box.appendChild(wrap);
    scrollDown();
  }

  /* ---------- 图片 ---------- */
  function setImage(src, name) {
    image = src;
    /* 换了图就是换了一份草稿：上一张的隐藏 / 隔离状态不该带到新的图上 */
    layerView.hidden = {};
    layerView.isolate = '';
    lastLayerReport = null;
    const thumb = el('img2svgThumb');
    if (thumb) {
      thumb.src = src.dataUrl;
      thumb.classList.remove('hidden');
    }
    const info = el('img2svgSrcInfo');
    if (info) info.textContent = (name || '未命名') + ' · ' + src.w + '×' + src.h;
    const clearBtn = el('img2svgClear');
    if (clearBtn) clearBtn.classList.remove('hidden');

    const img = new Image();
    img.onload = () => {
      try {
        global.svgSetSource(img, { name: name });
        image.el = img;
        const id = global.svgDraftNew(img.naturalWidth, img.naturalHeight, { name: name });
        global.svgDraftSetCurrent(id);
        const s = global.svgSourceInfo();
        note('已载入图片：' + (name || '未命名') + ' · ' + s.w + '×' + s.h
          + '（草稿 ' + id + '，viewBox 0 0 ' + s.w + ' ' + s.h + '）', false);
      } catch (e) {
        note('载入失败：' + ((e && e.message) || e), true);
      }
      resetStage();
      refreshLayers();
      syncMeta();
    };
    img.onerror = () => note('图片解码失败：换一张 PNG / JPG 试试', true);
    img.src = src.dataUrl;
  }

  function pickFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { note('只支持图片文件', true); return; }
    if (file.size > 8 * 1024 * 1024) { note('图片超过 8MB：先压缩再试（请求体太大网关会拒）', true); return; }
    const fr = new FileReader();
    fr.onload = () => {
      const url = String(fr.result || '');
      const probe = new Image();
      probe.onload = () => setImage({
        dataUrl: url, name: file.name,
        w: probe.naturalWidth, h: probe.naturalHeight
      }, file.name);
      probe.onerror = () => note('图片解码失败', true);
      probe.src = url;
    };
    fr.onerror = () => note('读取文件失败', true);
    fr.readAsDataURL(file);
  }

  function clearImage() {
    if (busy) return;
    image = null;
    memoFromModel = ''; memoFromInspect = '';
    const thumb = el('img2svgThumb');
    if (thumb) { thumb.src = ''; thumb.classList.add('hidden'); }
    const info = el('img2svgSrcInfo');
    if (info) info.textContent = '未选择图片';
    const clearBtn = el('img2svgClear');
    if (clearBtn) clearBtn.classList.add('hidden');
    lastLayerReport = null;
    resetStage();
    refreshLayers();
    syncMeta();
  }

  /* ---------- 工作记忆 ----------
   * 不再是「原图差异裁剪」，而是「自己画布的回看」：
   * observe_canvas 把渲染图存在本地草稿里，这里在下一轮请求中把它作为附图发出去。
   * 前两轮也保留原图参照，避免模型在还没画几笔时就丢掉构图。 */
  function briefRect(r) {
    return [r.x, r.y, r.w, r.h].map(v => Math.round(v)).join(',');
  }

  function buildMemoFromInspect(res) {
    if (!res) return '';
    const img = res.image || {};
    const pal = (res.palette || []).slice(0, 3)
      .map(p => p.hex + ' ' + Math.round((p.share || 0) * 100) + '%').join('、');
    const regs = (res.regions || []).slice(0, 3).map(r => '(' + briefRect(r) + ')').join('、');
    return '图 ' + img.w + '×' + img.h + '；主色 ' + (pal || '?') + '；复杂区域 ' + (regs || '无');
  }

  function memoText() {
    return memoFromModel || memoFromInspect || ('图 ' + (image ? image.w + '×' + image.h : '?'));
  }

  /* toolLoopRun 在 round >= keepImageRounds 时调用；返回 null 则继续用窗口里的历史消息。 */
  function imageForRound(state) {
    const id = draftId();
    let shot = null;
    try { shot = global.svgDraftShot ? global.svgDraftShot(id) : null; } catch (e) { shot = null; }
    if (shot && shot.url && state.round >= 1) {
      return {
        role: 'user',
        content: [
          {
            type: 'text',
            text: lastTask + '\n\n[画布回看] 这是你上一批工具之后画布的真实渲染（'
              + (shot.size || []).join('×') + '）'
              + (shot.stale ? '，但之后画布又改过，以最新工具结果为准' : '')
              + '。对照参考图检查：线稿闭合了吗、颜色漏了吗、比例走样了吗。'
          },
          { type: 'image_url', image_url: { url: shot.url } }
        ]
      };
    }
    if (image && image.dataUrl && state.round < 2) {
      return {
        role: 'user',
        content: [
          { type: 'text', text: lastTask + '\n\n[原图参考] ' + memoText() },
          { type: 'image_url', image_url: { url: image.dataUrl } }
        ]
      };
    }
    return null;
  }

  function addMemoryNote(res) {
    const mem = res && res.memory;
    if (!mem) return;
    const ledger = (mem.ledger || []).slice(-8);
    const neg = mem.negatives || [];
    if (!ledger.length && !neg.length) return;
    const box = logBox();
    if (!box) return;
    const wrap = document.createElement('div');
    wrap.className = 'isvg-mem';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'isvg-tool-head';
    head.textContent = '工作记忆 · 账本 ' + ledger.length + (neg.length ? ' · 已排除 ' + neg.length : '');
    const pre = document.createElement('pre');
    pre.className = 'isvg-tool-json';
    pre.hidden = true;
    pre.textContent = (ledger.length ? ledger.join('\n') : '（空）')
      + (neg.length ? '\n\n已排除：\n' + neg.join('\n') : '');
    head.addEventListener('click', () => { pre.hidden = !pre.hidden; });
    wrap.append(head, pre);
    box.appendChild(wrap);
    scrollDown();
  }

  /* ---------- 结果卡片 ---------- */
  function lastScores(calls) {
    let canvas = null, validate = null;
    (calls || []).forEach(c => {
      if (c.name === 'validate_canvas' && c.result) canvas = c.result;
      if (c.name === 'validate_svg' && c.result) validate = c.result;
    });
    return { canvas: canvas, validate: validate };
  }

  function addResultCard(calls) {
    const svg = global.svgDraftToSvg();
    if (!svg) return;
    const sc = lastScores(calls);
    const box = logBox();
    if (!box) return;

    const card = document.createElement('div');
    card.className = 'isvg-result';

    const head = document.createElement('div');
    head.className = 'isvg-result-head';
    const title = document.createElement('span');
    title.textContent = '生成结果';
    const badge = document.createElement('span');
    badge.className = 'isvg-badge';
    if (sc.canvas && sc.canvas.checks) {
      badge.textContent = (sc.canvas.gate && sc.canvas.gate.pass ? '通过' : '待修')
        + ' · ' + sc.canvas.checks.paths + ' 笔 · 填色 ' + sc.canvas.checks.filled;
      badge.classList.toggle('warn', !(sc.canvas.gate && sc.canvas.gate.pass));
    } else {
      badge.textContent = '未验收';
      badge.classList.add('warn');
    }
    head.append(title, badge);

    const preview = document.createElement('div');
    preview.className = 'isvg-preview';
    const im = document.createElement('img');
    im.alt = 'SVG 预览';
    im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    preview.appendChild(im);

    const warnList = sc.canvas
      ? ((sc.canvas.gate && sc.canvas.gate.reasons) || sc.canvas.errors || [])
      : ((sc.validate && !sc.validate.ok)
        ? (sc.validate.errors || []).concat(sc.validate.warnings || []) : []);
    if (warnList.length) {
      const warn = document.createElement('div');
      warn.className = 'isvg-result-warn';
      warn.textContent = '校验未通过：' + warnList.slice(0, 3).join('；') + (warnList.length > 3 ? ' …' : '');
      preview.appendChild(warn);
    }

    const bar = document.createElement('div');
    bar.className = 'isvg-result-bar';
    const dl = document.createElement('button');
    dl.type = 'button';
    dl.className = 'btn sm primary';
    dl.textContent = '下载 SVG';
    dl.addEventListener('click', () => {
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = ((image && image.name) || 'traced').replace(/\.(png|jpg|jpeg|webp|gif)$/i, '') + '.svg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn sm';
    copy.textContent = '复制源码';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(svg);
        copy.textContent = '已复制';
        setTimeout(() => { copy.textContent = '复制源码'; }, 1500);
      } catch (e) { note('复制失败：' + ((e && e.message) || e), true); }
    });
    const peek = document.createElement('button');
    peek.type = 'button';
    peek.className = 'btn sm';
    peek.textContent = '查看源码';
    peek.addEventListener('click', () => {
      const pre = document.createElement('pre');
      pre.className = 'isvg-source';
      pre.textContent = svg;
      card.insertBefore(pre, bar);
    });

    bar.append(dl, copy, peek);
    card.append(head, preview, bar);
    box.appendChild(card);
    scrollDown();
  }

  /* ---------- 图层面板 / 分层导出 / 差异叠加 ----------
   * 面板只读本地草稿（svgDraftLayers 走 DOM，不栅格化），每次工具调用后刷新。
   * 预览用 svgDraftSvgForView：隐藏的层直接不渲染，隔离时只留一层——
   * 和导出共用同一条 keep 逻辑，面板里看到的就是下载得到的那一份。 */
  const LAYER_META = [
    { id: 'layer-background', name: '背景', short: 'bg' },
    { id: 'layer-subject', name: '主体', short: 'sj' },
    { id: 'layer-detail', name: '细节', short: 'dt' },
    { id: 'layer-text', name: '文字', short: 'tx' }
  ];
  const layerView = { hidden: {}, isolate: '', overlay: 55 };
  let lastLayerReport = null;

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function draftId() {
    try { return (global.svgDraftCurrentId && global.svgDraftCurrentId()) || ''; } catch (e) { return ''; }
  }
  function fileBase() {
    return ((image && image.name) || 'traced').replace(/\.(png|jpg|jpeg|webp|gif)$/i, '');
  }
  function saveBlob(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function saveText(name, text, mime) {
    saveBlob(name, new Blob([text], { type: mime || 'text/plain' }));
  }
  function saveUrl(name, url) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
  }
  function kb(n) {
    return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
  }

  function buildOverlay(struct, svg) {
    const wrap = mk('div', 'isvg-overlay');
    const stack = mk('div', 'isvg-overlay-stack');
    if (image && image.dataUrl) {
      const src = mk('img', 'isvg-overlay-src');
      src.src = image.dataUrl;
      src.alt = '原图';
      stack.appendChild(src);
    }
    const layer = mk('img', 'isvg-overlay-svg');
    layer.alt = 'SVG 预览';
    layer.style.opacity = String(layerView.overlay / 100);
    if (svg) layer.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    stack.appendChild(layer);
    wrap.appendChild(stack);

    const bar = mk('div', 'isvg-overlay-bar');
    const range = document.createElement('input');
    range.type = 'range';
    range.className = 'isvg-overlay-range';
    range.min = '0'; range.max = '100';
    range.value = String(layerView.overlay);
    range.title = '拖动对照：左边只看原图，右边只看 SVG';
    const val = mk('span', 'isvg-overlay-val', layerView.overlay + '%');
    range.addEventListener('input', () => {
      layerView.overlay = Number(range.value);
      applyOverlay();
    });
    bar.append(mk('span', 'isvg-overlay-lab', '对照'), range, val);
    wrap.appendChild(bar);
    return wrap;
  }

  /* 对照滑块只留在图层面板里：画布上的 SVG 直接盖在原图上，不做半透明混合——
     用户要看的是「AI 正在画什么」，不是「和原图像不像」。 */
  function applyOverlay() {
    const pct = layerView.overlay + '%';
    const imgs = document.querySelectorAll('.isvg-overlay-svg');
    for (let i = 0; i < imgs.length; i++) imgs[i].style.opacity = String(layerView.overlay / 100);
    const vals = document.querySelectorAll('.isvg-overlay-val');
    for (let i = 0; i < vals.length; i++) vals[i].textContent = pct;
    const ranges = document.querySelectorAll('.isvg-overlay-range');
    for (let i = 0; i < ranges.length; i++) {
      if (Number(ranges[i].value) !== layerView.overlay) ranges[i].value = String(layerView.overlay);
    }
  }

  /* ---------- 实时画布：状态条 + 重绘 ---------- */
  let taskClock = null;
  let taskStart = 0;

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function setBadge(text, cls) {
    const b = el('img2svgStageBadge');
    if (!b) return;
    b.textContent = text;
    b.className = 'isvg-stage-badge ' + (cls || 'idle');
  }
  function setStageField(id, text, hide) {
    const n = el(id);
    if (!n) return;
    if (text != null) n.textContent = text;
    n.classList.toggle('hidden', !!hide);
  }
  /* 状态条上的画布事实：钢笔路线里没有「分数」，只有可核对的数字。
     validate_canvas 回来时显示 笔/闭合/填色 与是否通过，draw_paths 回来时只显示笔数。 */
  function setStageInfo(res) {
    if (!res) return;
    if (res.checks) {
      setStageField('img2svgStageScore',
        '笔 ' + res.checks.paths + ' · 闭合 ' + res.checks.closed + ' · 填色 ' + res.checks.filled
        + (res.gate && res.gate.pass ? ' · 通过' : ' · 待修'), false);
      return;
    }
    if (res.total_paths != null) {
      setStageField('img2svgStageScore', '笔 ' + res.total_paths, false);
    }
  }
  function startClock() {
    stopClock();
    taskStart = Date.now();
    setStageField('img2svgStageTime', '00:00', false);
    taskClock = setInterval(() => {
      const s = Math.floor((Date.now() - taskStart) / 1000);
      setStageField('img2svgStageTime', pad2(Math.floor(s / 60)) + ':' + pad2(s % 60), false);
    }, 500);
  }
  function stopClock() {
    if (taskClock) { clearInterval(taskClock); taskClock = null; }
  }
  /* 回到待机：换图 / 清图 / 首次打开都走这里，别让上一张图的轮次和分数留在画布上 */
  function resetStage() {
    stopClock();
    setBadge('待开始', 'idle');
    setStageField('img2svgStageRound', '—', true);
    setStageField('img2svgStageTool', '', true);
    setStageField('img2svgStageScore', '', true);
    setStageField('img2svgStageTime', '00:00', true);
  }

  function renderStage(svg) {
    const src = el('img2svgStageSrc');
    const layer = el('img2svgStageSvg');
    const empty = el('img2svgStageEmpty');
    if (!src || !layer || !empty) return;
    if (image && image.dataUrl) {
      if (src.getAttribute('src') !== image.dataUrl) src.src = image.dataUrl;
      src.classList.remove('hidden');
    } else {
      src.removeAttribute('src');
      src.classList.add('hidden');
    }
    if (svg && image) {
      layer.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      layer.classList.remove('hidden');
      empty.classList.add('hidden');
    } else {
      layer.removeAttribute('src');
      layer.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.textContent = image ? '已载入原图，等待 AI 开始绘制' : '选一张图，按 Send 开始';
    }
  }

  function buildLayerRows(struct) {
    const list = mk('div', 'isvg-layer-list');
    LAYER_META.forEach((meta, idx) => {
      const st = struct.layers.find(l => l.id === meta.id) || {};
      const hidden = !!layerView.hidden[meta.id];
      const present = !!st.present;
      const row = mk('div', 'isvg-layer-row');
      row.dataset.layer = meta.id;
      if (hidden) row.classList.add('off');
      if (!present) row.classList.add('missing');
      if (layerView.isolate === meta.id) row.classList.add('iso');

      const eye = mk('button', 'isvg-eye', hidden ? '○' : '●');
      eye.type = 'button';
      eye.setAttribute('aria-pressed', hidden ? 'false' : 'true');
      eye.title = hidden ? '显示这一层' : '隐藏这一层';
      eye.addEventListener('click', () => {
        if (hidden) delete layerView.hidden[meta.id];
        else layerView.hidden[meta.id] = true;
        refreshLayers();
      });

      const iso = mk('button', 'isvg-iso', layerView.isolate === meta.id ? '还原' : '隔离');
      iso.type = 'button';
      iso.title = '只看这一层（再点一次回到全部）';
      iso.addEventListener('click', () => {
        layerView.isolate = layerView.isolate === meta.id ? '' : meta.id;
        refreshLayers();
      });

      const head = mk('div', 'isvg-layer-head');
      head.append(eye, mk('span', 'isvg-layer-name', (idx + 1) + ' · ' + meta.name), iso);

      const stat = mk('div', 'isvg-layer-stat',
        present
          ? st.paths + ' 路径' + (st.texts ? ' · ' + st.texts + ' 文字' : '') + ' · ' + kb(st.bytes)
          : '缺这一层');
      const bb = mk('div', 'isvg-layer-bbox',
        st.bbox ? 'bbox ' + [st.bbox.x, st.bbox.y, st.bbox.w, st.bbox.h].map(Math.round).join(' ')
          : '尚无路径');

      const metaRow = mk('div', 'isvg-layer-meta');
      metaRow.append(stat, bb);
      /* 覆盖率 / 遮挡率来自 layer_report（点「消融」或模型调用后才有一份） */
      const rp = lastLayerReport && lastLayerReport.draft_id === struct.draft_id ? lastLayerReport : null;
      if (rp) {
        const cov = (rp.layers || []).find(l => l.layer === meta.id);
        const occ = (rp.occlusion || []).find(o => o.layer === meta.id);
        if (cov) {
          metaRow.appendChild(mk('span', 'isvg-layer-stat',
            '覆盖 ' + Math.round((cov.covered_ratio || 0) * 100) + '%'
            + (occ ? ' · 遮挡 ' + Math.round((occ.ratio || 0) * 100) + '%' : '')));
        }
      }
      (st.colors || []).slice(0, 5).forEach(c => {
        const chip = mk('span', 'isvg-color');
        chip.style.background = c.hex;
        chip.title = c.hex + ' ×' + c.count;
        metaRow.appendChild(chip);
      });

      const acts = mk('div', 'isvg-layer-acts');
      const svgBtn = mk('button', 'isvg-mini', 'SVG');
      svgBtn.type = 'button';
      svgBtn.title = '导出这一层（保留合并稿的 viewBox）';
      svgBtn.disabled = !present;
      svgBtn.addEventListener('click', () => exportLayerSvg(meta));
      const pngBtn = mk('button', 'isvg-mini', 'PNG');
      pngBtn.type = 'button';
      pngBtn.title = '导出这一层的透明底 PNG';
      pngBtn.disabled = !present;
      pngBtn.addEventListener('click', () => exportLayerPng(meta));
      acts.append(svgBtn, pngBtn);

      row.append(head, metaRow, acts);
      list.appendChild(row);
    });
    return list;
  }

  function buildAblation(struct) {
    const r = lastLayerReport;
    if (!r || r.draft_id !== struct.draft_id || !(r.ablation || []).length) return null;
    const box = mk('div', 'isvg-ablation');
    box.title = '隐藏某一层后的总分变化：负号 = 掉分，说明这层有用；正号 = 隐藏后反而更好';
    box.appendChild(mk('div', 'isvg-ablation-head', '消融 · score ' + r.global_score));
    r.ablation.forEach(a => {
      const row = mk('div', 'isvg-ablation-row');
      const nm = (LAYER_META.find(m => m.id === a.hidden) || {}).name || a.hidden;
      const shift = a.delta > 0 ? '−' + a.delta.toFixed(3) : a.delta < 0 ? '+' + (-a.delta).toFixed(3) : '±0';
      const cls = a.delta >= 0.02 ? ' good' : a.delta <= 0 ? ' bad' : '';
      row.append(mk('span', 'isvg-ablation-name', nm), mk('span', 'isvg-ablation-delta' + cls, shift));
      box.appendChild(row);
    });
    return box;
  }

  function buildLayerFoot(struct) {
    const foot = mk('div', 'isvg-layers-foot');
    const merged = mk('button', 'btn sm', '合并 SVG');
    merged.type = 'button';
    merged.title = '导出四层合并的最终 SVG';
    merged.addEventListener('click', () => {
      try {
        const e = global.svgDraftExport(struct.draft_id, {});
        saveText(fileBase() + '.svg', e.svg, 'image/svg+xml');
        note('已导出合并 SVG：' + kb(e.bytes), false);
      } catch (err) { note('导出失败：' + ((err && err.message) || err), true); }
    });
    const ab = mk('button', 'btn sm', '消融');
    ab.type = 'button';
    ab.title = '逐层隐藏并重算分数（较慢，算完显示每层掉多少分）';
    ab.addEventListener('click', () => runAblation(ab));
    foot.append(merged, ab);
    return foot;
  }

  function refreshLayers() {
    const body = el('img2svgLayersBody');
    if (!body) return;
    const id = draftId();
    const undoBtn = el('img2svgUndo');
    if (undoBtn) {
      undoBtn.disabled = !(id && typeof global.svgDraftCanUndo === 'function' && global.svgDraftCanUndo(id));
    }
    let struct = null;
    if (id && typeof global.svgDraftLayers === 'function') {
      try { struct = global.svgDraftLayers(id); } catch (e) { struct = null; }
    }
    /* 预览 SVG 只算一次：画布和面板都用这一份，避免同一张大图编码两遍 */
    let svg = '';
    if (struct && typeof global.svgDraftSvgForView === 'function') {
      try {
        svg = global.svgDraftSvgForView(struct.draft_id, {
          hidden: Object.keys(layerView.hidden), isolate: layerView.isolate
        });
      } catch (e) { svg = ''; }
    }
    /* 一条路径都没有时画布显示空状态，而不是一张透明 SVG：
       否则「已载入、还没开始画」和「画完了但全是空白」看起来一模一样。
       present 只表示该层 <g> 存在（骨架里四层都有），要看 shapes 才准。 */
    const hasPaint = !!(struct && (struct.layers || []).some(l => (l.shapes || 0) > 0));
    body.innerHTML = '';
    if (!struct) {
      body.appendChild(mk('div', 'isvg-layer-empty', image ? '草稿准备中…' : '还没有草稿：先选一张图'));
      renderStage('');
      return;
    }
    body.appendChild(buildOverlay(struct, svg));
    body.appendChild(mk('div', 'isvg-layers-order',
      '层序 ' + LAYER_META.map(m => m.short).join(' → ') + '（自底向上）'));
    body.appendChild(buildLayerRows(struct));
    const abl = buildAblation(struct);
    if (abl) body.appendChild(abl);
    body.appendChild(buildLayerFoot(struct));
    renderStage(hasPaint ? svg : '');
  }

  function exportLayerSvg(meta) {
    const id = draftId();
    if (!id) { note('还没有草稿', true); return; }
    try {
      const e = global.svgDraftExport(id, { layer: meta.id });
      saveText(fileBase() + '-' + meta.short + '.svg', e.svg, 'image/svg+xml');
      note('已导出 ' + meta.name + ' 层 SVG：' + kb(e.bytes), false);
    } catch (err) { note('导出失败：' + ((err && err.message) || err), true); }
  }

  async function exportLayerPng(meta) {
    const id = draftId();
    if (!id) { note('还没有草稿', true); return; }
    try {
      const url = await global.svgDraftPng(id, { layer: meta.id, transparent: true });
      saveUrl(fileBase() + '-' + meta.short + '.png', url);
      note('已导出 ' + meta.name + ' 层 PNG（透明底）', false);
    } catch (err) { note('导出失败：' + ((err && err.message) || err), true); }
  }

  async function runAblation(btn) {
    const id = draftId();
    if (!id) return;
    btn.disabled = true;
    btn.textContent = '消融中…';
    try {
      lastLayerReport = await global.svgToolRun('layer_report', { draft_id: id, with_ablation: true });
      note('消融完成：' + lastLayerReport.ablation.map(a => {
        const nm = (LAYER_META.find(m => m.id === a.hidden) || {}).name || a.hidden;
        return nm + (a.delta > 0 ? ' 隐藏掉 ' + a.delta.toFixed(3) : ' 无影响');
      }).join('；'), false);
    } catch (err) {
      note('消融失败：' + ((err && err.message) || err), true);
    }
    refreshLayers();
  }

  /* ---------- 发送 ---------- */
  function setBusy(on) {
    busy = on;
    const btn = el('img2svgSend');
    if (btn) { btn.disabled = on; btn.textContent = on ? '…' : 'Send'; }
  }

  async function send() {
    if (busy) return;
    if (typeof global.toolLoopRun !== 'function') { note('工具循环未加载（tool-loop.js）', true); return; }
    if (typeof global.svgSetSource !== 'function') { note('工具层未加载（svg-tools.js）', true); return; }
    if (!image) { note('先选择一张图片', true); return; }

    const ta = el('img2svgText');
    const prompt = constText(ta ? String(ta.value || '').trim() : '');
    if (ta) { ta.value = ''; ta.style.height = ''; }

    bubble('user', prompt, image.dataUrl);
    note('图像 ' + image.w + '×' + image.h + '｜线稿→上色→细化→校验｜工具往返上限 10 次｜SVG 只在本地生成', false);

    setBusy(true);
    roundSeq = 0;
    curBubble = null;
    memoFromModel = '';
    memoFromInspect = '';
    lastTask = prompt;

    /* 状态条：从「线稿」开始计时。画布本身由 refreshLayers 重绘，
       每次工具回来都会调用，所以这里只负责文字与时间。 */
    let failed = false;
    curStage = 'sketch';
    setBadge(stageLabel(curStage) + '中', 'run');
    setStageField('img2svgStageRound', '第 1 轮', false);
    setStageField('img2svgStageTool', '等待模型…', false);
    setStageField('img2svgStageScore', '', true);
    startClock();

    const userText = prompt + '\n\n[图像信息] ' + image.w + '×' + image.h + ' 像素';
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: image.dataUrl } }
      ]
    }];

    let calls = [];
    try {
      const res = await global.toolLoopRun({
        sys: SYS,
        messages: messages,
        conn: resolvedConn(),
        tools: global.SVG_TOOLS,
        toolsForRound: toolsForRound,
        maxRounds: 10,
        /* 首轮带原图做参照；之后切到「自己画布的回看」，不重发原图（省 token，也让模型看的是当前进度） */
        keepImageRounds: 1,
        imageForRound: imageForRound,
        onRound: ev => {
          if (ev.phase === 'request') {
            roundSeq++;
            setBadge(stageLabel(curStage) + '中', 'run');
            setStageField('img2svgStageRound', '第 ' + roundSeq + ' 轮', false);
            setStageField('img2svgStageTool', '等待模型…', false);
            stepRow('第 ' + roundSeq + ' 轮工具往返 · ' + stageLabel(curStage));
            curBubble = bubble('assistant', '');
          } else if (ev.phase === 'final') {
            roundSeq++;
            setBadge('收口中', 'run');
            setStageField('img2svgStageRound', '第 ' + roundSeq + ' 轮 · 收口', false);
            setStageField('img2svgStageTool', '不再提供工具', false);
            stepRow('收口：不再提供工具');
            curBubble = bubble('assistant', '');
          } else if (ev.phase === 'tools') {
            setStageField('img2svgStageTool',
              '执行 ' + ((ev.toolCalls || []).length) + ' 个工具…', false);
            /* 首轮正文顺手存成视觉记忆：模型自己看的比我拼的准；
               它没写字时再用 inspect 的事实兜底。 */
            if (ev.round === 0 && curBubble) {
              const t = String(curBubble.txt.textContent || '').trim();
              if (t) memoFromModel = t.slice(0, 300);
            }
            // 只调工具、没吐正文的轮次不该留一个空气泡
            if (curBubble && !String(curBubble.txt.textContent || '').trim()) curBubble.row.remove();
            curBubble = null;
          }
        },
        onDelta: (full, delta) => {
          if (!curBubble) curBubble = bubble('assistant', '');
          curBubble.txt.textContent = full || '';
          scrollDown();
        },
        onToolStart: evt => {
          setStageField('img2svgStageTool', evt.name + ' 执行中…', false);
        },
        onTool: evt => {
          const r = evt.result || {};
          if (evt.name === 'inspect_raster' && !evt.error && !memoFromInspect) {
            memoFromInspect = buildMemoFromInspect(evt.result);
          }
          /* 模型调过 layer_report 就把覆盖率/遮挡率留在面板上，不用用户再点一次消融 */
          if (evt.name === 'layer_report' && !evt.error && evt.result) lastLayerReport = evt.result;
          if (evt.name === 'draw_paths' && !evt.error) setStageInfo(r);
          if (evt.name === 'validate_canvas' && !evt.error) setStageInfo(r);
          if (evt.name === 'fill_regions' && !evt.error) {
            setStageField('img2svgStageScore',
              '填色 ' + (r.applied || 0) + (r.rejected ? ' · 拒 ' + r.rejected : ''), false);
          }
          if (evt.name === 'observe_canvas' && !evt.error) {
            setStageField('img2svgStageScore', '回看 ' + ((r.size || []).join('×') || '?'), false);
          }
          setStageField('img2svgStageTool',
            evt.name + ' · ' + (evt.error ? '失败' : '完成 ' + evt.ms + 'ms'), false);
          addToolRow(evt);
          refreshLayers();
        }
      });
      calls = res.calls || [];
      if (res.exhausted) note('已到 10 次工具往返上限，模型被强制收口', true);
      if (res.text && !curBubble) bubble('assistant', res.text);
      if (res.text && curBubble) curBubble.txt.textContent = res.text;
      addMemoryNote(res);
      addResultCard(calls);
    } catch (e) {
      failed = true;
      const msg = (e && e.message) || String(e);
      if (curBubble) {
        curBubble.body.classList.add('error');
        curBubble.txt.textContent = msg;
      } else {
        note(msg, true);
      }
      setBadge('失败', 'err');
      setStageField('img2svgStageTool', '中断：' + msg.slice(0, 48), false);
    } finally {
      stopClock();
      if (!failed) {
        setBadge('完成', 'ok');
        setStageField('img2svgStageTool', '收尾：' + calls.length + ' 次工具调用', false);
      }
      setBusy(false);
      refreshLayers();
      syncMeta();
    }
  }

  function constText(s) {
    return s || '在空白画布上重画这张图：先线稿，再上色，最后细化。源图只作视觉参考，画成干净的分层矢量。';
  }

  /* ---------- 初始化 ---------- */
  function init() {
    const pick = el('img2svgPick');
    const file = el('img2svgFile');
    const sendBtn = el('img2svgSend');
    const ta = el('img2svgText');
    const clearBtn = el('img2svgClear');
    const closeBtn = el('btnImg2SvgClose');
    const win = el('img2svgWin');

    if (pick && file) pick.addEventListener('click', () => file.click());
    if (file) file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      file.value = '';
      pickFile(f);
    });
    if (sendBtn) sendBtn.addEventListener('click', send);
    if (clearBtn) clearBtn.addEventListener('click', clearImage);
    if (closeBtn) closeBtn.addEventListener('click', () => {
      if (typeof global.deskCloseWin === 'function') global.deskCloseWin(el('img2svgWin'));
    });
    const layersPanel = el('img2svgLayers');
    const layersToggle = el('img2svgLayersToggle');
    if (layersPanel && layersToggle) {
      layersToggle.addEventListener('click', () => {
        const collapsed = layersPanel.classList.toggle('collapsed');
        layersToggle.textContent = collapsed ? '展开' : '收起';
        layersToggle.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
      });
    }
    /* 撤销：一次工具写入（trace / write_text / append）一步，改坏了不用重跑整轮 */
    const undoBtn = el('img2svgUndo');
    if (undoBtn) {
      undoBtn.addEventListener('click', () => {
        if (busy) return;
        const id = draftId();
        if (!id || typeof global.svgDraftUndo !== 'function') return;
        try {
          const r = global.svgDraftUndo(id);
          if (r && r.undone) {
            lastLayerReport = null;
            refreshLayers();
            note('已撤销：' + (r.tag || '上一次写入') + (r.remaining ? '（还能退 ' + r.remaining + ' 步）' : ''), false);
          } else {
            note('没有可撤销的步骤', false);
          }
        } catch (e) {
          note('撤销失败：' + ((e && e.message) || e), true);
        }
      });
    }
    if (ta) {
      ta.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); send(); }
      });
      ta.addEventListener('input', () => {
        ta.style.height = 'auto';
        ta.style.height = Math.min(160, ta.scrollHeight) + 'px';
      });
    }
    if (win) {
      win.addEventListener('dragover', e => { e.preventDefault(); win.classList.add('drag'); });
      win.addEventListener('dragleave', () => win.classList.remove('drag'));
      win.addEventListener('drop', e => {
        e.preventDefault();
        win.classList.remove('drag');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        pickFile(f);
      });
    }
    resetStage();
    refreshLayers();
    applyOverlay();
    syncMeta();
  }

  function focus() {
    syncMeta();
    const ta = el('img2svgText');
    if (ta) setTimeout(() => ta.focus(), 60);
  }

  /* refresh / toolsForRound 供测试脚本与外部工具调用：
     面板内容完全由本地草稿推导，重复刷新是幂等的；工具白名单是纯函数，不碰网络 */
  global.img2svgApp = {
    open: focus, focus: focus, send: send, refresh: refreshLayers, view: layerView,
    toolsForRound: toolsForRound, stages: TOOL_STAGES
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
