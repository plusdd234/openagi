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
  var TB = global.TexBlend;

  /* 层归一化放在 create() 外面：它只依赖 TexBlend，是能直接测的纯函数。
   * 「模型库写进层里的字段必须原样带回」这条兼容规则挂在这里，
   * 探针可以直接断言，不必为了测它去开一整个建模 App。
   * 跟 M3DSlots.mergeSlotRec 是同一套约定：两边共用一份配置，未知字段不许洗掉。 */
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
    if (r.kind === 'color') o.kind = 'color';
    if (Array.isArray(r.islands) && r.islands.length) o.islands = r.islands.map(Number);
    if (r.mask && (r.mask.id || r.mask.src)) {
      o.mask = {
        id: String(r.mask.id || ''), name: String(r.mask.name || ''),
        flipY: r.mask.flipY !== false, invert: !!r.mask.invert
      };
      if (r.mask.src) o.mask.src = String(r.mask.src);
    }
    return o;
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
    if (l.kind === 'color') o.kind = 'color';
    if (Array.isArray(l.islands) && l.islands.length) o.islands = l.islands.map(Number);
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

  function create(ctx) {
    var st = ctx.st, THREE = ctx.THREE;
    var setStatus = ctx.setStatus, updateChrome = ctx.updateChrome;
    var sharedTexture = ctx.sharedTexture;
    var applySlotTexture = ctx.applySlotTexture;
    var liveSlotImage = ctx.liveSlotImage;
    var paintCanvasFor = ctx.paintCanvasFor;
    var paintTexFor = ctx.paintTexFor;
    var paintInkFor = ctx.paintInkFor;
    /* 与画笔共用的脏块上传通道：合成图也只在笔迹范围内重传 */
    var UP = ctx.upload || null;
    var totalBytes = ctx.totalBytes, syncBytes = ctx.syncBytes;
    var HISTORY_BUDGET = ctx.historyBudget;

    /* doc → { 槽名: 配置 }：本会话的完整配置（含「不能落盘」的临时层）。
     * 读的时候先看这里，保证同一会话里加了又撤、撤了又加不会丢层。 */
    var sessionCfg = new WeakMap();
    /* doc → { 槽下标: true }：这一槽的 v4 ops 已经灌进 TexStack。
     * 用来区分「栈是空的」和「栈还没读过」，否则一次写盘就会把用户的笔迹删光。 */
    var opsReady = new WeakMap();
    function opsReadyOf(doc) {
      var m = opsReady.get(doc);
      if (!m) { m = Object.create(null); opsReady.set(doc, m); }
      return m;
    }
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
    /* 纹理配置按「材质稳定 id」落库：改名 / 删槽 / 追加资产之后仍是同一份配置，
     * 不同模型里同名的槽也不会再共享一条记录。老数据按槽名存过，读的时候做一次兜底。 */
    function slotKeyOf(doc, slot) {
      var ids = (doc && doc.materials && doc.materials.slotIds) || [];
      if (ids[slot]) return String(ids[slot]);
      var names = (doc && doc.materials && doc.materials.slotNames) || [];
      return names[slot] ? String(names[slot]) : ('slot' + slot);
    }
    function slotIndexOf(doc, key) {
      var ids = (doc && doc.materials && doc.materials.slotIds) || [];
      for (var j = 0; j < ids.length; j++) if (String(ids[j]) === key) return j;
      var names = (doc && doc.materials && doc.materials.slotNames) || [];
      for (var i = 0; i < names.length; i++) if (String(names[i]) === key) return i;
      var m = /^slot(\d+)$/.exec(key || '');
      return m ? Number(m[1]) : -1;
    }
    /* 混合面板只列「当前对象自己的槽」：场景里并排摆着几个模型时，
     * 下拉里不该出现别人模型的材质；没有归属信息时退回全量。 */
    function listSlots(doc) {
      var n = slotCount(doc);
      var out = [];
      try {
        var S = global.SeedModel && global.SeedModel.Scene;
        if (S && S.slotsOf) out = S.slotsOf(doc, S.nodeOf(doc));
      } catch (e) { out = []; }
      if (!out.length) { for (var i = 0; i < n; i++) out.push(i); }
      return out;
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

    /* normLayer / encLayer 已提到 IIFE 顶层（纯函数，供探针直接测） */
    /* v1 = 单贴图；v2 = 图层栈；v3 = 多一张 baked（烘焙后的基础贴图）；
     * v4 = 再多一个 ops（编辑层栈：投射落位 / 笔迹的增量图）。
     * 旧配置必须能读，别为了省事只认新格式。 */
    function normCfg(raw) {
      var ops = (raw && Array.isArray(raw.ops)) ? raw.ops : [];
      if (!raw) return { v: 2, layers: [], baked: null, ops: ops };
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
        return { v: raw.v || 2, layers: raw.layers.map(normLayer).filter(Boolean), baked: baked, ops: ops };
      }
      if (raw.id || raw.name) return { v: 2, layers: [normLayer(raw)].filter(Boolean), baked: null, ops: ops };
      return { v: 2, layers: [], baked: null, ops: ops };
    }
    function encCfg(cfg, persist, opsDesc) {
      var ls = (cfg.layers || []).map(function (l) { return encLayer(l, persist); }).filter(Boolean);
      var b0 = cfg.baked;
      var baked = (b0 && (b0.id || (!persist && b0.src))) ? {
        id: String(b0.id || ''), name: String(b0.name || ''),
        flipY: b0.flipY !== false
      } : null;
      if (baked && !persist && b0.src) baked.src = String(b0.src);
      var ops = (opsDesc && opsDesc.length) ? opsDesc : null;
      if (!ls.length && !baked && !ops) return null;
      var out = { v: ops ? 4 : (baked ? 3 : 2), layers: ls, baked: baked };
      if (ops) out.ops = ops;
      return out;
    }

    /* 编辑层栈 → 配置里的 ops。返回 null 表示「这一槽的栈还没被本会话碰过」，
     * 写盘时要沿用旧记录里的 ops，不能当成空数组把用户的笔迹删掉。 */
    function collectOpsDesc(doc, slot) {
      if (!global.TexStack) return null;
      var rdy = opsReadyOf(doc);
      if (rdy[slot]) return global.TexStack.toDesc(doc, slot);
      if (global.TexStack.has(doc, slot)) return global.TexStack.toDesc(doc, slot);
      return null;
    }

    /* 大块像素落盘前先外置（blob-store：localStorage 只留 'blob:<id>' 存根）。
     * 外置不可用时原样内联 —— 宁可占，不丢。 */
    function packOps(opsDesc, persist) {
      if (!persist || !opsDesc) return opsDesc;
      var out = [];
      for (var i = 0; i < opsDesc.length; i++) {
        var d = opsDesc[i], o = {};
        for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) o[k] = d[k];
        if (o.src && typeof blobPack === 'function') o.src = blobPack(o.src);
        out.push(o);
      }
      return out;
    }

    function cfgSig(cfg) {
      /* 不能 JSON.stringify(cfg)：ops 里是整张 PNG 的 data URL，
       * 拖滑杆时每帧 stringify 一遍会直接卡死（这是同步路径）。 */
      var o = cfg.ops || [], key = '';
      for (var i = 0; i < o.length; i++) {
        key += (o[i] && o[i].type || '') + ':' + (o[i] && o[i].src ? String(o[i].src).length : 0) + ':';
      }
      return JSON.stringify({ v: cfg.v, layers: cfg.layers, baked: cfg.baked }) + '#' + o.length + '#' + key;
    }

    function memOf(doc) {
      var m = sessionCfg.get(doc);
      if (!m) { m = Object.create(null); sessionCfg.set(doc, m); }
      return m;
    }
    function readCfg(doc, slot) {
      if (!doc) return { v: 2, layers: [], baked: null, ops: [] };
      var k = slotKeyOf(doc, slot);
      var mem = sessionCfg.get(doc);
      if (mem && mem[k]) return normCfg(mem[k]);
      var assetKey = doc.materials && doc.materials.textureConfigKey;
      if (!assetKey) return { v: 2, layers: [], baked: null, ops: [] };
      var all = readStore();
      var bag = all[assetKey];
      if (bag && bag[k]) return normCfg(bag[k]);
      return { v: 2, layers: [], baked: null, ops: [] };
    }
    /* 写配置：本会话快照一定更新；能落盘的（有资产 id 的层）同步写 localStorage。
     * 不落盘的层只留在 sessionCfg 里，和模型库「网页版本次会话有效」的语义一致。
     * ops（编辑层栈）只从 TexStack 取 —— 配置是它的镜像，不能反过来当真源。 */
    function writeCfg(doc, slot, cfg) {
      if (!doc) return;
      var k = slotKeyOf(doc, slot);
      var mem = memOf(doc);
      var full = encCfg(cfg, false, collectOpsDesc(doc, slot));
      if (full) mem[k] = full; else delete mem[k];
      var assetKey = doc.materials && doc.materials.textureConfigKey;
      if (!assetKey) return;
      var all = readStore();
      var m = (all[assetKey] && typeof all[assetKey] === 'object') ? all[assetKey] : {};
      var prev = (m[k] && typeof m[k] === 'object') ? m[k] : null;
      /* 栈还没被本会话碰过：沿用旧记录里的 ops，别用「空」覆盖掉用户的笔迹 */
      var desc = collectOpsDesc(doc, slot);
      if (desc === null) desc = (prev && Array.isArray(prev.ops)) ? prev.ops : null;
      var p = encCfg(cfg, true, packOps(desc, true));
      /* 兜底：ops 内联进 localStorage 会撑爆 5MB 配额（外置不可用的浏览器）。
       * 撞线就只落图层，ops 退回「本次会话有效」—— 宁少存，不要写坏整条记录。 */
      if (p) {
        var sz = 0;
        try { sz = JSON.stringify(p).length; } catch (e) { sz = 0; }
        if (sz > 1200 * 1024 && p.ops) {
          delete p.ops;
          p.v = p.baked ? 3 : 2;
          if (!p.layers || !p.layers.length) p = (p.baked ? p : null);
        }
      }
      if (p) m[k] = p; else delete m[k];
      if (Object.keys(m).length) all[assetKey] = m; else delete all[assetKey];
      writeStore(all);
    }
    /* 老资产把纹理配置按「槽名」存在同一个资产 key 下；
     * 现在改按材质稳定 id 存，打开时一次性搬过去，之后读写都不再猜名字，
     * 避免两个模型里有同名槽时读到同一条配置（跨模型串贴图的根因）。 */
    function migrateLegacy(doc) {
      if (!doc || !doc.materials) return 0;
      var assetKey = doc.materials.textureConfigKey;
      var names = doc.materials.slotNames || [];
      var ids = doc.materials.slotIds || [];
      if (!assetKey || !names.length) return 0;
      var all = readStore();
      var bag = all[assetKey];
      if (!bag || typeof bag !== 'object') return 0;
      var mem = sessionCfg.get(doc), moved = 0;
      for (var i = 0; i < names.length; i++) {
        var id = ids[i], nm = names[i];
        if (!id || !nm || id === nm) continue;
        if (!bag[id] && bag[nm]) { bag[id] = bag[nm]; moved++; }
        if (mem && !mem[id] && mem[nm]) mem[id] = mem[nm];
      }
      if (moved) writeStore(all);
      return moved;
    }
    /* 追加资产时把源材质的整份纹理配置搬到目标槽上：
     * 源 key 下可能还是「槽名」旧键，所以候选键由调用方按 id → 名字依次给。 */
    function adoptSlot(doc, destSlot, srcAssetKey, srcKeys) {
      if (!doc || !srcAssetKey) return false;
      var all = readStore();
      var bag = all[srcAssetKey];
      if (!bag) return false;
      var raw = null;
      (srcKeys || []).some(function (key) {
        if (key && bag[key]) { raw = bag[key]; return true; }
        return false;
      });
      if (!raw) return false;
      var k = slotKeyOf(doc, destSlot);
      memOf(doc)[k] = normCfg(raw);
      var assetKey = doc.materials && doc.materials.textureConfigKey;
      if (!assetKey) return true;
      var m = (all[assetKey] && typeof all[assetKey] === 'object') ? all[assetKey] : {};
      m[k] = raw;
      all[assetKey] = m;
      writeStore(all);
      return true;
    }
    function snapCfg(slot) {
      /* 快照**不含 ops**：混合配置的撤销只该管图层与烘焙图，
       * 笔迹 / 投射层有它们自己的 tex 历史条目。顺带也是性能问题 ——
       * ops 里是整张 PNG，混进快照等于每拖一次滑杆编码一遍所有笔迹。 */
      var cfg = readCfg(docOf(), slot);
      return JSON.stringify({ v: cfg.v, layers: cfg.layers, baked: cfg.baked });
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
      var sig = cfgSig(cfg);
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
          img: img, mask: mask,
          kind: l.kind || '', islands: l.islands || []
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
      /* v4 的 ops：灌进 TexStack（编辑层栈的唯一真源）。
       * 只在「这一槽还没灌过、栈也空着」时做 —— 用户在当前会话里已经推过层，
       * 说明栈比配置新，不能拿配置反向覆盖。 */
      await hydrateOps(doc, slot, cfg, rec);
      return rec;
    }

    async function hydrateOps(doc, slot, cfg, rec) {
      var rdy = opsReadyOf(doc);
      if (rdy[slot] === 1 || rdy[slot] === 2) return;   /* 已完成 / 正在灌 */
      if (!global.TexStack) { rdy[slot] = 1; return; }
      if (global.TexStack.has(doc, slot)) { rdy[slot] = 1; return; }
      var list0 = (cfg && cfg.ops) || [];
      if (!list0.length) { rdy[slot] = 1; return; }
      rdy[slot] = 2;
      /* 存根（'blob:<id>'）要靠 blob-store 的内存缓存才能同步还原，先等它载完 */
      if (typeof blobEnsure === 'function') { try { await blobEnsure(); } catch (e) {} }
      var list = [];
      for (var i = 0; i < list0.length; i++) {
        var d = list0[i];
        if (!d || !d.src) continue;
        var src = (typeof blobResolve === 'function') ? blobResolve(d.src) : d.src;
        if (!src) continue;
        try {
          var im = await urlImg(src);
          var op = global.TexStack.fromDesc(d, im);
          if (op) list.push(op);
        } catch (e) { /* 单层解码失败不该毁掉整槽 */ }
      }
      if (!list.length) {
        /* 一层都没解出来（图丢了 / 存根还在但库读不到）：**不置 ready**。
         * 置了的话下一次写配置就会把 ops 当空数组删掉 —— 数据是救不回来的，
         * 至少要让它们留在配置里，等资产库恢复后还能再试。 */
        rdy[slot] = 0;
        return;
      }
      rdy[slot] = 1;
      global.TexStack.setOps(doc, slot, list);
      /* 灌进来的层要让合成重跑一次 */
      rec.sig = '';
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
      if (rec.tex) {
        if (UP) UP.untrack(rec.tex);
        try { rec.tex.dispose(); } catch (e) {}
        rec.tex = null;
      }
    }

    /* box 非空 = 只有这块像素变了（笔迹增量），按块上传；
     * 换画布 / 换纹理时整张重传。 */
    function ensureTex(rec, canvas, box) {
      if (rec.tex && rec.tex.image === canvas) {
        if (UP && box) UP.markDirty(rec.tex, box);
        else rec.tex.needsUpdate = true;
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
      if (UP) UP.track(tex); else tex.needsUpdate = true;
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
      if (url) { applySlotTexture(slot, sharedTexture(url)); return; }
      /* slotMaps 里没有 URL 时**不能**把材质清成 null：材质上那张可能就是唯一的图
       * （只在 map 上的老资产 / 合成图）。清掉就是「撤销一下贴图全没了」。
       * 只有材质上本来也没图，才真的清空。 */
      if (liveSlotImage && liveSlotImage(slot)) return;
      applySlotTexture(slot, null);
    }

    /* 编辑层栈的合成结果。kinds 限定只回放某一类层：
     *   - 投射（project）属于「底座」，在混合层之下；
     *   - 笔迹（stroke）必须叠在混合层之上 —— 否则不透明贴图会把刚画的像素盖掉
     *     （2026-11-16：抬笔后笔迹消失就是这个顺序问题）。
     * 缓存键带上「底座的来源 + 地址 + 尺寸」—— 换图 / 撤销画笔之后底座变了，
     * 继续用旧合成图会把上一次的像素留在视口里。 */
    function editsFor(slot, doc, rec, kinds) {
      if (!global.TexStack || !global.TexStack.has(doc, slot)) return null;
      var base = null, key = '';
      if (global.TexSource) {
        var r = global.TexSource.resolveBase(slot, { cached: rec && rec.baseImg, cachedUrl: rec && rec.baseUrl });
        base = r.img;
        key = r.from + '|' + r.url + '|' + (base ? (base.naturalWidth || base.width) + 'x' + (base.naturalHeight || base.height) : '');
      }
      return global.TexStack.edited(doc, slot, { base: base, baseKey: key, kinds: kinds });
    }

    /* 这一槽里有没有橡皮笔迹：有就得走「透明笔迹层」合成，不能直接往合成图上打洞 */
    function strokesHasErase(doc, slot) {
      if (!global.TexStack) return false;
      var list = global.TexStack.ops(doc, slot) || [];
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (o && o.type === 'stroke' && o.mode === 'erase') return true;
      }
      return false;
    }

    /* 这一槽里有没有模糊笔迹：有就不能再用「工作副本当底座」的快路径，
     * 否则 blur 层回放时没有底座可糊（而且层会被跳过） */
    function opsHaveBlur(doc, slot) {
      if (!global.TexStack) return false;
      var list = global.TexStack.ops(doc, slot) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].type === 'blur') return true;
      }
      return false;
    }

    /* 合成结果的状态快照：尺寸 / 底座对象 / 混合层对象与不透明度 / 已提交笔迹 rev。
     * 全都没变时，这一帧只需要把新增的笔迹补上去 —— 有混合层也不必从底座重画整张。 */
    function composeStateOf(sz, baseImg, eff, rev) {
      return {
        w: sz.w, h: sz.h, base: baseImg || null, rev: rev | 0,
        layers: (eff || []).slice(), opacs: (eff || []).map(function (l) { return l.opacity; })
      };
    }
    function sameCompose(s, sz, baseImg, eff, rev) {
      if (!s || s.w !== sz.w || s.h !== sz.h || s.base !== (baseImg || null) || s.rev !== (rev | 0)) return false;
      if (s.layers.length !== (eff || []).length) return false;
      for (var i = 0; i < s.layers.length; i++) {
        if (s.layers[i] !== eff[i] || s.opacs[i] !== eff[i].opacity) return false;
      }
      return true;
    }
    /* 画布坐标的脏块 → 目标画布坐标（两边尺寸可能不同，例如笔迹 2048、合成 1024） */
    function scaleBox(b, sw, sh, dw, dh) {
      if (!b || !sw || !sh || !dw || !dh) return null;
      var x0 = Math.max(0, Math.floor(b.x * dw / sw));
      var y0 = Math.max(0, Math.floor(b.y * dh / sh));
      var x1 = Math.min(dw, Math.ceil((b.x + b.w) * dw / sw));
      var y1 = Math.min(dh, Math.ceil((b.y + b.h) * dh / sh));
      if (!(x1 > x0 && y1 > y0)) return null;
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }

    /* 把「底座 + 混合层 + 笔迹」写成一张画布并挂到材质上。
     * 顺序是固定的：底座 → 混合层（TB.compose）→ 已提交的笔迹 / 模糊层 → 正在画的这一笔。
     * 笔迹必须在混合层之上；放到下面就会被不透明贴图整片盖住。 */
    /* 整图重算次数：性能基准用它判断「拖动时是否还在整张合成」。
     * 增量合成不计入 —— 它的成本是笔刷包围盒，与整图不是一个量级。 */
    var composeN = 0;
    function composeOnto(doc, slot, rec, baseImg, eff, ink) {
      var sz = TB.mixSize({ baseImg: baseImg, layers: eff || [] }, MAX_SIDE);
      /* 只有笔迹、没有底座/混合层时，尺寸要跟笔迹画布一致（工作副本 2048），
       * 不能落到 mixSize 的 1024 默认值 —— 否则笔迹被缩小后再贴回 UV。 */
      if (!sz || ((!baseImg || !baseImg.width) && !(eff && eff.length))) {
        var ops = (global.TexStack && global.TexStack.ops(doc, slot)) || [];
        for (var i = 0; i < ops.length; i++) {
          var c0 = ops[i] && ops[i].canvas;
          if (c0 && c0.width) { sz = { w: c0.width, h: c0.height }; break; }
        }
      }
      if (!rec.canvas) rec.canvas = document.createElement('canvas');
      var hasStrokes = !!(global.TexStack && global.TexStack.has(doc, slot));
      var hasInk = !!(ink && ink.canvas && ink.canvas.width);
      var blurInk = !!(hasInk && ink.type === 'blur');
      var strokeInk = hasInk && !blurInk;
      /* 橡皮（erase）必须在**单独的透明笔迹层**上打洞，再整层盖回去 ——
       * 直接 destination-out 到合成图上会把底座一起擦出透明洞（视口变黑）。
       * 模糊层（blur）相反：它必须对「已经合成好的结果」做，所以永远直接作用在 cv 上。 */
      var erase = (strokeInk && ink.mode === 'erase') || strokesHasErase(doc, slot);
      var rev = hasStrokes ? global.TexStack.rev(doc, slot) : 0;
      var inkBox = (ink && ink.box) || null;

      /* 增量合成：底座 / 混合层 / 已提交笔迹都没变，只有这一笔在长。
       * 只把 ink 的脏块盖到上一帧的结果上 —— 与整图重算逐像素一致，
       * 因为这块以外 rec.canvas 的内容本来就没有变。 */
      if (inkBox && strokeInk && !erase && rec.canvas.width === sz.w && rec.canvas.height === sz.h &&
          sameCompose(rec.composeState, sz, baseImg, eff, rev)) {
        var cvI = rec.canvas;
        var bx = scaleBox(inkBox, ink.canvas.width, ink.canvas.height, cvI.width, cvI.height);
        if (bx) {
          var gi = cvI.getContext('2d');
          var kx = ink.canvas.width / cvI.width, ky = ink.canvas.height / cvI.height;
          gi.globalAlpha = 1;
          gi.globalCompositeOperation = 'source-over';
          gi.drawImage(ink.canvas, bx.x * kx, bx.y * ky, bx.w * kx, bx.h * ky,
            bx.x, bx.y, bx.w, bx.h);
          rec.slotName = slotKeyOf(doc, slot);
          applySlotTexture(slot, ensureTex(rec, cvI, bx));
          return;
        }
      }

      var cv = TB.compose({
        w: sz.w, h: sz.h, baseImg: baseImg, layers: eff || [], canvas: rec.canvas,
        /* 没有底座时用材质槽色打底，别用 TB 默认的白 —— 否则「没贴图的模型」
         * 一进合成就变白，和材质本色对不上 */
        baseColor: ((doc.materials && doc.materials.slotColors) || [])[slot] || '#c9ccd4'
      });
      rec.canvas = cv;
      composeN++;
      if (hasStrokes || hasInk) {
        if (erase) {
          var lc = rec.inkCv;
          if (!lc) lc = rec.inkCv = document.createElement('canvas');
          if (lc.width !== cv.width) lc.width = cv.width;
          if (lc.height !== cv.height) lc.height = cv.height;
          var l2 = lc.getContext('2d');
          l2.setTransform(1, 0, 0, 1, 0, 0);
          l2.globalAlpha = 1;
          l2.globalCompositeOperation = 'source-over';
          l2.clearRect(0, 0, lc.width, lc.height);
          if (hasStrokes) global.TexStack.overlay(lc, doc, slot, ['stroke']);
          if (strokeInk) {
            l2.globalCompositeOperation = ink.mode === 'erase' ? 'destination-out' : 'source-over';
            l2.drawImage(ink.canvas, 0, 0, lc.width, lc.height);
            l2.globalCompositeOperation = 'source-over';
          }
          var c3 = cv.getContext('2d');
          c3.globalAlpha = 1;
          c3.globalCompositeOperation = 'source-over';
          c3.drawImage(lc, 0, 0);
          /* 模糊层排在笔迹之后（只在「橡皮 + 模糊」混用时顺序才会略偏） */
          if (hasStrokes) global.TexStack.overlay(cv, doc, slot, ['blur']);
        } else {
          if (hasStrokes) global.TexStack.overlay(cv, doc, slot, ['stroke', 'blur']);
          if (strokeInk) {
            var c2 = cv.getContext('2d');
            c2.globalAlpha = 1;
            c2.globalCompositeOperation = 'source-over';
            c2.drawImage(ink.canvas, 0, 0, cv.width, cv.height);
          }
        }
        if (blurInk) global.TexStack.blurMasked(cv, ink.canvas, ink.radius || 0);
      }
      rec.slotName = slotKeyOf(doc, slot);
      /* 整图重算完成后的快照：下一帧若只有 ink 增长，就走上面的增量分支 */
      rec.composeState = composeStateOf(sz, baseImg, eff, rev);
      var tex = ensureTex(rec, cv, null);
      applySlotTexture(slot, tex);
    }

    /* 合成用的底座：烘焙图 / 仅投射层 / 解码缓存 / 材质实图。
     * 唯一要排除的是「绘画工作副本」—— 它已经含笔迹，当底座会成双份。 */
    function baseFor(slot, doc, rec) {
      var proj = editsFor(slot, doc, rec, ['project']);
      if (proj) return proj;
      if (global.TexSource) {
        var r = global.TexSource.resolveBase(slot, { cached: rec && rec.baseImg, cachedUrl: rec && rec.baseUrl });
        var img = r.img || null;
        var pc = paintCanvasFor ? paintCanvasFor(slot) : null;
        if (img && img !== pc) return img;
      }
      return rec.baseImg || null;
    }

    /* 工作副本直接当合成图：**不能再回放层栈**。
     * 工作副本里已经是「底座 ⊕ 全部已提交层 ⊕ 这一笔」的像素，再叠一次同样的
     * 笔迹会让半透明笔变深（抬笔瞬间颜色变重，层越多越明显）。
     * 上传量按「新增的那一层」回算：同一张工作副本、层栈只追加了一笔时，
     * 变化的只有这一笔的 bbox，不需要把 2048² 整张再传一遍。 */
    function adoptPaintCanvas(doc, slot, rec, src, liveInk) {
      var rev = (global.TexStack && global.TexStack.has(doc, slot)) ? global.TexStack.rev(doc, slot) : 0;
      /* 同一张工作副本 + 同一版层栈 + 没有正在画的这一笔：视口里已经是它，不拷贝也不上传 */
      if (!liveInk && rec.canvas && rec.pcRef === src && rec.pcRev === rev) {
        if (rec.tex) applySlotTexture(slot, rec.tex);
        else applySlotTexture(slot, ensureTex(rec, rec.canvas, null));
        return;
      }
      var cv = rec.canvas;
      if (!cv) cv = rec.canvas = document.createElement('canvas');
      var box = null;
      if (!liveInk && rec.pcRef === src && cv.width === src.width && cv.height === src.height &&
          rev === (rec.pcRev | 0) + 1 && global.TexStack) {
        var ops = global.TexStack.ops(doc, slot);
        var last = ops[ops.length - 1];
        /* 只有「追加一笔笔迹」能用 bbox 增量：投射层进的是底座，不在工作副本里 */
        if (last && last.type === 'stroke' && last.bbox) {
          box = scaleBox(last.bbox, src.width, src.height, cv.width, cv.height);
        }
      }
      if (cv.width !== src.width) cv.width = src.width;
      if (cv.height !== src.height) cv.height = src.height;
      var g = cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      /* 先清再画：只处理 bbox，其余像素保持上次采纳的结果。
       * 不能用 'copy'：它对源矩形之外的整张画布也会生效（实测会把画面清空）；
       * 也不能只画不清：橡皮留下的透明像素会盖不掉旧笔迹。 */
      if (box) {
        g.clearRect(box.x, box.y, box.w, box.h);
        g.drawImage(src, box.x, box.y, box.w, box.h, box.x, box.y, box.w, box.h);
      } else {
        g.clearRect(0, 0, cv.width, cv.height);
        g.drawImage(src, 0, 0);
      }
      rec.pcRef = src;
      rec.pcRev = rev;
      /* 合成图的来源不再是「底座 + 层栈」的组合：下次改层必须整图重算，
       * 不能走 composeOnto 的增量分支（那块像素的来源已经对不上了） */
      rec.composeState = null;
      composeN++;
      rec.slotName = slotKeyOf(doc, slot);
      applySlotTexture(slot, ensureTex(rec, cv, box));
    }

    function composeAndApply(slot) {
      var doc = docOf();
      if (!doc) return;
      var rec = recOf(doc, slot);
      var pc = paintCanvasFor ? paintCanvasFor(slot) : null;
      var eff = effectiveLayers(rec);
      var hasOps = !!(global.TexStack && global.TexStack.has(doc, slot));
      var ink = paintInkFor ? paintInkFor(slot) : null;
      var blur = !!(ink && ink.type === 'blur') || opsHaveBlur(doc, slot);
      /* 边画边看：没有混合层时，材质上直接挂绘画工作副本就够了 ——
       * 笔尖每落一次只改那张画布，纹理自己 needsUpdate；每帧再整张重合成
       * （2048² 拷贝 + 新纹理上传）会把拖动手感拖垮。抬笔后 ink 归 null，
       * 再走下面的正常合成。模糊笔也一样：工作副本里已经做了局部模糊。 */
      var ptex = paintTexFor ? paintTexFor(slot) : null;
      if (!eff.length && ptex && ink) { applySlotTexture(slot, ptex); return; }
      /* 没有混合层时，绘画工作副本就是最终像素（底座 ⊕ 已提交层 ⊕ 这一笔）。
       * 抬笔后 ink 归 null，这里把它当成成品直接采纳 —— 回放层栈会把同一批笔迹
       * 再叠一遍（橡皮还会多擦一次），所以走 adoptPaintCanvas 而不是 composeOnto。
       * 模糊例外：blur 层要作用在「底座 + 混合层」的结果上，工作副本里没有
       * 混合层，不能拿它当底座，否则糊出来的是底座颜色。 */
      if (!eff.length && pc && !blur) { adoptPaintCanvas(doc, slot, rec, pc, !!ink); return; }
      var baked = (rec.baked && rec.baked.img) || null;
      if (!eff.length && !baked && !hasOps && !ink) { applyBase(slot); return; }
      /* 底座只取「投射」层：笔迹由 composeOnto 叠在混合层之上 */
      var baseImg = baked || baseFor(slot, doc, rec);
      composeOnto(doc, slot, rec, baseImg, eff, ink);
    }

    /* 编辑层栈落盘：栈的 rev 变了就写一次配置（v4）。
     * 触发点是「合成之后」而不是「推层那一刻」—— 推层在绘画 / 投射两条同步路径上，
     * 那里 toDataURL 会把落笔手感拖垮；这里已经在 rAF 里，一次编码换一次持久化。 */
    function persistOps(doc, slot) {
      if (!global.TexStack) return;
      var assetKey = doc.materials && doc.materials.textureConfigKey;
      if (!assetKey) return;      /* 还没保存过：没有 key 可以挂，落盘是无处可写 */
      var rec = recOf(doc, slot);
      var rv = global.TexStack.rev(doc, slot);
      if (rec.opsRev === rv) return;
      /* 新笔迹的像素还在异步编码（OffscreenCanvas → data URL）。
       * 这时候写配置会拿到「没有 src」的层，等于把这一笔从存档里删掉：
       * 等编完再写，期间不占用主线程。 */
      if (global.TexStack.pendingSrc(doc, slot) > 0) {
        if (!rec.opsEnc) {
          rec.opsEnc = true;
          global.TexStack.ensureSrc(doc, slot).then(function () {
            rec.opsEnc = false;
            if (st.doc === doc) persistOps(doc, slot);
          }).catch(function () { rec.opsEnc = false; });
        }
        return;
      }
      rec.opsRev = rv;
      writeCfg(doc, slot, readCfg(doc, slot));
    }

    function pump(slot) {
      var doc = docOf();
      if (!doc) return;
      var rec = recOf(doc, slot);
      var sig = cfgSig(readCfg(doc, slot));
      var baseUrl = ((doc.materials && doc.materials.slotMaps) || [])[slot] || '';
      /* 基础贴图也可能变（撤销画笔 / 换图）：变了就得重新解码，
       * 不能拿旧的 rec.baseImg 继续合成。 */
      if (rec.ready && rec.sig === sig && rec.baseUrl === baseUrl) {
        composeAndApply(slot);
        persistOps(doc, slot);
        return;
      }
      ensureSlot(slot, false).then(function (r) {
        if (!r || st.doc !== doc) return;
        composeAndApply(slot);
        persistOps(doc, slot);
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

    /* 单槽刷新。返回 Promise 的语义：调用方（基准 / 探针）要等「层解码 + 合成完成」
     * 再测性能，不能假设贴图解码是同步的。 */
    function refreshSlot(slot, force) {
      var doc = docOf();
      if (!doc) return Promise.resolve(0);
      var cfg = readCfg(doc, slot);
      var rec = recOf(doc, slot);
      /* 编辑层栈也算「有东西要合成」：没有混合层时它是唯一让视口更新的路径 */
      var hasEdits = !!(global.TexStack && global.TexStack.has(doc, slot));
      var idle = !(cfg.layers.length || cfg.baked || hasEdits);
      if (idle) {
        if (rec.texValid) applyBase(slot);
        else if (!rec.ready) {
          /* 没配置也没合成过：什么都不用动，材质本来就是基础贴图 */
        }
        rec.ready = true; rec.sig = JSON.stringify(cfg);
        return Promise.resolve(0);
      }
      return ensureSlot(slot, force).then(function (r) {
        if (!r || st.doc !== doc) return 0;
        composeAndApply(slot);
        if (uiReady) renderUi();
        return 1;
      }).catch(function (e) {
        setStatus('纹理混合：' + ((e && e.message) || e), true);
        return 0;
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
    /* 这个槽「未合成的底座」—— 混合层要叠在它上面，绘画/投射要在它上面画。
     * 具体从哪张取由 TexSource 统一决定（baked → slotMaps → 本模块解码缓存 → live），
     * 四个读者共用同一条顺序，避免各处答案不同（2026-11-11 调研的根因）。 */
    function baseImageFor(slot) {
      var doc = docOf();
      if (!doc) return null;
      var rec = recOf(doc, slot);
      if (global.TexSource) {
        var r = global.TexSource.resolveBase(slot, { cached: rec.baseImg, cachedUrl: rec.baseUrl });
        return r.img || null;
      }
      /* TexSource 没加载时的降级（老页面 / 单测直引本文件） */
      if (rec.baked && rec.baked.img) return rec.baked.img;
      if (rec.baseImg) return rec.baseImg;
      var url = ((doc.materials && doc.materials.slotMaps) || [])[slot] || '';
      if (url) {
        var t = sharedTexture(url);
        if (t && t.image && t.image.width) return t.image;
      }
      if (liveSlotImage) {
        var live = liveSlotImage(slot);
        if (live && (live.width || live.naturalWidth)) return live;
      }
      return null;
    }

    /* 上一轮「固化为底图」留下的底图（没有就是 null）。
     * TexSource 用它作为 slotMaps 之后的第二来源。 */
    function bakedImageFor(slot) {
      var doc = docOf();
      if (!doc) return null;
      var rec = recOf(doc, slot);
      return (rec.baked && rec.baked.img) || null;
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
        var n0 = normCfg(mem[k]);
        var p = encCfg(n0, true, packOps((n0.ops && n0.ops.length) ? n0.ops : null, true));
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
      var cv = TB.compose({
        w: sz.w, h: sz.h, baseImg: baseImg, layers: eff,
        baseColor: ((doc.materials && doc.materials.slotColors) || [])[slot] || '#c9ccd4'
      });
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

      var slots = listSlots(doc);
      var n = slotCount(doc);
      var names = doc.materials.slotNames || [];
      var slot = slots.indexOf(curSlot) >= 0 ? curSlot : slots[0];
      if (slot == null) slot = Math.min(curSlot, n - 1);
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
      for (var si = 0; si < slots.length; si++) {
        var i = slots[si];
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
      var slots = listSlots(doc);
      slot = Math.round(Number(slot) || 0);
      if (slots.indexOf(slot) < 0) slot = slots[0] != null ? slots[0] : 0;
      if (slot === curSlot) return;
      curSlot = slot;
      if (uiReady) renderUi();
    }

    /* 重新从配置里灌一次编辑层栈（丢掉当前栈）。
     * 用途：换文档 / 外部把配置改了 / 探针模拟「刷新页面」。
     * 正常打开页面时由 ensureSlot 自动调一次，这里是显式入口。 */
    function rehydrate(slot) {
      var doc = docOf();
      if (!doc) return Promise.resolve(0);
      slot = Math.max(0, Math.min(slotCount(doc) - 1, Number(slot) || 0));
      var rdy = opsReadyOf(doc);
      delete rdy[slot];
      var rec = recOf(doc, slot);
      return hydrateOps(doc, slot, readCfg(doc, slot), rec).then(function () {
        refreshSlot(slot, true);
        return global.TexStack ? global.TexStack.ops(doc, slot).length : 0;
      });
    }

    return {
      init: init, refresh: refresh, renderUi: renderUi, schedule: schedule,
      /* 同步重合成：撤销「投射层 / 固化」之后要立刻看到结果，不能等异步解码。
       * 层没变、只变底座或编辑层栈时用这条。 */
      composeNow: composeAndApply,
      rehydrate: rehydrate,
      /* 单槽刷新（投射改了编辑层栈之后调它）：会重新解码层再合成 */
      refreshSlot: refreshSlot,
      baseImageFor: baseImageFor, bakedImageFor: bakedImageFor, texFor: texFor, applyPatch: applyPatch,
      rekey: rekey, selectSlot: selectSlot, adoptSlot: adoptSlot, listSlots: listSlots,
      migrateLegacy: migrateLegacy,
      /* 性能基准：整图重算次数（增量合成不计） */
      stats: function () { return { compose: composeN }; }
    };
  }

  /* 纯函数挂出来供探针直接测：模型库写进层里的 kind / islands，
   * 建模 App 一次读写绝不能把它们洗掉（跟 M3DSlots.mergeSlotRec 同款约定）。 */
  global.MDTexMix = {
    create: create,
    normLayer: normLayer, encLayer: encLayer
  };
})(window);
