/* 桌面壁纸：主界面（.desk-wall）的背景图 + 着色。
 *
 * 三件事必须分开想：
 *   ① **存哪**：图存进 blob 存储（桌面版落磁盘资产库、网页版走 IndexedDB），
 *      配置里只留 `blob:<id>` 存根。绝不把 dataURL 直接塞进 localStorage ——
 *      一张 1600px 的 WebP 也有几百 KB，而 localStorage 一共 5 MB，
 *      几张壁纸就能把整个应用配置顶爆（历史上前端就是这么丢数据的）。
 *   ② **怎么画**：只在 .desk-wall 上铺背景层，外加一层可调的「雾化」遮罩，
 *      让图标和输入条在花哨壁纸下依然读得清。不用 filter 做模糊 ——
 *      .desk-wall 里挂着三层 3D 翻页和几十个图标，filter 会建新的合成层，
 *      翻页动画直接掉帧。用半透明遮罩叠一层，性能代价接近零。
 *   ③ **谁来改**：唯一入口 deskWallSet()。图库、设置页、右键菜单都只调这一个，
 *      自己不去碰 DOM —— 否则「从图库设了壁纸、桌面没变」这类不同步必然出现。
 *
 * 预设用 CSS 渐变而不是图片：不占存储、不糊、任何分辨率都清晰，
 * 也是大多数用户的默认选择（选图片要自己找素材）。
 */
(function () {
  'use strict';

  const KEY = 'hf_desk_wallpaper';
  const DEF = {
    mode: 'none',      // none | preset | image
    preset: 'aurora',  // 见 WALL_PRESETS
    image: '',         // blob:<id> 或（写入失败的兜底）dataURL
    name: '',
    fit: 'cover',      // cover | contain | stretch | tile
    blur: 0,           // 0..12 px —— 用缩放 + 遮罩模拟，不用 filter
    dim: 8,            // 0..60 %  遮罩浓度
    tint: ''           // 可选的单色叠加（#rrggbb），空 = 不加
  };

  /* 预设：全部是「上浅下深」的柔和渐变，图标白卡片压上去不脏。
   * 刻意避开高饱和的纯色块 —— 桌面要长期盯着看，鲜艳的背景会让图标边缘发毛。 */
  const WALL_PRESETS = [
    { id: 'aurora', name: '极光', css: 'linear-gradient(160deg, #eef4ff 0%, #e6ecfb 42%, #eef0f7 100%)' },
    { id: 'mist', name: '晨雾', css: 'linear-gradient(170deg, #f6f7f9 0%, #eceff4 55%, #e7ebf1 100%)' },
    { id: 'sand', name: '沙丘', css: 'linear-gradient(165deg, #fdf6ec 0%, #f7ecdd 48%, #f1e6d8 100%)' },
    { id: 'sage', name: '苔原', css: 'linear-gradient(168deg, #f2f7f1 0%, #e8f0e7 50%, #e3ebdf 100%)' },
    { id: 'dusk', name: '暮色', css: 'linear-gradient(162deg, #eef0f6 0%, #e4e7f1 46%, #dcdfeb 100%)' },
    { id: 'rose', name: '薄樱', css: 'linear-gradient(166deg, #fdf3f4 0%, #f7e8ea 50%, #f2e1e4 100%)' },
    { id: 'slate', name: '石板', css: 'linear-gradient(160deg, #f0f2f5 0%, #e2e6ec 52%, #d9dee6 100%)' },
    { id: 'linen', name: '亚麻', css: 'linear-gradient(150deg, #faf8f4 0%, #f3f0ea 50%, #ece8e1 100%)' }
  ];

  let wall = Object.assign({}, DEF);
  let loaded = false;

  /* 面板里拼字符串必须转义：名称来自文件名与资产库，可能带 < > & " */
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ---------- 读写配置 ---------- */
  function norm(o){
    const out = Object.assign({}, DEF);
    if(!o || typeof o !== 'object') return out;
    if(o.mode === 'preset' || o.mode === 'image') out.mode = o.mode;
    if(o.preset && WALL_PRESETS.some(p => p.id === o.preset)) out.preset = o.preset;
    if(typeof o.image === 'string' && /^(blob:|data:)/.test(o.image)) out.image = o.image;
    out.name = typeof o.name === 'string' ? o.name.slice(0, 120) : '';
    if(['cover', 'contain', 'stretch', 'tile'].indexOf(o.fit) >= 0) out.fit = o.fit;
    out.blur = Math.min(12, Math.max(0, Number(o.blur) || 0));
    out.dim = Math.min(60, Math.max(0, Number(o.dim == null ? DEF.dim : o.dim) || 0));
    out.tint = /^#[0-9a-f]{6}$/i.test(o.tint || '') ? o.tint : '';
    return out;
  }

  function read(){
    try{
      const raw = localStorage.getItem(KEY);
      return raw ? norm(JSON.parse(raw)) : Object.assign({}, DEF);
    }catch(e){ return Object.assign({}, DEF); }
  }

  /* 配置本身**不含图**，所以即使写盘失败也只是「这次的选择没记住」，
   * 不会把别的东西挤掉。真正的图在 blob 存储里，那边有自己的配额与救援。 */
  function write(w){
    try{ localStorage.setItem(KEY, JSON.stringify(w)); return true; }
    catch(e){ return false; }
  }

  /* ---------- 画到桌面 ---------- */
  function presetCss(id){
    const p = WALL_PRESETS.find(x => x.id === id);
    return p ? p.css : WALL_PRESETS[0].css;
  }

  /* 解析图片地址：存根 → 真实 dataURL。
   * blob 存储是全量载入的（blobEnsure），载入后 BLOB_CACHE 里就有原值，
   * 直接取即可 —— 不要绕 blobResolve：那玩意会原地改写对象，拿来读值很别扭。 */
  function imageUrl(){
    const v = wall.image;
    if(!v) return '';
    if(v.indexOf('data:') === 0) return v;
    if(v.indexOf('blob:') === 0){
      const id = v.slice('blob:'.length);
      try{
        if(typeof blobEnsure === 'function') blobEnsure();   // 不 await：缓存命中就是同步的
        const hit = (typeof BLOB_CACHE !== 'undefined') ? BLOB_CACHE.get(id) : null;
        if(typeof hit === 'string' && hit.indexOf('data:') === 0) return hit;
      }catch(e){}
    }
    return '';
  }

  function wallEl(){ return $('deskWall'); }

  function ensureLayers(el){
    let bg = el.querySelector(':scope > .desk-wallpaper');
    if(!bg){
      bg = document.createElement('div');
      bg.className = 'desk-wallpaper';
      bg.setAttribute('aria-hidden', 'true');
      const veil = document.createElement('div');
      veil.className = 'desk-wallpaper-veil';
      veil.setAttribute('aria-hidden', 'true');
      bg.appendChild(veil);
      /* 插到最前面：壁纸是底层，翻页层、画布、输入条都该在它上面 */
      el.insertBefore(bg, el.firstChild);
    }
    return bg;
  }

  /* 唯一的绘制出口。任何时候都能安全调用（没壁纸时就是清空）。 */
  function paint(){
    const el = wallEl();
    if(!el) return;
    const on = wall.mode === 'image' ? !!imageUrl() : wall.mode === 'preset';
    el.classList.toggle('has-wall', !!on);

    if(!on){
      const old = el.querySelector(':scope > .desk-wallpaper');
      if(old) old.remove();
      el.style.removeProperty('--wall-img');
      el.style.removeProperty('--wall-size');
      el.style.removeProperty('--wall-blur');
      el.style.removeProperty('--wall-veil');
      el.style.removeProperty('--wall-tint');
      return;
    }

    const bg = ensureLayers(el);
    let img = '', size = 'cover';
    if(wall.mode === 'image'){
      img = 'url("' + imageUrl().replace(/"/g, '%22') + '")';
      if(wall.fit === 'contain') size = 'contain';
      else if(wall.fit === 'stretch') size = '100% 100%';
      else if(wall.fit === 'tile') size = 'auto';
    }else{
      img = presetCss(wall.preset);
      size = 'cover';
    }
    el.style.setProperty('--wall-img', img);
    el.style.setProperty('--wall-size', size);
    /* 「毛玻璃」用 overflow+缩放模拟：图片层放大 blur% 再裁掉边缘，
     * 观感接近 blur() 但完全不触发 GPU 滤镜重绘。 */
    el.style.setProperty('--wall-blur', String(wall.blur));
    /* 雾化遮罩：白色（或用户选的色调）按 dim% 铺满，保证图标与文字对比度 */
    const tint = wall.tint || '#ffffff';
    el.style.setProperty('--wall-veil', tint);
    el.style.setProperty('--wall-veil-a', (wall.dim / 100).toFixed(2));
    bg.classList.toggle('is-tile', wall.mode === 'image' && wall.fit === 'tile');
  }

  /* 桌面 DOM 可能在脚本之后才建好；用一次 rAF + 兜底 setTimeout 保证画上 */
  function boot(){
    wall = read();
    loaded = true;
    const tryPaint = () => { if(wallEl()) paint(); else setTimeout(tryPaint, 60); };
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryPaint);
    else requestAnimationFrame(tryPaint);
    /* 图片壁纸的原文在 blob 存储里，启动时是异步载入的：
       第一次 paint 缓存多半还没命中，只能画空。等存储就绪后再画一次，
       否则每次重启/刷新壁纸都会「消失」，用户只能重新设一遍。 */
    if(wall.mode === 'image' && typeof blobEnsure === 'function'){
      try{
        blobEnsure().then(() => { if(wall.mode === 'image') paint(); }).catch(() => {});
      }catch(e){}
    }
  }

  /* ---------- 对外 API ---------- */

  /* 设置壁纸。patch 里只放要改的字段；返回 {ok, error}。
   * ⚠ 「设图片」时传 image = dataURL，这里负责存进 blob 并只留存根。 */
  async function deskWallSet(patch){
    const next = norm(Object.assign({}, wall, patch || {}));
    if(patch && typeof patch.image === 'string' && patch.image.indexOf('data:') === 0){
      try{
        if(typeof blobPut !== 'function') throw new Error('存储未就绪');
        const id = (typeof blobIdFor === 'function')
          ? blobIdFor(patch.image)
          : ('b' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2));
        await blobPut(id, patch.image);
        next.image = 'blob:' + id;
      }catch(e){
        /* 存不进去也不能丢用户的选择：原样内联，只是会占配置空间。
         * 这条兜底和 blob-store 的「绝不丢数据」是同一口径。 */
        next.image = patch.image;
      }
    }
    wall = next;
    const saved = write(wall);
    paint();
    try{
      document.dispatchEvent(new CustomEvent('openagi:wallpaper', { detail: Object.assign({}, wall) }));
    }catch(e){}
    return { ok: true, saved: saved, state: Object.assign({}, wall) };
  }

  function deskWallGet(){ return Object.assign({}, wall); }

  /* 清空：回到默认白底。图片本身留在资产库里，用户还能在图库找回来。 */
  function deskWallClear(){
    return deskWallSet({ mode: 'none', image: '', name: '', blur: 0, dim: DEF.dim, tint: '', fit: 'cover' });
  }

  /* 图片选好后给界面用的缩略预览 */
  function deskWallPreview(){
    return imageUrl();
  }

  /* 把一张图压到合适的壁纸尺寸：长边 1920、WebP .86。
   * 不压缩的后果很实在：手机拍的 4000×3000 PNG 转 dataURL 能到 20 MB，
   * 存进 IndexedDB 会让读取慢到「桌面要等一下才出图」。 */
  function deskWallShrink(dataURL){
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1920;
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if(!w || !h) return resolve(dataURL);
        const scale = Math.min(1, MAX / Math.max(w, h));
        if(scale >= 1 && dataURL.length < 900000) return resolve(dataURL);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        const g = c.getContext('2d');
        if(!g) return resolve(dataURL);
        g.drawImage(img, 0, 0, c.width, c.height);
        try{ resolve(c.toDataURL('image/webp', 0.86)); }
        catch(e){ resolve(dataURL); }
      };
      img.onerror = () => resolve(dataURL);
      img.src = dataURL;
    });
  }

  /* ---------- 选择面板（设置页与图库抽屉共用同一份） ----------
   * host   —— 要渲染进去的元素
   * opts   —— { source:'asset'|'local'|'settings', name, dataURL, onClose, onDone }
   * 返回 cleanup 函数（切走时调用，解绑 document 上的监听）。
   * 面板自己**不读资产库**：数据由调用方给，这样设置页也能独立使用。 */
  let panelCleanup = null;

  function wallPanelRender(host, opts){
    if(panelCleanup){ panelCleanup(); panelCleanup = null; }
    if(!host) return null;
    if(!opts){ host.innerHTML = ''; return null; }

    const o = opts;
    /* 草稿态：改动先在草稿里，点「应用」才落盘。
     * 实时生效看着爽，但拖动滑杆时桌面在用户身后不停重绘，滑杆本身会掉帧。 */
    const draft = Object.assign({}, wall);
    if(o.dataURL) draft.mode = 'image';
    const asset = o.dataURL || '';

    const isImg = draft.mode === 'image';
    const activePreset = (!isImg && wall.mode !== 'none') ? wall.preset : '';

    const presets = WALL_PRESETS.map(p =>
      '<button type="button" class="wp-preset' + (!isImg && draft.preset === p.id ? ' on' : '') +
      '" data-wp-preset="' + p.id + '" style="background:' + p.css + '" title="' + esc(p.name) + '">' +
      '<span class="wp-preset-n">' + esc(p.name) + '</span></button>').join('');

    const fits = [['cover', '铺满裁切'], ['contain', '完整留边'], ['stretch', '拉伸铺满'], ['tile', '平铺重复']]
      .map(([v, label]) => '<button type="button" class="wp-fit' + (draft.fit === v ? ' on' : '') +
        '" data-wp-fit="' + v + '"' + (isImg ? '' : ' disabled') + '>' + label + '</button>').join('');

    const srcLine = isImg
      ? (o.name
        ? '<div class="wp-src">来源：<b>' + esc(o.name) + '</b>' + (o.source === 'asset' ? '（图库资产，已留在图库里）' : '') + '</div>'
        : (draft.name ? '<div class="wp-src">来源：<b>' + esc(draft.name) + '</b></div>' : ''))
      : '';

    host.innerHTML =
      '<div class="wp-panel">' +
        /* 预览：按真实桌面比例画一个缩略，画布里放两个示意块（画布 + 输入条），
         * 让用户能判断壁纸压在图标后面到底好不好看。 */
        '<div class="wp-preview" data-wp-preview>' +
          '<div class="wp-preview-img"></div>' +
          '<div class="wp-preview-veil"></div>' +
          '<div class="wp-preview-canvas"></div>' +
          '<div class="wp-preview-bar"></div>' +
          (draft.mode === 'none' ? '<span class="wp-preview-tip">无壁纸（默认白底）</span>' : '') +
        '</div>' +

        '<div class="wp-block">' +
          '<div class="wp-block-t">配色<span>不需要图片，任意分辨率都清晰</span></div>' +
          '<div class="wp-presets">' + presets + '</div>' +
        '</div>' +

        (asset
          ? '<div class="wp-block">' +
              '<div class="wp-block-t">图片<button type="button" class="btn sm" data-wp-use="1">用这张</button></div>' +
              srcLine +
            '</div>'
          : (isImg && draft.name
            ? '<div class="wp-block"><div class="wp-block-t">当前图片</div>' + srcLine +
              '<div class="wp-row"><button type="button" class="btn sm" data-wp-pick="1">换一张…</button></div></div>'
            : '<div class="wp-block"><div class="wp-block-t">图片<span>从本机选一张，或去图库点「壁纸」</span></div>' +
              '<div class="wp-row"><button type="button" class="btn sm" data-wp-pick="1">选择图片…</button></div></div>')) +

        '<div class="wp-block">' +
          '<div class="wp-block-t">适应方式</div>' +
          '<div class="wp-fits">' + fits + '</div>' +
        '</div>' +

        '<div class="wp-block">' +
          '<div class="wp-block-t">观感<span>压暗能让图标更清楚</span></div>' +
          '<div class="wp-range"><label for="wpDim">雾化浓度</label>' +
            '<input type="range" id="wpDim" min="0" max="60" step="2" value="' + draft.dim + '" data-wp-range="dim">' +
            '<output data-wp-out="dim">' + draft.dim + '%</output></div>' +
          '<div class="wp-range"><label for="wpBlur">柔化</label>' +
            '<input type="range" id="wpBlur" min="0" max="12" step="1" value="' + draft.blur + '" data-wp-range="blur">' +
            '<output data-wp-out="blur">' + draft.blur + '</output></div>' +
          '<div class="wp-row">' +
            '<label class="wp-color">遮罩色 <input type="color" value="' + (draft.tint || '#ffffff') + '" data-wp-tint></label>' +
            '<button type="button" class="btn sm" data-wp-tintreset="1">用白色</button>' +
          '</div>' +
        '</div>' +

        '<div class="wp-hint">壁纸只在桌面（主页）显示；打开 App 页时桌面翻走，壁纸随之退场。' +
          '图片已压缩到长边 1920 并存入本机资产库，不会上传。</div>' +

        '<div class="wp-row" style="justify-content:flex-end;gap:8px">' +
          (o.onClose ? '<button type="button" class="btn sm" data-wp-cancel="1">取消</button>' : '') +
          '<button type="button" class="btn sm" data-wp-off="1">清除壁纸</button>' +
          '<button type="button" class="btn sm primary" data-wp-apply="1">应用</button>' +
        '</div>' +
      '</div>';

    /* ---- 预览同步：草稿怎么变，缩略窗就怎么变 ---- */
    const px = host.querySelector('.wp-preview-img');
    const pv = host.querySelector('.wp-preview-veil');
    const syncPreview = () => {
      if(!px || !pv) return;
      if(draft.mode === 'none'){ px.style.backgroundImage = 'none'; pv.style.opacity = '0'; return; }
      px.style.backgroundImage = draft.mode === 'image'
        ? (asset ? 'url("' + asset.replace(/"/g, '%22') + '")' : 'none')
        : presetCss(draft.preset);
      px.style.backgroundSize = draft.fit === 'tile' ? 'auto' : (draft.fit === 'stretch' ? '100% 100%' : draft.fit);
      pv.style.background = draft.tint || '#ffffff';
      pv.style.opacity = String(draft.dim / 100);
    };
    syncPreview();

    // 预设
    host.querySelectorAll('[data-wp-preset]').forEach(b => {
      b.addEventListener('click', () => {
        draft.mode = 'preset';
        draft.preset = b.dataset.wpPreset;
        host.querySelectorAll('[data-wp-preset]').forEach(x => x.classList.toggle('on', x === b));
        host.querySelectorAll('[data-wp-fit]').forEach(x => { x.disabled = true; });
        syncPreview();
      });
    });
    // 用这张图
    const useBtn = host.querySelector('[data-wp-use]');
    if(useBtn) useBtn.addEventListener('click', () => {
      draft.mode = 'image';
      host.querySelectorAll('[data-wp-preset]').forEach(x => x.classList.remove('on'));
      host.querySelectorAll('[data-wp-fit]').forEach(x => { x.disabled = false; });
      syncPreview();
    });
    // 从本机换一张
    const pickBtn = host.querySelector('[data-wp-pick]');
    if(pickBtn) pickBtn.addEventListener('click', async () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.addEventListener('change', async () => {
        const f = inp.files && inp.files[0];
        if(!f) return;
        const raw = await new Promise(res => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result || ''));
          fr.onerror = () => res('');
          fr.readAsDataURL(f);
        });
        if(!raw) return;
        const small = await deskWallShrink(raw);
        /* 换图后重新渲染面板：asset 是闭包里的常量，不重渲染就没法换成新图。
         * 参数带上新数据，草稿里其它设置（雾化/适应）沿用当前 wall 的值。 */
        wallPanelRender(host, Object.assign({}, o, { dataURL: small, name: f.name, source: 'local' }));
      });
      inp.click();
    });
    // 适应方式
    host.querySelectorAll('[data-wp-fit]').forEach(b => {
      b.addEventListener('click', () => {
        if(b.disabled) return;
        draft.fit = b.dataset.wpFit;
        host.querySelectorAll('[data-wp-fit]').forEach(x => x.classList.toggle('on', x === b));
        syncPreview();
      });
    });
    // 滑杆
    host.querySelectorAll('[data-wp-range]').forEach(r => {
      r.addEventListener('input', () => {
        const k = r.dataset.wpRange;
        draft[k] = Number(r.value);
        const out = host.querySelector('[data-wp-out="' + k + '"]');
        if(out) out.textContent = k === 'dim' ? (r.value + '%') : r.value;
        syncPreview();
      });
    });
    // 遮罩色
    const tintEl = host.querySelector('[data-wp-tint]');
    if(tintEl) tintEl.addEventListener('input', () => { draft.tint = tintEl.value; syncPreview(); });
    const tintReset = host.querySelector('[data-wp-tintreset]');
    if(tintReset) tintReset.addEventListener('click', () => {
      draft.tint = '';
      if(tintEl) tintEl.value = '#ffffff';
      syncPreview();
    });

    /* ---- 落盘 ---- */
    host.querySelector('[data-wp-apply]').addEventListener('click', async () => {
      const patch = {
        mode: draft.mode, preset: draft.preset, fit: draft.fit,
        blur: draft.blur, dim: draft.dim, tint: draft.tint,
        name: (draft.mode === 'image') ? (o.name || draft.name || '') : draft.name
      };
      if(draft.mode === 'image'){
        if(asset){ patch.image = asset; }
        else if(!draft.image){ /* 没有图可设，什么都不做 */ }
      }
      const r = await deskWallSet(patch);
      if(o.onDone) o.onDone(r);
    });
    host.querySelector('[data-wp-off]').addEventListener('click', async () => {
      await deskWallClear();
      if(o.onDone) o.onDone({ ok: true, cleared: true });
      else wallPanelRender(host, opts);
    });
    const cancel = host.querySelector('[data-wp-cancel]');
    if(cancel) cancel.addEventListener('click', () => { if(o.onClose) o.onClose(); });

    return function cleanup(){ /* 目前没有全局监听，留个形状给将来 */ };
  }

  window.DeskWall = {
    PRESETS: WALL_PRESETS,
    DEF: DEF,
    set: deskWallSet,
    get: deskWallGet,
    clear: deskWallClear,
    paint: paint,
    preview: deskWallPreview,
    shrink: deskWallShrink,
    isReady: () => loaded
  };
  /* 面板单独挂：library.js 与设置页都要用，且可能在 DeskWall 之前执行到 */
  window.wallPanelRender = wallPanelRender;

  boot();
})();
