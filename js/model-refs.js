/* 模型参考图（结构参考 / 着色参考）
 *
 * 为什么要分两类：
 *   结构参考 = 形体、比例、剪影（同一角色的三视图 / 素模白模）；
 *   着色参考 = 配色、贴图、材质（原画上色稿）。
 *   AI 干活的顺序是「先定形、再上色」，两类混成一张图会让它同时猜两件事，结果两边都不准。
 *
 * 为什么存成图片资产、localStorage 只记 id：
 *   一张参考图 base64 动辄 1~3MB，localStorage 上限约 5MB，两张就把整个应用的存储挤爆。
 *   所以图走 assetPut（跟图库同一个库），localStorage 里只留
 *   { 模型资产 id → { struct:图片资产id, color:图片资产id } } 这种几十字节的索引。
 *
 * 对外（给 AI / 工作流用）：
 *   ModelRefs.forAI(modelAssetId) → { structure:{id,name,dataURL}, color:{...} }
 *   参考图面板上的「发到 AI 对话」会派发 openagi:model-refs 事件，desk-chat 收到后自动附图。
 */
(function(global){
  'use strict';

  const MAP_KEY = 'openagi/modelrefs';       // { modelId: { struct: assetId, color: assetId } }
  const KINDS = ['struct', 'color'];
  const LABEL = { struct: '结构参考', color: '着色参考' };
  const HINT = { struct: '形体 / 比例 / 剪影', color: '配色 / 贴图 / 材质' };
  const MAX_EDGE = 1024;                     // 参考图只看细节，不需要原图分辨率

  function readMap(){
    try{
      const raw = localStorage.getItem(MAP_KEY);
      const o = raw ? JSON.parse(raw) : {};
      return (o && typeof o === 'object') ? o : {};
    }catch(e){ return {}; }
  }
  function writeMap(m){
    try{ localStorage.setItem(MAP_KEY, JSON.stringify(m)); }catch(e){}
  }
  function desk(){
    const d = global.openagiDesktop;
    return (d && typeof d.assetPut === 'function') ? d : null;
  }

  /* 参考图 → 资产 id（列表里能查到名字 / 大小，也就能被图库统一管理） */
  function get(modelId){
    const m = readMap()[String(modelId || '')] || {};
    const out = {};
    KINDS.forEach(k => { if(m[k]) out[k] = String(m[k]); });
    return out;
  }
  function set(modelId, kind, assetId){
    if(!modelId || KINDS.indexOf(kind) < 0) return get(modelId);
    const map = readMap();
    const cur = map[String(modelId)] || {};
    if(assetId) cur[kind] = String(assetId);
    else delete cur[kind];
    if(Object.keys(cur).length) map[String(modelId)] = cur;
    else delete map[String(modelId)];
    writeMap(map);
    return get(modelId);
  }
  function clear(modelId, kind){
    return kind ? set(modelId, kind, '') : set(modelId, '', '');
  }
  function has(modelId){
    const g = get(modelId);
    return !!(g.struct || g.color);
  }

  /* 长边压到 1024：参考图是给 AI 看轮廓和配色的，压完 200KB 左右，
   * 既不占空间也不影响判断（原图动辄 4000px 对模型没有任何额外信息）。 */
  function shrink(dataURL, maxEdge){
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, (maxEdge || MAX_EDGE) / Math.max(w, h));
        if(scale >= 0.999){ resolve(dataURL); return; }
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try{ resolve(c.toDataURL('image/jpeg', 0.9)); }catch(e){ resolve(dataURL); }
      };
      img.onerror = () => resolve(dataURL);
      img.src = dataURL;
    });
  }

  function fileToDataURL(file){
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('读取文件失败'));
      r.readAsDataURL(file);
    });
  }

  /* 上传 → 压图 → 入资产库 → 记索引。返回新的索引对象。 */
  async function upload(modelId, kind, file, modelName){
    if(!modelId) throw new Error('没有选中模型');
    if(KINDS.indexOf(kind) < 0) throw new Error('未知的参考图类型');
    const d = desk();
    if(!d) throw new Error('资产库未就绪（需要在桌面端运行）');
    const raw = await fileToDataURL(file);
    const small = await shrink(raw);
    const base = String(modelName || modelId).replace(/\.[^.]+$/, '');
    const r = await d.assetPut({
      kind: 'image',
      data: small,
      ext: /^data:image\/png/i.test(small) ? 'png' : 'jpg',
      name: base + '_' + LABEL[kind] + (/^data:image\/png/i.test(small) ? '.png' : '.jpg'),
      source: 'ref'
    });
    if(!r || !r.ok || !r.asset) throw new Error((r && r.error) || '写入资产库失败');
    return set(modelId, kind, r.asset.id);
  }

  /* 给 AI / 工作流：把两张参考图读成 dataURL（不存在的槽位返回 null） */
  async function forAI(modelId){
    const ids = get(modelId);
    const d = desk();
    const out = { modelId: String(modelId || ''), structure: null, color: null };
    if(!d || !ids) return out;
    for(const k of KINDS){
      if(!ids[k]) continue;
      let r = null;
      try{ r = await d.assetRead(ids[k]); }catch(e){ r = null; }
      if(!r || !r.ok || !r.dataURL) continue;
      const item = { id: ids[k], dataURL: r.dataURL, name: LABEL[k] };
      if(k === 'struct') out.structure = item; else out.color = item;
    }
    return out;
  }

  /* ---------- 面板 ---------- */
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* 在 host（3D 视口 stage）里开一个右侧抽屉。样式在 css/02-console.css 的 .mref-* 里。 */
  function panel(host, opts){
    opts = opts || {};
    const modelId = String(opts.modelId || '');
    const modelName = String(opts.modelName || '');
    if(!host) return null;
    const old = host.querySelector('.mref-drawer');
    if(old) old.remove();

    const el = document.createElement('div');
    el.className = 'mref-drawer';
    host.appendChild(el);

    let thumbs = {};       // kind -> dataURL（缩略显示用）

    async function refresh(){
      const ids = get(modelId);
      thumbs = {};
      if(desk()){
        for(const k of KINDS){
          if(!ids[k]) continue;
          try{
            const r = await desk().assetRead(ids[k]);
            if(r && r.ok && r.dataURL) thumbs[k] = r.dataURL;
          }catch(e){}
        }
      }
      paint();
      if(typeof opts.onChange === 'function') opts.onChange(ids);
    }

    function slotHtml(k){
      const img = thumbs[k];
      return '<div class="mref-slot' + (img ? ' has' : '') + '" data-mref-kind="' + k + '">' +
        '<div class="mref-thumb">' +
          (img ? '<img src="' + img + '" alt="">' : '<span class="mref-ph">' + (k === 'struct' ? '◇' : '◈') + '</span>') +
        '</div>' +
        '<div class="mref-info">' +
          '<b>' + LABEL[k] + '</b>' +
          '<span>' + HINT[k] + '</span>' +
        '</div>' +
        '<div class="mref-acts">' +
          '<button type="button" data-mref-act="pick" data-kind="' + k + '">' + (img ? '替换' : '上传') + '</button>' +
          (img ? '<button type="button" data-mref-act="drop" data-kind="' + k + '" title="移除这张参考图">清除</button>' : '') +
        '</div>' +
        '<input type="file" accept="image/*" hidden data-mref-file="' + k + '">' +
      '</div>';
    }

    function paint(){
      const any = thumbs.struct || thumbs.color;
      el.innerHTML =
        '<div class="mref-head">' +
          '<div class="mref-title"><b>参考图</b><span>结构定形 · 着色定色</span></div>' +
          '<button type="button" class="mref-x" data-mref-act="close" title="收起">×</button>' +
        '</div>' +
        '<div class="mref-body">' +
          slotHtml('struct') + slotHtml('color') +
          '<div class="mref-note">两张图会跟着这个模型一起存进资产库；' +
            '「发到 AI 对话」会把它们作为附图带过去，AI 就按结构参考定形、按着色参考上色。</div>' +
        '</div>' +
        '<div class="mref-foot">' +
          '<button type="button" class="mref-go" data-mref-act="to-chat"' + (any ? '' : ' disabled') + '>发到 AI 对话</button>' +
        '</div>';
    }

    el.addEventListener('click', async e => {
      const btn = e.target.closest ? e.target.closest('[data-mref-act]') : null;
      if(!btn) return;
      const act = btn.getAttribute('data-mref-act');
      const kind = btn.getAttribute('data-kind');
      if(act === 'close'){ el.remove(); if(typeof opts.onClose === 'function') opts.onClose(); return; }
      if(act === 'pick'){
        const inp = el.querySelector('[data-mref-file="' + kind + '"]');
        if(inp) inp.click();
        return;
      }
      if(act === 'drop'){
        clear(modelId, kind);
        await refresh();
        return;
      }
      if(act === 'to-chat'){
        const refs = await forAI(modelId);
        if(!refs.structure && !refs.color) return;
        global.dispatchEvent(new CustomEvent('openagi:model-refs', {
          detail: { modelId: modelId, modelName: modelName, refs: refs }
        }));
        el.remove();
        /* 同样要通知宿主「这一页关了」：否则右侧 dock 会留一条空白边 */
        if(typeof opts.onClose === 'function') opts.onClose();
      }
    });

    el.addEventListener('change', async e => {
      const inp = e.target;
      if(!inp || !inp.getAttribute || !inp.getAttribute('data-mref-file')) return;
      const kind = inp.getAttribute('data-mref-file');
      const file = inp.files && inp.files[0];
      if(!file) return;
      const slot = el.querySelector('.mref-slot[data-mref-kind="' + kind + '"]');
      if(slot) slot.classList.add('busy');
      try{
        await upload(modelId, kind, file, modelName);
        await refresh();
      }catch(err){
        if(slot) slot.classList.remove('busy');
        /* 出错要说人话：这里没有全局 toast，就地写在脚注上 */
        const foot = el.querySelector('.mref-foot');
        if(foot) foot.insertAdjacentHTML('afterbegin', '<div class="mref-err">' + esc(err && err.message || err) + '</div>');
      }
    });

    paint();
    refresh();
    return el;
  }

  global.ModelRefs = {
    KINDS, LABEL,
    get, set, clear, has,
    upload, forAI, panel, shrink
  };
})(window);
