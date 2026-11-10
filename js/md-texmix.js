/* 建模 App · 绘画工具箱里的「纹理混合」
 *
 * 把模型库（js/m3d-slots.js）的那套图层混合搬进建模 App，但**不复制状态**：
 * 配置真源仍是 localStorage 的 `openagi_model_tex_v1`，按「资产 id + 材质槽名」索引，
 * 图层/遮罩图片仍由资产库保管（配置只记 id）。这样在模型库里配好的混合，
 * 建模 App 打开同一资产看到的是同一张合成图；反之亦然。
 *
 * 运行时只做两件事：把 id 解码成 Image，把「基础图 + 图层」按 js/tex-blend.js
 * 烘成一张 canvas 贴图挂到材质上。合成结果就是 mat.map，导出 GLB 时自然带上，
 * 不需要在着色器里混（着色器混出来的只有视口好看，导出是空的）。
 *
 * 基础图的口径（优先级从高到低）：
 *   ① 绘画工作区 canvas（正在画这一槽时，笔迹必须立刻参与混合）
 *   ② 烘焙贴图（模型库 v3 配置里的 baked；它替掉了模型自带贴图）
 *   ③ doc.materials.slotMaps[槽]（导入时从 GLB 抽出来的基础色）
 *   ④ 白底（模型没有贴图时，和模型库的合成口径一致）
 *
 * 历史：配置本身很小（只存 id/参数），所以撤销走 `entry.mix` 快照，
 * 不复制图也不重建网格。
 *
 * 对外（window.MDTexMix）：create(ctx) → { init, refresh, renderUi, schedule,
 *   baseImageFor, texFor, applyPatch, rekey, selectSlot, onPaintSlot }
 */
(function (global) {
  'use strict';

  var TEX_KEY = 'openagi_model_tex_v1';
  var MAX_SIDE = 2048;      /* 合成画布长边上限：和模型库同一口径 */
  var LIMIT = 8;            /* 单槽最多几层：滑杆再多也调不动 */

  function create(ctx) {
    var st = ctx.st, THREE = ctx.THREE;
    var TB = global.TexBlend;
    var setStatus = ctx.setStatus, updateChrome = ctx.updateChrome;
    var sharedTexture = ctx.sharedTexture;
    var applySlotTexture = ctx.applySlotTexture;
    var paintCanvasFor = ctx.paintCanvasFor;
    var paintTexFor = ctx.paintTexFor;
    var totalBytes = ctx.totalBytes, syncBytes = ctx.syncBytes;
    var HISTORY_BUDGET = ctx.historyBudget;

    /* doc → { 槽名: 配置 }：本会话的完整配置（含「不能落盘」的临时层）。
     * 读的时候先看这里，保证同一会话里加了又撤、撤了又加不会丢层。 */
    var sessionCfg = new WeakMap();
    /* doc → { slots: { 槽下标: rec } }：运行时解码 / 合成缓存 */
    var imgCache = Object.create(null);
    var uiReady = false;
    var curSlot = 0;
    var dragFrom = -1;
    var box = null;
    var listEl = null;
    var slotSel = null;
    var fileInput = null;

    /* ---------------- 配置读写（真源 = localStorage） ---------------- */
    function docOf() { return st.doc; }

    function slotCount(doc) {
      var names = (doc && doc.materials && doc.materials.slotNames) || [];
      return Math.max(1, names.length);
    }
    function slotKeyOf(doc, slot) {
      var names = (doc && doc.materials && doc.materials.slotNames) || [];
      return names[slot] ? String(names[slot]) : ('slot' + slot);
    }
    function slotIndexOf(doc, key) {
      var names = (doc && doc.materials && doc.materials.slotNames) || [];
      for (var i = 0; i < names.length; i++) if (String(names[i]) === key) return i;
      var m = /^slot(\d+)$/.exec(key || '');
      return m ? Number(m[1]) : -1;
    }

    function readStore() {
      try {
        var j = JSON.parse(global.localStorage.getItem(TEX_KEY) || '{}');
        return (j && typeof j === 'object') ? j : {};
      } catch (e) { return {}; }
    }
    function writeStore(all) {
      try { global.localStorage.setItem(TEX_KEY, JSON.stringify(all)); } catch (e) {}
    }

    function normLayer(r) {
      if (!r) return null;
      var o = {
        id: String(r.id || ''), name: String(r.name || ''),
        flipY: r.flipY !== false,
        opacity: TB.clampNum(r.opacity != null ? r.opacity : 1, 0, 1),
        blend: r.blend || 'normal'
      };
      /* src 只用于「本会话内有效」的临时图（没有资产库时） */
      if (r.src) o.src = String(r.src);
      if (r.mask && (r.mask.id || r.mask.src)) {
        o.mask = {
          id: String(r.mask.id || ''), name: String(r.mask.name || ''),
          flipY: r.mask.flipY !== false, invert: !!r.mask.invert
        };
        if (r.mask.src) o.mask.src = String(r.mask.src);
      }
      return o;
    }
    /* v1 = 单贴图；v2 = 图层栈；v3 = 多一张 baked（烘焙后的基础贴图）。
     * 旧配置必须能读，别为了省事只认新格式。 */
    function normCfg(raw) {
      if (!raw) return { v: 2, layers: [], baked: null };
      if (Array.isArray(raw.layers)) {
        var baked = null;
        if (raw.baked && (raw.baked.id || raw.baked.src)) {
          baked = {
            id: String(raw.baked.id || ''), name: String(raw.baked.name || ''),
            flipY: raw.baked.flipY !== false
          };
          /* 网页版没有资产库时烘焙图只能带 data URL，留在本次会话 */
          if (raw.baked.src) baked.src = String(raw.baked.src);
        }
        return { v: raw.v || 2, layers: raw.layers.map(normLayer).filter(Boolean), baked: baked };
      }
      if (raw.id || raw.name) return { v: 2, layers: [normLayer(raw)].filter(Boolean), baked: null };
      return { v: 2, layers: [], baked: null };
    }
    function encLayer(l, persist) {
      if (!l) return null;
      /* 没有资产 id 的层在网页版里落不住盘：写了只会让人以为配过、下次又没了 */
      if (persist && !l.id) return null;
      var o = {
        id: String(l.id || ''), name: String(l.name || ''), flipY: l.flipY !== false,
        opacity: TB.clampNum(l.opacity, 0, 1), blend: l.blend || 'normal'
      };
      if (!persist && l.src) o.src = String(l.src);
      if (l.mask && (l.mask.id || l.mask.src)) {
        var m = {
          id: String(l.mask.id || ''), name: String(l.mask.name || ''),
          flipY: l.mask.flipY !== false, invert: !!l.mask.invert
        };
        if (!persist && l.mask.src) m.src = String(l.mask.src);
        if (persist && !m.id) m = null;
        if (m) o.mask = m;
      }
      return o;
    }
    function encCfg(cfg, persist) {
      var ls = (cfg.layers || []).map(function (l) { return encLayer(l, persist); }).filter(Boolean);
      var b0 = cfg.baked;
      var baked = (b0 && (b0.id || (!persist && b0.src))) ? {
        id: String(b0.id || ''), name: String(b0.name || ''),
        flipY: b0.flipY !== false
      } : null;
      if (baked && !persist && b0.src) baked.src = String(b0.src);
      if (!ls.length && !baked) return null;
      return { v: baked ? 3 : 2, layers: ls, baked: baked };
    }

    function memOf(doc) {
      var m = sessionCfg.get(doc);
      if (!m) { m = Object.create(null); sessionCfg.set(doc, m); }
      return m;
    }
    function readCfg(doc, slot) {
      if (!doc) return { v: 2, layers: [], baked: null };
      var k = slotKeyOf(doc, slot);
      var mem = sessionCfg.get(doc);
      if (mem && mem[k]) return normCfg(mem[k]);
      var assetKey = doc.materials && doc.materials.textureConfigKey;
      if (!assetKey) return { v: 2, layers: [], baked: null };
      var all = readStore();
      return normCfg(all[assetKey] && all[assetKey][k]);
    }
    /* 写配置：本会话快照一定更新；能落盘的（有资产 id 的层）同步写 localStorage。
     * 不落盘的层只留在 sessionCfg 里，和模型库「网页版本次会话有效」的语义一致。 */
    function writeCfg(doc, slot, cfg) {
      if (!doc) return;
      var k = slotKeyOf(doc, slot);
      var mem = memOf(doc);
      var full = encCfg(cfg, false);
      if (full) mem[k] = full; else delete mem[k];
      var assetKey = doc.materials && doc.materials.textureConfigKey;
      if (!assetKey) return;
      var all = readStore();
      var m = (all[assetKey] && typeof all[assetKey] === 'object') ? all[assetKey] : {};
      var p = encCfg(cfg, true);
      if (p) m[k] = p; else delete m[k];
      if (Object.keys(m).length) all[assetKey] = m; else delete all[assetKey];
      writeStore(all);
    }
    function snapCfg(slot) {
      return JSON.stringify(readCfg(docOf(), slot));
    }

    /* ---------------- 图片解码 ---------------- */
    function loadImg(src) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () { res(img); };
        img.onerror = function () { rej(new Error('贴图解码失败')); };
        img.src = src;
      });
    }
    /* 同一条 data URL / 同一张资产只解码一次：切换页签、拖滑杆都会反复要图 */
    function imgOnce(key, fn) {
      if (!imgCache[key]) {
        imgCache[key] = fn().catch(function () { return null; });
      }
      return imgCache[key];
    }
    function assetImg(id) {
      return imgOnce('a:' + id, async function () {
        var d = global.openagiDesktop;
        if (!(d && typeof d.assetRead === 'function')) throw new Error('网页版没有资产库');
        var r = await d.assetRead(id);
        if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
        return await loadImg(r.dataURL);
      });
    }
    function urlImg(url) {
      return imgOnce('u:' + url, function () { return loadImg(url); });
    }
    function layerImg(l) {
      if (l.id) return assetImg(l.id);
      if (l.src) return urlImg(l.src);
      return Promise.resolve(null);
    }
    function maskImg(m) {
      if (m.id) return assetImg(m.id);
      if (m.src) return urlImg(m.src);
      return Promise.resolve(null);
    }
    async function putImageAsset(dataURL, name) {
      var d = global.openagiDesktop;
      if (!(d && typeof d.assetPut === 'function')) return '';
      try {
        var res = await d.assetPut({
          kind: 'image', name: name || '纹理混合贴图',
          data: dataURL, source: '建模App-纹理混合'
        });
        var a = res && res.ok && res.asset;
        return (a && a.id) ? String(a.id) : '';
      } catch (e) { return ''; }
    }

    /* ---------------- 运行时缓存 ---------------- */
    var docCache = new WeakMap();
    function cacheOf(doc) {
      var c = docCache.get(doc);
      if (!c) { c = { slots: Object.create(null) }; docCache.set(doc, c); }
      return c;
    }
    function recOf(doc, slot) {
      var c = cacheOf(doc);
      var k = String(slot);
      var r = c.slots[k];
      if (!r) {
        r = c.slots[k] = {
          token: 0, ready: false, sig: '', layers: [], baked: null,
          baseUrl: '', baseImg: null, canvas: null, tex: null, texValid: false, raf: 0
        };
      }
      return r;
    }

    /* 把配置里的 id 全部解码成运行时层。中途配置又变了（token++）就放弃这次结果，
     * 否则「先点的低清层」会覆盖后点的高清层。 */
    async function ensureSlot(slot, force) {
      var doc = docOf();
      if (!doc) return null;
      var cfg = readCfg(doc, slot);
      var rec = recOf(doc, slot);
      var sig = JSON.stringify(cfg);
      var baseUrl = ((doc.materials && doc.materials.slotMaps) || [])[slot] || '';
      if (!force && rec.ready && rec.sig === sig && rec.baseUrl === baseUrl) return rec;
      var my = ++rec.token;

      var oldById = Object.create(null);
      (rec.layers || []).forEach(function (l) { if (l.id && l.img && !oldById[l.id]) oldById[l.id] = l; });

      var layers = await Promise.all(cfg.layers.map(async function (l) {
        var old = l.id ? oldById[l.id] : null;
        var img = (old && old.img) ? old.img : await layerImg(l);
        var mask = null;
        if (l.mask) {
          var om = (old && old.mask && old.mask.id && old.mask.id === l.mask.id) ? old.mask : null;
          var mi = (om && om.img) ? om.img : await maskImg(l.mask);
          if (mi) {
            mask = {
              id: l.mask.id, name: l.mask.name, flipY: l.mask.flipY !== false,
              invert: !!l.mask.invert, img: mi
            };
          }
        }
        return {
          id: l.id, name: l.name, flipY: l.flipY !== false,
          opacity: TB.clampNum(l.opacity, 0, 1), blend: l.blend || 'normal',
          img: img, mask: mask
        };
      }));

      var baked = null;
      if (cfg.baked && (cfg.baked.id || cfg.baked.src)) {
        var bKey = cfg.baked.id || cfg.baked.src;
        var ob = (rec.baked && (rec.baked.id || rec.baked.src) === bKey) ? rec.baked : null;
        var bi = (ob && ob.img) ? ob.img
          : (cfg.baked.id ? await assetImg(cfg.baked.id) : await urlImg(cfg.baked.src));
        if (bi) {
          baked = {
            id: cfg.baked.id, name: cfg.baked.name, flipY: cfg.baked.flipY !== false,
            src: cfg.baked.src, img: bi
          };
        }
      }

      var baseImg = rec.baseImg;
      if (baseUrl && (!rec.baseImg || rec.baseUrl !== baseUrl)) {
        baseImg = await urlImg(baseUrl);
      }

      if (my !== rec.token) return null;
      rec.layers = layers;
      rec.baked = baked;
      rec.baseImg = baseImg;
      rec.baseUrl = baseUrl;
      rec.sig = sig;
      rec.ready = true;
      return rec;
    }

    /* ---------------- 合成 ---------------- */
    function effectiveLayers(rec) {
      var out = [];
      var ls = rec.layers || [];
      for (var i = 0; i < ls.length; i++) {
        if (ls[i] && ls[i].img && TB.clampNum(ls[i].opacity, 0, 1) > 0) out.push(ls[i]);
      }
      return out;
    }

    function dropTex(rec) {
      rec.texValid = false;
      if (rec.tex) { try { rec.tex.dispose(); } catch (e) {} rec.tex = null; }
    }

    function ensureTex(rec, canvas) {
      if (rec.tex && rec.tex.image === canvas) {
        rec.tex.needsUpdate = true;
        return rec.tex;
      }
      dropTex(rec);
      var tex = new THREE.CanvasTexture(canvas);
      if ('encoding' in tex && THREE.sRGBEncoding != null) tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 4;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.flipY = true;       /* 和 sharedTexture（TextureLoader 默认）保持一致 */
      tex.name = 'md-texmix-' + (rec.slotName || '');
      /* 标记成共享：重建材质时会 dispose 旧材质，不能把这张合成图一起销毁 */
      tex.userData.mdShared = true;
      rec.tex = tex;
      rec.texValid = true;
      return tex;
    }

    /* 没有混合层 / 烘焙图时回到「基础贴图」：正在画就用绘画工作区那张，
     * 否则用 doc 里原来的共享贴图（没有就 null = 只吃槽色）。 */
    function applyBase(slot) {
      var rec = recOf(docOf(), slot);
      dropTex(rec);
      var pt = paintTexFor ? paintTexFor(slot) : null;
      if (pt) { applySlotTexture(slot, pt); return; }
      var doc = docOf();
      var url = ((doc && doc.materials && doc.materials.slotMaps) || [])[slot] || '';
      applySlotTexture(slot, url ? sharedTexture(url) : null);
    }

    function composeAndApply(slot) {
      var doc = docOf();
      if (!doc) return;
      var rec = recOf(doc, slot);
      var pc = paintCanvasFor ? paintCanvasFor(slot) : null;
      var eff = effectiveLayers(rec);
      /* 有烘焙图也要合成：烘焙图就是新的基础层 */
      if (!eff.length && !pc && !rec.baked) { applyBase(slot); return; }
      var baseImg = pc || (rec.baked && rec.baked.img) || rec.baseImg || null;
      var sz = TB.mixSize({ baseImg: baseImg, layers: eff }, MAX_SIDE);
      if (!rec.canvas) rec.canvas = document.createElement('canvas');
      var cv = TB.compose({ w: sz.w, h: sz.h, baseImg: baseImg, layers: eff, canvas: rec.canvas });
      rec.canvas = cv;
      rec.slotName = slotKeyOf(doc, slot);
      var tex = ensureTex(rec, cv);
      applySlotTexture(slot, tex);
    }

    function pump(slot) {
      var doc = docOf();
      if (!doc) return;
      var rec = recOf(doc, slot);
      var sig = JSON.stringify(readCfg(doc, slot));
      var baseUrl = ((doc.materials && doc.materials.slotMaps) || [])[slot] || '';
      /* 基础贴图也可能变（撤销画笔 / 换图）：变了就得重新解码，
       * 不能拿旧的 rec.baseImg 继续合成。 */
      if (rec.ready && rec.sig === sig && rec.baseUrl === baseUrl) { composeAndApply(slot); return; }
      ensureSlot(slot, false).then(function (r) {
        if (!r || st.doc !== doc) return;
        composeAndApply(slot);
        if (uiReady) renderUi();
      }).catch(function () {});
    }

    /* 拖滑杆 / 画笔每帧都会来：合并到一帧一次，留最后一次的值就够 */
    function schedule(slot) {
      var doc = docOf();
      if (!doc) return;
      slot = Math.max(0, Math.min(slotCount(doc) - 1, Number(slot) || 0));
      var rec = recOf(doc, slot);
      if (rec.raf) return;
      rec.raf = requestAnimationFrame(function () {
        rec.raf = 0;
        pump(slot);
      });
    }

    function refreshSlot(slot, force) {
      var doc = docOf();
      if (!doc) return;
      var cfg = readCfg(doc, slot);
      var rec = recOf(doc, slot);
      var idle = !(cfg.layers.length || cfg.baked);
      if (idle) {
        if (rec.texValid) applyBase(slot);
        else if (!rec.ready) {
          /* 没配置也没合成过：什么都不用动，材质本来就是基础贴图 */
        }
        rec.ready = true; rec.sig = JSON.stringify(cfg);
        return;
      }
      ensureSlot(slot, force).then(function (r) {
        if (!r || st.doc !== doc) return;
        composeAndApply(slot);
        if (uiReady) renderUi();
      }).catch(function (e) {
        setStatus('纹理混合：' + ((e && e.message) || e), true);
      });
    }

    function refresh() {
      var doc = docOf();
      if (!doc) { if (uiReady) renderUi(); return; }
      var n = slotCount(doc);
      if (curSlot >= n) curSlot = n - 1;
      for (var i = 0; i < n; i++) refreshSlot(i, false);
      if (uiReady) renderUi();
    }

    /* 合成纹理：材质重建时 makeMaterials 先问这里，避免「重建后混合没了」 */
    function texFor(slot) {
      var doc = docOf();
      if (!doc) return null;
      var rec = recOf(doc, slot);
      return (rec && rec.texValid && rec.tex) ? rec.tex : null;
    }
    /* 绘画工作区的底图：烘焙图优先于导入的基础色贴图 */
    function baseImageFor(slot) {
      var doc = docOf();
      if (!doc) return null;
      var rec = recOf(doc, slot);
      if (rec.baked && rec.baked.img) return rec.baked.img;
      if (rec.baseImg) return rec.baseImg;
      var url = ((doc.materials && doc.materials.slotMaps) || [])[slot] || '';
      if (url) {
        var t = sharedTexture(url);
        if (t && t.image && t.image.width) return t.image;
      }
      return null;
    }

    /* ---------------- 历史补丁 ---------------- */
    function pushMixHistory(slot, before, after, label) {
      if (!before || !after || before === after) return false;
      var entry = {
        mix: { key: slotKeyOf(docOf(), slot), before: before, after: after },
        label: label || '纹理混合',
        bytes: (before.length + after.length) * 2
      };
      st.history.undo.push(entry);
      st.history.redo = [];
      while (st.history.undo.length > 1 && totalBytes() > HISTORY_BUDGET) st.history.undo.shift();
      syncBytes();
      updateChrome();
      return true;
    }

    /* 撤销 / 重做混配置：按槽名回写配置，再从配置重新解码合成 */
    function applyPatch(patch, side) {
      var doc = docOf();
      if (!doc || !patch) return;
      var key = String(patch.key || '');
      var slot = slotIndexOf(doc, key);
      if (slot < 0) return;
      var json = patch[side] || '';
      var cfg;
      try { cfg = json ? normCfg(JSON.parse(json)) : { v: 2, layers: [], baked: null }; }
      catch (e) { return; }
      writeCfg(doc, slot, cfg);
      refreshSlot(slot, true);
      curSlot = slot;
      if (uiReady) renderUi();
    }

    /* 保存时补上资产 id：把本会话攒下的配置迁到正式 key，不然关掉页面就丢 */
    function rekey(doc, newKey) {
      if (!doc || !newKey) return;
      var mem = sessionCfg.get(doc);
      if (!mem) return;
      var all = readStore();
      var m = (all[newKey] && typeof all[newKey] === 'object') ? all[newKey] : {};
      Object.keys(mem).forEach(function (k) {
        var p = encCfg(normCfg(mem[k]), true);
        if (p) m[k] = p; else delete m[k];
      });
      if (Object.keys(m).length) all[newKey] = m; else delete all[newKey];
      writeStore(all);
    }

    /* ---------------- 工具箱 UI ---------------- */
    function mkBtn(text, title, fn, cls) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      if (title) b.title = title;
      b.className = 'md-mix-mini' + (cls ? ' ' + cls : '');
      b.onclick = fn;
      return b;
    }

    function thumbOfLayer(l, size) {
      if (!l || !l.img || !l.img.width) return null;
      var cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      var c2 = cv.getContext('2d');
      c2.fillStyle = '#0a0b0e';
      c2.fillRect(0, 0, size, size);
      var sc = Math.max(size / l.img.width, size / l.img.height);
      var w = l.img.width * sc, h = l.img.height * sc;
      c2.drawImage(l.img, (size - w) / 2, (size - h) / 2, w, h);
      return cv;
    }

    function rebuildSlot(slot, before, label) {
      var after = snapCfg(slot);
      if (before) pushMixHistory(slot, before, after, label);
      refreshSlot(slot, true);
      schedule(slot);
    }

    function addLayerAsset(slot, dataURL, name) {
      var doc = docOf();
      if (!doc) return;
      var cfg = readCfg(doc, slot);
      if (cfg.layers.length >= LIMIT) { setStatus('纹理混合：一个材质槽最多 ' + LIMIT + ' 层', true); return; }
      var before = snapCfg(slot);
      return putImageAsset(dataURL, name).then(function (id) {
        cfg.layers.push({
          id: id, name: name || '贴图', flipY: true, opacity: 1, blend: 'normal',
          src: id ? '' : dataURL
        });
        writeCfg(doc, slot, cfg);
        rebuildSlot(slot, before, '添加混合层');
        if (uiReady) renderUi();
        setStatus('纹理混合：已叠加「' + (name || '贴图') + '」' +
          (id ? '' : '（网页版：本次会话内有效）'));
      });
    }

    function setMaskAsset(slot, idx, dataURL, name) {
      var doc = docOf();
      if (!doc) return;
      var cfg = readCfg(doc, slot);
      var l = cfg.layers[idx];
      if (!l) return;
      var before = snapCfg(slot);
      return putImageAsset(dataURL, name || '遮罩').then(function (id) {
        l.mask = {
          id: id, name: name || '遮罩', flipY: true, invert: false,
          src: id ? '' : dataURL
        };
        writeCfg(doc, slot, cfg);
        rebuildSlot(slot, before, '设置遮罩');
        if (uiReady) renderUi();
        setStatus('纹理混合：遮罩已设置（白色显示、黑色隐藏）');
      });
    }

    function readFileAsDataURL(file) {
      return new Promise(function (res) {
        var rd = new FileReader();
        rd.onload = function () { res(String(rd.result || '')); };
        rd.onerror = function () { res(''); };
        rd.readAsDataURL(file);
      });
    }

    function pickFiles(multi, cb) {
      if (!fileInput) {
        fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp';
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);
      }
      fileInput.multiple = !!multi;
      fileInput.value = '';
      fileInput.onchange = function () {
        var files = Array.prototype.slice.call(fileInput.files || []);
        if (!files.length) return;
        if (!multi) files = files.slice(0, 1);
        Promise.all(files.map(readFileAsDataURL)).then(function (urls) {
          var chain = Promise.resolve();
          urls.forEach(function (url, i) {
            if (!url) return;
            chain = chain.then(function () { return cb(url, files[i].name); });
          });
          return chain;
        }).catch(function (e) {
          setStatus('纹理混合：' + ((e && e.message) || e), true);
        });
        fileInput.value = '';
      };
      fileInput.click();
    }

    /* ---------------- 资产库选图 / 烘焙 / 手绘遮罩 ----------------
     * 这三件事都只在建模 App 里做，但写回的还是同一份配置：
     * 图库选图 = 直接记资产 id（不重复上传）；烘焙 = 把合成图存成新资产并写 baked；
     * 手绘遮罩 = 画一张黑白图，存资产后写进层的 mask。 */
    function escHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function addLayerFromAsset(slot, a) {
      var doc = docOf();
      if (!doc || !a || !a.id) return;
      var cfg = readCfg(doc, slot);
      if (cfg.layers.length >= LIMIT) { setStatus('纹理混合：一个材质槽最多 ' + LIMIT + ' 层', true); return; }
      var before = snapCfg(slot);
      cfg.layers.push({
        id: String(a.id), name: a.name || '贴图', flipY: true, opacity: 1, blend: 'normal'
      });
      writeCfg(doc, slot, cfg);
      rebuildSlot(slot, before, '添加混合层');
      if (uiReady) renderUi();
      setStatus('纹理混合：已叠加「' + (a.name || '贴图') + '」');
    }

    function setMaskFromAsset(slot, idx, a) {
      var doc = docOf();
      if (!doc || !a || !a.id) return;
      var cfg = readCfg(doc, slot);
      var l = cfg.layers[idx];
      if (!l) return;
      var before = snapCfg(slot);
      l.mask = { id: String(a.id), name: a.name || '遮罩', flipY: true, invert: false };
      writeCfg(doc, slot, cfg);
      rebuildSlot(slot, before, '设置遮罩');
      if (uiReady) renderUi();
      setStatus('纹理混合：遮罩已设置（白色显示、黑色隐藏）');
    }

    var gallery = null;
    function closeGallery() {
      if (gallery && gallery.parentNode) gallery.parentNode.removeChild(gallery);
      gallery = null;
    }
    /* mode = 'layer' | 'mask'；mask 还要带层下标 */
    function openGallery(mode, slot, idx) {
      var d = global.openagiDesktop;
      if (!(d && typeof d.assetList === 'function')) {
        pickFiles(false, function (url, name) {
          if (mode === 'mask') return setMaskAsset(slot, idx, url, name);
          return addLayerAsset(slot, url, name);
        });
        return;
      }
      closeGallery();
      var back = document.createElement('div');
      back.className = 'md-mix-gback';
      var pop = document.createElement('div');
      pop.className = 'md-mix-gpop';
      var head = document.createElement('div');
      head.className = 'md-mix-ghead';
      var tt = document.createElement('span');
      tt.textContent = mode === 'mask' ? '从资产库选遮罩' : '从资产库选贴图';
      head.appendChild(tt);
      head.appendChild(mkBtn('×', '关闭', closeGallery, 'is-del'));
      pop.appendChild(head);

      var grid = document.createElement('div');
      grid.className = 'md-mix-ggrid';
      grid.innerHTML = '<div class="md-mix-empty"><span>读取中…</span></div>';
      pop.appendChild(grid);

      var foot = document.createElement('div');
      foot.className = 'md-mix-gfoot';
      foot.appendChild(mkBtn('＋ 上传本地图片', '上传后同时存入资产库', function () {
        pickFiles(false, function (url, name) {
          closeGallery();
          if (mode === 'mask') return setMaskAsset(slot, idx, url, name);
          return addLayerAsset(slot, url, name);
        });
      }));
      pop.appendChild(foot);
      back.appendChild(pop);
      document.body.appendChild(back);
      gallery = back;
      back.onclick = function (e) { if (e.target === back) closeGallery(); };

      Promise.resolve(d.assetList()).then(function (l) {
        if (gallery !== back) return;
        var list = (l && l.assets) ? l.assets.filter(function (a) { return a.kind === 'image'; }) : [];
        list.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
        grid.innerHTML = '';
        if (!list.length) {
          grid.innerHTML = '<div class="md-mix-empty"><span>资产库里还没有图片</span>' +
            '<em>点下方「上传本地图片」也会自动存进资产库。</em></div>';
          return;
        }
        list.slice(0, 60).forEach(function (a) {
          var cell = document.createElement('button');
          cell.type = 'button';
          cell.className = 'md-mix-gcell';
          var th = document.createElement('i');
          th.className = 'md-mix-gthumb';
          th.textContent = '图';
          cell.appendChild(th);
          var nm = document.createElement('span');
          nm.textContent = a.name || a.id;
          nm.title = nm.textContent;
          cell.appendChild(nm);
          cell.onclick = function () {
            closeGallery();
            if (mode === 'mask') setMaskFromAsset(slot, idx, a);
            else addLayerFromAsset(slot, a);
          };
          grid.appendChild(cell);
          if (typeof d.assetThumb === 'function') {
            Promise.resolve(d.assetThumb(a.id)).then(function (t) {
              if (!t || !t.ok || !t.dataURL || !th.isConnected) return;
              var im = new Image();
              im.alt = '';
              im.src = t.dataURL;
              th.textContent = '';
              th.appendChild(im);
            }).catch(function () {});
          }
        });
      }).catch(function (e) {
        if (gallery !== back) return;
        grid.innerHTML = '<div class="md-mix-empty"><span>读取资产库失败</span><em>' +
          escHtml((e && e.message) || e) + '</em></div>';
      });
    }

    /* 烘焙：把当前合成结果固化成一张新贴图（和模型库同一语义：烘焙后清空图层，
     * 否则下次合成会把图层再叠一遍）。 */
    function bakeSlot(slot) {
      var doc = docOf();
      if (!doc) return;
      var rec = recOf(doc, slot);
      var cfg = readCfg(doc, slot);
      if (!cfg.layers.length) {
        setStatus('纹理混合：没有可烘焙的图层（底层贴图本身不用烘焙）', true);
        return;
      }
      var pc = paintCanvasFor ? paintCanvasFor(slot) : null;
      var eff = effectiveLayers(rec);
      var baseImg = pc || (rec.baked && rec.baked.img) || rec.baseImg || null;
      var sz = TB.mixSize({ baseImg: baseImg, layers: eff }, MAX_SIDE);
      var cv = TB.compose({ w: sz.w, h: sz.h, baseImg: baseImg, layers: eff });
      var url = cv.toDataURL('image/png');
      var name = (slotKeyOf(doc, slot) || '槽') + ' 烘焙';
      var before = snapCfg(slot);
      setStatus('纹理混合：正在烘焙 ' + sz.w + '×' + sz.h + '…');
      return putImageAsset(url, name).then(function (id) {
        var cfg2 = readCfg(doc, slot);
        cfg2.baked = { id: id, name: name, flipY: true, src: id ? '' : url };
        cfg2.layers = [];
        writeCfg(doc, slot, cfg2);
        rebuildSlot(slot, before, '烘焙纹理');
        if (uiReady) renderUi();
        setStatus('纹理混合：已烘焙为「' + name + '」' +
          (id ? '（已存入资产库）' : '（本次会话内有效）'));
      }).catch(function (e) {
        setStatus('纹理混合：烘焙失败 · ' + ((e && e.message) || e), true);
      });
    }

    var maskDlg = null;
    function closeMaskDlg() {
      if (maskDlg && maskDlg.parentNode) maskDlg.parentNode.removeChild(maskDlg);
      maskDlg = null;
    }
    /* 手绘遮罩：一张 2D 黑白画布，白 = 显示、黑 = 隐藏。用贴图本身做半透明底图，
     * 方便对着纹理位置涂；保存后仍走 setMaskAsset，和上传的遮罩完全同一条链路。 */
    function openMaskPainter(slot, idx) {
      var doc = docOf();
      if (!doc) return;
      var cfg = readCfg(doc, slot);
      var l = cfg.layers[idx];
      if (!l) return;
      var rec = recOf(doc, slot);
      var rl = (rec.layers && rec.layers[idx]) || null;
      var srcImg = rl && rl.img;
      if (!srcImg) { setStatus('纹理混合：贴图还没解码完，稍后再画遮罩', true); return; }
      closeMaskDlg();

      var W = Math.min(1024, srcImg.width || 512);
      var H = Math.max(1, Math.round(W * (srcImg.height || W) / (srcImg.width || W)));
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var c2 = cv.getContext('2d');
      c2.fillStyle = '#fff';
      c2.fillRect(0, 0, W, H);
      var oldMask = rl.mask && rl.mask.img;
      if (oldMask) c2.drawImage(oldMask, 0, 0, W, H);

      var tool = 'draw', size = 28, drawing = false, last = null;
      function pt(e) {
        var r = cv.getBoundingClientRect();
        return {
          x: Math.max(0, Math.min(W, (e.clientX - r.left) * W / Math.max(1, r.width))),
          y: Math.max(0, Math.min(H, (e.clientY - r.top) * H / Math.max(1, r.height)))
        };
      }
      function dab(p) {
        c2.globalCompositeOperation = 'source-over';
        c2.fillStyle = tool === 'erase' ? '#000' : '#fff';
        c2.beginPath();
        c2.arc(p.x, p.y, size / 2, 0, Math.PI * 2);
        c2.fill();
      }
      function stroke(a, b) {
        var d = Math.hypot(b.x - a.x, b.y - a.y);
        var n = Math.max(1, Math.ceil(d / Math.max(1, size * 0.34)));
        for (var i = 1; i <= n; i++) {
          dab({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n });
        }
      }
      cv.addEventListener('pointerdown', function (e) {
        if (e.button === 2) tool = 'erase';
        drawing = true;
        try { cv.setPointerCapture(e.pointerId); } catch (err) {}
        last = pt(e);
        dab(last);
      });
      cv.addEventListener('pointermove', function (e) {
        if (!drawing) return;
        var p = pt(e);
        stroke(last || p, p);
        last = p;
      });
      function up() { drawing = false; last = null; }
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });

      var back = document.createElement('div');
      back.className = 'md-mix-gback';
      var pop = document.createElement('div');
      pop.className = 'md-mix-gpop md-mix-maskpop';
      var head = document.createElement('div');
      head.className = 'md-mix-ghead';
      var tt = document.createElement('span');
      tt.textContent = '手绘遮罩 · ' + (l.name || ('图层 ' + (idx + 1)));
      head.appendChild(tt);
      head.appendChild(mkBtn('×', '关闭', closeMaskDlg, 'is-del'));
      pop.appendChild(head);

      var bar = document.createElement('div');
      bar.className = 'md-mix-maskbar';
      var bDraw = mkBtn('画笔', '涂白 = 显示这一层', function () {
        tool = 'draw';
        bDraw.classList.add('is-on'); bErase.classList.remove('is-on');
      }, 'is-on');
      var bErase = mkBtn('擦除', '涂黑 = 隐藏这一层（右键临时擦除）', function () {
        tool = 'erase';
        bErase.classList.add('is-on'); bDraw.classList.remove('is-on');
      });
      bar.appendChild(bDraw); bar.appendChild(bErase);
      var rng = document.createElement('input');
      rng.type = 'range'; rng.min = '4'; rng.max = '120'; rng.step = '1'; rng.value = String(size);
      var val = document.createElement('b');
      val.textContent = size + ' px';
      rng.oninput = function () { size = Number(rng.value) || 28; val.textContent = size + ' px'; };
      bar.appendChild(rng); bar.appendChild(val);
      bar.appendChild(mkBtn('反相', '黑白对调', function () {
        var im = c2.getImageData(0, 0, W, H);
        var d0 = im.data;
        for (var i = 0; i < d0.length; i += 4) {
          d0[i] = 255 - d0[i]; d0[i + 1] = 255 - d0[i + 1]; d0[i + 2] = 255 - d0[i + 2];
        }
        c2.putImageData(im, 0, 0);
      }));
      bar.appendChild(mkBtn('全白', '恢复为全部显示', function () {
        c2.fillStyle = '#fff'; c2.fillRect(0, 0, W, H);
      }));
      pop.appendChild(bar);

      var stage = document.createElement('div');
      stage.className = 'md-mix-maskstage';
      var ucv = document.createElement('canvas');
      ucv.width = W; ucv.height = H;
      ucv.className = 'md-mix-maskunder';
      ucv.getContext('2d').drawImage(srcImg, 0, 0, W, H);
      cv.className = 'md-mix-maskdraw';
      /* 画布半透明：白色的地方仍能看到底图位置，方便对着纹理涂 */
      cv.style.opacity = '0.62';
      stage.appendChild(ucv);
      stage.appendChild(cv);
      var tag = document.createElement('span');
      tag.className = 'md-mix-masktag';
      tag.textContent = '白 = 显示，黑 = 隐藏';
      stage.appendChild(tag);
      pop.appendChild(stage);

      var foot = document.createElement('div');
      foot.className = 'md-mix-gfoot';
      foot.appendChild(mkBtn('保存为遮罩', '写回这一层并存入资产库', function () {
        var url = cv.toDataURL('image/png');
        closeMaskDlg();
        setMaskAsset(slot, idx, url, (l.name || '图层') + ' 手绘遮罩');
      }, 'md-mix-add'));
      foot.appendChild(mkBtn('取消', '不保存', closeMaskDlg));
      pop.appendChild(foot);

      back.appendChild(pop);
      document.body.appendChild(back);
      maskDlg = back;
      back.onclick = function (e) { if (e.target === back) closeMaskDlg(); };
    }

    /* ---------------- 在模型表面画遮罩（对齐模型库的绘制方式） ----------------
     * 独立一张透明画布：白色不透明 = 显示该层，透明 = 隐藏。
     * 射线与画笔共用 ctx.paintRayHit（同槽、同面、同 UV 口径），
     * 落笔立刻把这张画布当成层的 mask.url 参与合成，松手不用等入库。 */
    var maskPaint = null;
    var maskBar = null;
    /* 异步入库回来时，可能已经又开了一次绘制：用 key + epoch 认领结果 */
    var maskEpoch = 0;
    var maskEpochByKey = Object.create(null);

    function stopMaskPaint(commit) {
      var mp = maskPaint;
      if (!mp) return;
      st.canvas.removeEventListener('pointerdown', mp.onDown, true);
      st.canvas.removeEventListener('pointermove', mp.onMove, true);
      window.removeEventListener('pointerup', mp.onUp);
      window.removeEventListener('pointercancel', mp.onUp);
      if (ctx.setMaskPaintMode) ctx.setMaskPaintMode(false);
      if (maskBar && maskBar.parentNode) maskBar.parentNode.removeChild(maskBar);
      maskBar = null;
      maskPaint = null;
      if (box) box.classList.remove('is-masking');

      var doc = docOf();
      if (!doc) return;
      var cfg = readCfg(doc, mp.slot);
      var l = cfg.layers[mp.idx];
      if (!commit) {
        if (l) {
          if (mp.prev) l.mask = mp.prev;
          else delete l.mask;
        }
        writeCfg(doc, mp.slot, cfg);
        schedule(mp.slot);
        if (uiReady) renderUi();
        setStatus('纹理混合：已取消，遮罩回到绘制前');
        return;
      }
      var name = (mp.layerName || '图层') + ' 手绘遮罩';
      var url = mp.cv.toDataURL('image/png');
      setStatus('纹理混合：遮罩绘制完成，正在保存…');
      putImageAsset(url, name).then(function (id) {
        var doc2 = docOf();
        if (!doc2) return;
        if (maskEpochByKey[mp.slot + ':' + mp.idx] !== mp.epoch) return;
        var cfg2 = readCfg(doc2, mp.slot);
        var l2 = cfg2.layers[mp.idx];
        if (!l2) return;
        l2.mask = {
          id: id || '', name: name, flipY: l2.flipY !== false,
          invert: false, painted: true
        };
        if (!id) l2.mask.src = url;
        writeCfg(doc2, mp.slot, cfg2);
        rebuildSlot(mp.slot, mp.before, '手绘遮罩');
        if (uiReady) renderUi();
        setStatus('纹理混合：手绘遮罩已保存' + (id ? '（已存入资产库）' : '（本次会话内有效）'));
      }).catch(function (e) {
        setStatus('纹理混合：遮罩保存失败 · ' + ((e && e.message) || e), true);
      });
    }

    function startMaskPaint(slot, idx) {
      if (maskPaint) stopMaskPaint(true);
      var doc = docOf();
      if (!doc) return;
      if (!ctx.paintRayHit) { setStatus('纹理混合：视口还没准备好', true); return; }
      var cfg = readCfg(doc, slot);
      var l = cfg.layers[idx];
      if (!l) return;
      var rec = recOf(doc, slot);
      var rl = (rec.layers && rec.layers[idx]) || null;
      if (!rl || !rl.img) { setStatus('纹理混合：贴图还在解码，稍后再画', true); return; }
      closeGallery();
      closeMaskDlg();

      var iw = rl.img.naturalWidth || rl.img.width || 512;
      var ih = rl.img.naturalHeight || rl.img.height || iw;
      var W = Math.min(MAX_SIDE, Math.max(256, iw));
      var H = Math.max(1, Math.round(W * ih / iw));
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var c2 = cv.getContext('2d');
      var prev = l.mask || null;
      if (rl.mask && rl.mask.img) {
        try { c2.drawImage(rl.mask.img, 0, 0, W, H); } catch (e) {}
      }
      var before = snapCfg(slot);
      var live = {
        id: (prev && prev.id) || '',
        src: (prev && prev.src) || '',
        name: (prev && prev.name) || '手绘遮罩',
        flipY: l.flipY !== false,
        invert: prev ? !!prev.invert : false,
        painted: true, img: cv, __direct: true
      };
      l.mask = live;
      if (rl) rl.mask = live;

      var mp = {
        slot: slot, idx: idx, cv: cv, c2: c2, W: W, H: H,
        flip: l.flipY !== false,
        prev: prev, layerName: l.name || ('图层 ' + (idx + 1)),
        before: before, mode: 'paint', down: false, lastOk: false,
        size: Math.max(8, Math.round(Math.min(W, H) * 0.07)),
        epoch: ++maskEpoch
      };
      maskEpochByKey[slot + ':' + idx] = mp.epoch;

      function hitPx(e) {
        var r = st.canvas.getBoundingClientRect();
        var hit = ctx.paintRayHit(e.clientX - r.left, e.clientY - r.top);
        if (!hit || (hit.slot != null && hit.slot !== slot)) return null;
        var u = hit.u - Math.floor(hit.u);
        var v = hit.v - Math.floor(hit.v);
        return { x: u * W, y: (mp.flip ? (1 - v) : v) * H };
      }
      function dab(p) {
        var r2 = mp.size;
        var g = c2.createRadialGradient(p.x, p.y, 0, p.x, p.y, r2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.6, 'rgba(255,255,255,1)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c2.globalCompositeOperation = mp.mode === 'erase' ? 'destination-out' : 'source-over';
        c2.fillStyle = g;
        c2.beginPath();
        c2.arc(p.x, p.y, r2, 0, Math.PI * 2);
        c2.fill();
        c2.globalCompositeOperation = 'source-over';
        /* 遮罩缓存按尺寸/反相/翻转做 key，不主动失效会一直用第一笔的旧图 */
        delete live.__mc;
      }
      function stroke(a, b) {
        var d = Math.hypot(b.x - a.x, b.y - a.y);
        var n = Math.max(1, Math.ceil(d / Math.max(1, mp.size * 0.3)));
        for (var i = 1; i <= n; i++) {
          dab({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n });
        }
      }
      mp.onDown = function (e) {
        if (!maskPaint || e.button !== 0 || e.target !== st.canvas) return;
        e.preventDefault();
        e.stopPropagation();
        mp.down = true;
        mp.lastOk = false;
        try { st.canvas.setPointerCapture(e.pointerId); } catch (err) {}
        var px = hitPx(e);
        if (!px) { setStatus('纹理混合：要点在模型表面才能画', true); return; }
        dab(px);
        mp.lastX = px.x; mp.lastY = px.y; mp.lastOk = true;
        schedule(slot);
      };
      mp.onMove = function (e) {
        if (!maskPaint || !mp.down) return;
        e.stopPropagation();
        var px = hitPx(e);
        if (!px) { mp.lastOk = false; return; }
        if (mp.lastOk) stroke({ x: mp.lastX, y: mp.lastY }, px);
        else dab(px);
        mp.lastX = px.x; mp.lastY = px.y; mp.lastOk = true;
        schedule(slot);
      };
      mp.onUp = function () { mp.down = false; mp.lastOk = false; };

      st.canvas.addEventListener('pointerdown', mp.onDown, true);
      st.canvas.addEventListener('pointermove', mp.onMove, true);
      window.addEventListener('pointerup', mp.onUp);
      window.addEventListener('pointercancel', mp.onUp);
      if (ctx.setMaskPaintMode) ctx.setMaskPaintMode(true);
      maskPaint = mp;
      /* 绘制期间锁住混合面板：换槽 / 加层会让当前这张遮罩失去落点 */
      if (box) box.classList.add('is-masking');

      var bar = document.createElement('div');
      bar.className = 'md-maskbar';
      var tt = document.createElement('span');
      tt.className = 'md-maskbar-t';
      tt.textContent = '遮罩绘制 · ' + (mp.layerName || '图层');
      bar.appendChild(tt);
      var bPaint = mkBtn('绘制', '涂白 = 显示这一层', function () {
        mp.mode = 'paint';
        bPaint.classList.add('is-on'); bErase.classList.remove('is-on');
      }, 'is-on');
      var bErase = mkBtn('擦除', '涂掉 = 隐藏这一层', function () {
        mp.mode = 'erase';
        bErase.classList.add('is-on'); bPaint.classList.remove('is-on');
      });
      bar.appendChild(bPaint);
      bar.appendChild(bErase);
      var rng = document.createElement('input');
      rng.type = 'range'; rng.min = '4'; rng.max = String(Math.max(24, Math.min(W, H) / 3));
      rng.step = '1'; rng.value = String(mp.size);
      var val = document.createElement('b');
      val.textContent = mp.size + ' px';
      rng.oninput = function () {
        mp.size = Number(rng.value) || 8;
        val.textContent = mp.size + ' px';
      };
      bar.appendChild(rng);
      bar.appendChild(val);
      bar.appendChild(mkBtn('全显', '遮罩清空 = 整层都显示', function () {
        c2.clearRect(0, 0, W, H);
        delete live.__mc;
        schedule(slot);
        setStatus('纹理混合：遮罩已清空（整层显示）');
      }));
      bar.appendChild(mkBtn('取消', '放弃这次绘制', function () { stopMaskPaint(false); }));
      bar.appendChild(mkBtn('完成', '保存并写回这一层', function () { stopMaskPaint(true); }, 'md-mix-add'));
      document.body.appendChild(bar);
      maskBar = bar;
      schedule(slot);
      setStatus('纹理混合：在模型表面涂遮罩，白色显示、擦掉隐藏');
    }


    function renderRow(slot, cfg, idx, total) {
      var rec = recOf(docOf(), slot);
      var l = cfg.layers[idx];
      var rl = (rec.layers && rec.layers[idx]) || null;
      var row = document.createElement('div');
      row.className = 'md-mix-row';

      var line1 = document.createElement('div');
      line1.className = 'md-mix-line';
      /* 拖动排序：只有标题行可拖，滑杆 / 下拉仍按原生交互 */
      line1.draggable = true;
      line1.title = '拖动这一行调整图层顺序';
      line1.ondragstart = function (e) {
        dragFrom = idx;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(idx));
        }
        row.classList.add('is-drag');
      };
      line1.ondragend = function () { row.classList.remove('is-drag'); };
      var grip = document.createElement('span');
      grip.className = 'md-mix-grip';
      grip.textContent = '⠿';
      grip.title = '拖动排序';
      line1.appendChild(grip);
      var thBox = document.createElement('div');
      thBox.className = 'md-mix-thumb';
      var th = thumbOfLayer(rl || l, 34);
      if (th) thBox.appendChild(th);
      line1.appendChild(thBox);

      var nm = document.createElement('div');
      nm.className = 'md-mix-name';
      nm.textContent = l.name || ('图层 ' + (idx + 1));
      nm.title = nm.textContent;
      line1.appendChild(nm);

      /* 列表倒序显示：视觉上「上移」= 数组往后挪一位 */
      if (idx < total - 1) {
        line1.appendChild(mkBtn('↑', '上移一层', function () { moveLayer(slot, idx, idx + 1); }));
      }
      if (idx > 0) {
        line1.appendChild(mkBtn('↓', '下移一层', function () { moveLayer(slot, idx, idx - 1); }));
      }
      line1.appendChild(mkBtn('×', '删除这一层', function () { removeLayer(slot, idx, l.name); }, 'is-del'));
      row.appendChild(line1);
      row.ondragover = function (e) {
        if (dragFrom < 0 || dragFrom === idx) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        row.classList.add('is-drop');
      };
      row.ondragleave = function () { row.classList.remove('is-drop'); };
      row.ondrop = function (e) {
        e.preventDefault();
        row.classList.remove('is-drop');
        var from = dragFrom;
        dragFrom = -1;
        if (from < 0 || from === idx) return;
        moveLayer(slot, from, idx);
      };

      var line2 = document.createElement('div');
      line2.className = 'md-mix-line';
      var sel = document.createElement('select');
      sel.className = 'md-mix-blend';
      TB.BLEND_MODES.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.key; o.textContent = m.label;
        sel.appendChild(o);
      });
      sel.value = l.blend || 'normal';
      var before = '';
      sel.onchange = function () {
        if (!before) before = snapCfg(slot);
        l.blend = sel.value;
        if (rl) rl.blend = sel.value;
        writeCfg(docOf(), slot, cfg);
        schedule(slot);
        pushMixHistory(slot, before, snapCfg(slot), '混合模式');
        before = '';
      };
      line2.appendChild(sel);

      var rng = document.createElement('input');
      rng.type = 'range'; rng.min = '0'; rng.max = '100'; rng.step = '1';
      rng.value = String(Math.round(TB.clampNum(l.opacity, 0, 1) * 100));
      var val = document.createElement('b');
      val.textContent = rng.value + '%';
      rng.oninput = function () {
        if (!before) before = snapCfg(slot);
        l.opacity = Number(rng.value) / 100;
        if (rl) rl.opacity = l.opacity;
        val.textContent = rng.value + '%';
        schedule(slot);
      };
      rng.onchange = function () {
        writeCfg(docOf(), slot, cfg);
        pushMixHistory(slot, before, snapCfg(slot), '混合比例');
        before = '';
        if (uiReady) renderUi();
      };
      line2.appendChild(rng); line2.appendChild(val);
      row.appendChild(line2);

      var line3 = document.createElement('div');
      line3.className = 'md-mix-line';
      if (l.mask && (l.mask.id || l.mask.src)) {
        var mtag = document.createElement('span');
        mtag.className = 'md-mix-mask';
        mtag.textContent = '遮罩 ' + (l.mask.name || '');
        mtag.title = mtag.textContent;
        line3.appendChild(mtag);
        var invB = document.createElement('button');
        invB.type = 'button';
        invB.className = 'md-mix-mini' + (l.mask.invert ? ' is-on' : '');
        invB.textContent = '反相';
        invB.onclick = function () {
          var b0 = snapCfg(slot);
          l.mask.invert = !l.mask.invert;
          if (rl && rl.mask) { rl.mask.invert = l.mask.invert; if (rl.mask.__mc) rl.mask.__mc = null; }
          writeCfg(docOf(), slot, cfg);
          schedule(slot);
          pushMixHistory(slot, b0, snapCfg(slot), '遮罩反相');
          if (uiReady) renderUi();
        };
        line3.appendChild(invB);
        line3.appendChild(mkBtn('手绘', '用画笔涂抹遮罩：白显示、黑隐藏', function () {
          openMaskPainter(slot, idx);
        }));
        line3.appendChild(mkBtn('模型画', '直接在 3D 模型表面涂遮罩', function () {
          startMaskPaint(slot, idx);
        }));
        line3.appendChild(mkBtn('换', '换一张遮罩', function () {
          pickFiles(false, function (url, name) { return setMaskAsset(slot, idx, url, name); });
        }));
        line3.appendChild(mkBtn('图库', '从资产库挑一张遮罩', function () {
          openGallery('mask', slot, idx);
        }));
        line3.appendChild(mkBtn('去遮罩', '删除这一层的遮罩', function () {
          var b0 = snapCfg(slot);
          l.mask = null;
          if (rl) rl.mask = null;
          writeCfg(docOf(), slot, cfg);
          schedule(slot);
          pushMixHistory(slot, b0, snapCfg(slot), '去掉遮罩');
          if (uiReady) renderUi();
        }));
      } else {
        line3.appendChild(mkBtn('＋ 遮罩', '白色显示 / 黑色隐藏', function () {
          pickFiles(false, function (url, name) { return setMaskAsset(slot, idx, url, name); });
        }));
        line3.appendChild(mkBtn('手绘', '直接画一张黑白遮罩', function () {
          openMaskPainter(slot, idx);
        }));
        line3.appendChild(mkBtn('模型画', '直接在 3D 模型表面涂遮罩', function () {
          startMaskPaint(slot, idx);
        }));
        line3.appendChild(mkBtn('图库', '从资产库挑一张遮罩', function () {
          openGallery('mask', slot, idx);
        }));
      }
      row.appendChild(line3);
      return row;
    }

    /* 图层在数组里「后者在上」：from → to 直接搬运，不交换。
     * 上移/下移是相邻移动，拖拽排序可能跨多格，所以按 splice 实现。 */
    function moveLayer(slot, from, to) {
      var doc = docOf();
      if (!doc) return;
      var cfg = readCfg(doc, slot);
      var rec = recOf(doc, slot);
      var n = cfg.layers.length;
      if (!(from >= 0 && from < n) || !(to >= 0 && to < n) || from === to) return;
      var before = snapCfg(slot);
      var l = cfg.layers.splice(from, 1)[0];
      cfg.layers.splice(to, 0, l);
      if (rec.layers && rec.layers.length === n) {
        var r = rec.layers.splice(from, 1)[0];
        rec.layers.splice(to, 0, r);
      }
      writeCfg(doc, slot, cfg);
      schedule(slot);
      pushMixHistory(slot, before, snapCfg(slot), '调整图层顺序');
      if (uiReady) renderUi();
    }
    function removeLayer(slot, idx, name) {
      var doc = docOf();
      if (!doc) return;
      var cfg = readCfg(doc, slot);
      var rec = recOf(doc, slot);
      var before = snapCfg(slot);
      cfg.layers.splice(idx, 1);
      if (rec.layers) rec.layers.splice(idx, 1);
      writeCfg(doc, slot, cfg);
      schedule(slot);
      pushMixHistory(slot, before, snapCfg(slot), '删除混合层');
      if (uiReady) renderUi();
      setStatus('纹理混合：已删除「' + (name || '图层') + '」');
    }

    function shortName(s, n) {
      s = String(s == null ? '' : s);
      return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    function renderUi() {
      if (!box) return;
      var doc = docOf();
      var wrap = document.createElement('div');
      var head = document.createElement('div');
      head.className = 'md-mix-head';
      var accent = document.createElement('i');
      head.appendChild(accent);
      var t = document.createElement('span');
      t.textContent = '纹理混合';
      head.appendChild(t);

      if (!doc) {
        var empty0 = document.createElement('div');
        empty0.className = 'md-mix-empty';
        empty0.innerHTML = '<b>＋</b><span>先打开一个模型</span>' +
          '<em>新建或导入模型后，就能按材质槽叠加混合贴图。</em>';
        wrap.appendChild(empty0);
        box.innerHTML = ''; box.appendChild(wrap);
        return;
      }

      var n = slotCount(doc);
      var names = doc.materials.slotNames || [];
      var slot = Math.min(curSlot, n - 1);
      curSlot = slot;
      var cfg = readCfg(doc, slot);
      var count = document.createElement('em');
      count.className = 'md-mix-count';
      count.textContent = cfg.layers.length + ' 层';
      head.appendChild(count);
      wrap.appendChild(head);

      /* 插槽单独一行：英文材质名很长，挤在标题旁边会把箭头盖住 */
      var slotRow = document.createElement('div');
      slotRow.className = 'md-mix-slotrow';
      var slotLab = document.createElement('span');
      slotLab.textContent = '插槽';
      slotRow.appendChild(slotLab);
      slotSel = document.createElement('select');
      slotSel.className = 'md-mix-slot';
      for (var i = 0; i < n; i++) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = shortName(names[i] || ('插槽 ' + (i + 1)), 22);
        o.title = names[i] || ('插槽 ' + (i + 1));
        slotSel.appendChild(o);
      }
      slotSel.value = String(slot);
      slotSel.onchange = function () {
        curSlot = Number(slotSel.value) || 0;
        renderUi();
      };
      slotRow.appendChild(slotSel);
      wrap.appendChild(slotRow);

      listEl = document.createElement('div');
      listEl.className = 'md-mix-list';
      if (!cfg.layers.length) {
        var zero = document.createElement('div');
        zero.className = 'md-mix-empty';
        zero.innerHTML = '<b>＋</b><span>还没有混合层</span>' +
          '<em>点下方「＋ 贴图」叠加一张；第二张起就能用「比例 + 遮罩」做过渡、脏迹、旧化。</em>';
        listEl.appendChild(zero);
      }
      for (var li = cfg.layers.length - 1; li >= 0; li--) {
        listEl.appendChild(renderRow(slot, cfg, li, cfg.layers.length));
      }
      wrap.appendChild(listEl);

      /* 底层：模型自带贴图 / 烘焙贴图，只读 */
      var baseRow = document.createElement('div');
      baseRow.className = 'md-mix-base';
      var bchip = document.createElement('span');
      bchip.className = 'md-mix-chip';
      var hasBaked = !!(cfg.baked && (cfg.baked.id || cfg.baked.src));
      var hasMap = !!((doc.materials && doc.materials.slotMaps || [])[slot]);
      bchip.textContent = '底层 · ' + (hasBaked ? '烘焙贴图' : (hasMap ? '模型自带贴图' : '白底')) + '（只读）';
      baseRow.appendChild(bchip);
      wrap.appendChild(baseRow);

      var acts = document.createElement('div');
      acts.className = 'md-mix-acts';
      var addBtn = mkBtn('＋ 贴图', '叠加一张贴图（图片会存入资产库）', function () {
        pickFiles(true, function (url, name) { return addLayerAsset(slot, url, name); });
      });
      addBtn.classList.add('md-mix-add');
      acts.appendChild(addBtn);
      acts.appendChild(mkBtn('图库', '从资产库选一张贴图（直接引用，不重复上传）', function () {
        openGallery('layer', slot);
      }));
      acts.appendChild(mkBtn('烘焙', '把当前合成结果固化成新贴图（图层会清空）', function () {
        bakeSlot(slot);
      }));
      acts.appendChild(mkBtn('清空', '清空这一槽的所有混合层', function () {
        var before = snapCfg(slot);
        var cfg2 = readCfg(doc, slot);
        cfg2.layers = [];
        writeCfg(doc, slot, cfg2);
        rebuildSlot(slot, before, '清空纹理混合');
        if (uiReady) renderUi();
        setStatus('纹理混合：已清空，回到基础贴图');
      }));
      wrap.appendChild(acts);

      var hint = document.createElement('div');
      hint.className = 'md-mix-hint';
      hint.textContent = '拖动图层标题行可排序；遮罩白色显示、黑色隐藏；合成图直接作为该槽贴图，笔刷仍写在基础贴图上。';
      wrap.appendChild(hint);

      if (doc.materials.textureConfigMissing) {
        var warn = document.createElement('div');
        warn.className = 'md-mix-hint is-warn';
        warn.textContent = '这份资产是复制的：原混合配置不可用，按空配置处理。';
        wrap.appendChild(warn);
      }

      box.innerHTML = '';
      box.appendChild(wrap);
    }

    function init() {
      box = document.getElementById('mdMixBox');
      if (!box || uiReady) return;
      uiReady = true;
      renderUi();
    }

    function selectSlot(slot) {
      var doc = docOf();
      if (!doc) return;
      slot = Math.max(0, Math.min(slotCount(doc) - 1, Number(slot) || 0));
      if (slot === curSlot) return;
      curSlot = slot;
      if (uiReady) renderUi();
    }

    return {
      init: init, refresh: refresh, renderUi: renderUi, schedule: schedule,
      baseImageFor: baseImageFor, texFor: texFor, applyPatch: applyPatch,
      rekey: rekey, selectSlot: selectSlot
    };
  }

  global.MDTexMix = { create: create };
})(window);
