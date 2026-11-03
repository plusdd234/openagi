/* ============================================================
 * 3D 材质插槽面板：查看 / 纹理混合 / 导出 GLB
 *
 * 从 js/model3d.js 拆出（2026-11-01）。只被预览视口调用（setupSlotPanel(deps)），
 * 共享的私有实现（clampNum / bufToDataURL / saveDataURL / renderThumb）通过
 * global.__m3d 取用，不另立一套。
 * ============================================================ */
(function (global) {
  'use strict';

  var THREE = global.THREE;
  var M = global.__m3d || {};

  var clampNum = M.clampNum;
  var bufToDataURL = M.bufToDataURL;
  var saveDataURL = M.saveDataURL;
  var renderThumb = M.renderThumb;

  /* ---------------- 材质插槽：查看 + 纹理混合 + 导出 GLB ----------------
   * 模型库「设置贴图」的入口（2026-10-30）：预览弹窗里列出模型全部材质插槽
   * （按材质去重，一个材质可能被多个 mesh 共用），每个槽可以：
   *   ① 纹理混合（2026-10-31 起）：图层栈，每层可各自调「混合模式 + 比例 + 遮罩」；
   *   ② 清除混合 → 回到模型自带贴图；
   *   ③ 整体导出 GLB（合成贴图内嵌）→ 存回模型库 / 下载。
   *
   * 为什么是「烘一张图」而不是着色器里混：
   *   GLB 导出只认 mat.map 一张图，用 onBeforeCompile 混出来的只有视口好看，导出后是空的。
   *   这里把每层按 比例 × 遮罩 × 混合模式 烘进 canvas 再当贴图用，
   *   视口 / 缩略图 / GLB 内嵌图三处永远是同一张，不会「预览对了导出不对」。
   *
   * 为什么存 GLB 而不是 OBJ+MTL+PNG 三件套：
   *   资产库一个资产就是一个文件，三件套拆成三个资产后文件名互不相干，
   *   模型库双击预览走 OBJLoader（不带 MTL），看到的仍是灰模。
   *   GLB 把贴图嵌进文件本身，导出即所见，任何查看器打开都带贴图。
   *
   * flipY 的坑：glTF 的 UV 按「纹理不翻转」设计（GLTFLoader 里 flipY=false），
   * OBJ 走传统约定（flipY=true）。合成贴图必须跟槽里原有贴图保持一致——
   * 槽里没有贴图时按模型格式兜底，否则 GLB 模型贴图会上下颠倒。
   */
  function setupSlotPanel(deps) {
    var model = deps.model, stage = deps.stage, bar = deps.bar;
    var mkBtn = deps.mkBtn, hint = deps.hint;
    /* 手绘遮罩用的视口内部件：canvas 是射线入口，camera 定射线，controls 绘制时临时锁住 */
    var camera = deps.camera, controls = deps.controls, canvas = deps.canvas;
    var baseName = String(deps.title || 'model')
      .replace(/\.(glb|gltf|obj|fbx|stl|ply|3mf|usdz)$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_') || 'model';

    var panel = null, listEl = null;
    var picker = null, pickerAlive = false;
    var mixer = null, mixerAlive = false, mixerSlot = null, mixBody = null, bakeBtn = null;
    var fileInput = null;

    /* 单槽最多叠几层：再多滑杆也调不动，配置也会失控 */
    var MIX_LIMIT = 8;
    /* 合成画布长边上限：结果要内嵌进 GLB，4096 会让文件翻几倍，2048 已经够看 */
    var MIX_MAX_SIDE = 2048;

    /* 混合模式 → canvas 合成算子。名字沿用设计软件的说法；
     * 「相加」用 lighter——它既是唯一会让结果整体变亮的模式，也是发光层要的效果。 */
    var BLEND_MODES = [
      { key: 'normal', label: '正常', op: 'source-over' },
      { key: 'multiply', label: '正片叠底', op: 'multiply' },
      { key: 'screen', label: '滤色', op: 'screen' },
      { key: 'overlay', label: '叠加', op: 'overlay' },
      { key: 'softlight', label: '柔光', op: 'soft-light' },
      { key: 'add', label: '相加', op: 'lighter' },
      { key: 'darken', label: '变暗', op: 'darken' },
      { key: 'lighten', label: '变亮', op: 'lighten' }
    ];
    function blendOp(key) {
      for (var i = 0; i < BLEND_MODES.length; i++) if (BLEND_MODES[i].key === key) return BLEND_MODES[i].op;
      return 'source-over';
    }

    /* ---------------- 贴图配置持久化 ----------------
     * 资产库里的模型只存几何，贴图/遮罩是「查看器里的设置」，关掉窗口就没了。
     * 这里把「模型资产 id → 材质槽 → 混合层」记进 localStorage：
     * 图层与遮罩图片本身落进资产库（assetPut kind:'image'），配置只存 id 不存 base64，
     * 免得几张 2048 贴图把 5MB 的 localStorage 配额撑爆。
     * 没有桌面桥（纯网页版）时无法落盘，退化为「本次会话内有效」。
     *
     * 格式演进（别改 key，旧配置要能读）：
     *   v2 = { v:2, layers:[{id,name,flipY,opacity,blend,mask:{id,name,flipY,invert}}] }
     *   v1 = { id,name,flipY }   ← 旧版单贴图，读的时候当成一层，用户配好的贴图不会丢
     */
    var assetId = String(deps.assetId || '');
    var TEX_KEY = 'openagi_model_tex_v1';

    function readTexCfg() {
      try {
        var j = JSON.parse(localStorage.getItem(TEX_KEY) || '{}');
        return (j && typeof j === 'object') ? j : {};
      } catch (e) { return {}; }
    }
    function writeTexCfg(all) {
      try { localStorage.setItem(TEX_KEY, JSON.stringify(all)); } catch (e) { }
    }
    /* 槽的稳定标识：优先材质名（OBJ 的 usemtl 名、glTF 材质名都稳定），
     * 匿名材质退回遍历序号（模型文件不变，遍历顺序也不变）。 */
    function slotKey(slot) {
      if (slot.mat && slot.mat.name) return String(slot.mat.name);
      var ss = collectSlots();
      for (var i = 0; i < ss.length; i++) {
        if (ss[i].mat === slot.mat) return 'slot' + i;
      }
      return 'slot0';
    }
    function slotCfg() {
      if (!assetId) return null;
      var all = readTexCfg();
      var m = all[assetId];
      return (m && typeof m === 'object') ? { all: all, map: m } : null;
    }
    /* 只存「读得回来」的层：没有资产 id 的层（网页版上传、磁盘没落住）下次必丢，
     * 那就别写进配置——写了只会让人以为配过、下次又没了。 */
    function layerRec(l) {
      var o = {
        id: String(l.id), name: String(l.name || ''), flipY: !!l.flipY,
        opacity: clampNum(l.opacity, 0, 1), blend: l.blend || 'normal'
      };
      if (l.mask && l.mask.id) {
        o.mask = {
          id: String(l.mask.id), name: String(l.mask.name || ''),
          flipY: !!l.mask.flipY, invert: !!l.mask.invert,
          /* 手绘遮罩：下次重画时可以原地覆盖同一张资产，不越画越多 */
          painted: !!l.mask.painted
        };
        /* UV 岛分组是编辑用的辅助信息，不决定遮罩长什么样；
         * 记在遮罩配置里，下次接着画时组还在，不用重建。 */
        if (l.mask.groups && l.mask.groups.length) {
          o.mask.groups = l.mask.groups.map(function (g) {
            return { name: String((g && g.name) || ''), ids: ((g && g.ids) || []).map(Number) };
          });
        }
      }
      return o;
    }
    function persistSlot(slot) {
      if (!assetId) return;
      var all = readTexCfg();
      var m = (all[assetId] && typeof all[assetId] === 'object') ? all[assetId] : {};
      var ls = [], arr = slot.layers || [];
      for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id) ls.push(layerRec(arr[i]));
      var k = slotKey(slot);
      /* v3 只多一件事：槽可以有一张「烘焙后的基础贴图」。
       * 它替掉模型自带的图，所以哪怕图层是空的也要留记录——
       * v2 的「没层就删」会把烘焙结果一起删掉，下次打开又回到原始贴图。 */
      var baked = (slot.__baked && slot.__baked.id) ? slot.__baked : null;
      if (baked) {
        m[k] = { v: 3, layers: ls, baked: {
          id: String(baked.id), name: String(baked.name || ''), flipY: baked.flipY !== false
        } };
      } else if (ls.length) m[k] = { v: 2, layers: ls };
      else delete m[k];
      if (Object.keys(m).length) all[assetId] = m;
      else delete all[assetId];
      writeTexCfg(all);
    }
    /* 图片（贴图 / 遮罩）先进资产库换 id：配置里只记 id，
     * 图本身跟模型一样由资产库管着，删掉图库里那张就等于删这一层。 */
    async function putImageAsset(dataURL, name, source) {
      var d = window.openagiDesktop;
      if (!(d && typeof d.assetPut === 'function')) return '';
      try {
        var res = await d.assetPut({
          kind: 'image', name: name || (baseName + '-贴图'), data: dataURL, source: source || '模型贴图'
        });
        var a = res && res.ok && res.asset;
        return (a && a.id) ? String(a.id) : '';
      } catch (e) { return ''; }
    }
    async function readAssetImage(id) {
      var d = window.openagiDesktop;
      if (!(d && typeof d.assetRead === 'function')) throw new Error('网页版没有资产库');
      var r = await d.assetRead(id);
      if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
      return await loadImg(r.dataURL);
    }

    /* ---------------- 基础层 ----------------
     * 每个槽的「基础层」= 模型文件自带的贴图（GLB 内嵌的 baseColor）。混合结果永远盖在它上面，
     * 「清除」= 回到它。必须在任何一次写入之前抓一份，否则 mat.map 换成合成图后原图再也找不回来。 */
    function ensureBase(slot) {
      if (slot.__baseReady) return;
      slot.__baseReady = true;
      if (!slot.layers) slot.layers = [];
      if (!('baseTex' in slot)) slot.baseTex = slot.mat.map || null;
    }
    function conventionFlipY(slot) {
      if (slot.baseTex && typeof slot.baseTex.flipY === 'boolean') return slot.baseTex.flipY;
      return model.format === 'obj';
    }

    /* ---------------- 合成 ----------------
     * 为什么不在着色器里混：GLB 导出只认 mat.map 这一张图。用 onBeforeCompile 混出来的
     * 只有视口里好看，导出后是空的——「所见即所得」就断了。
     * 所以这里把每层按「比例 + 遮罩 + 混合模式」烘进一张 canvas，再当贴图用：
     * 视口、缩略图、GLB 内嵌图三处永远是同一张，不存在「预览对了导出不对」。 */
    function mixSize(slot) {
      var base = slot.baseTex && slot.baseTex.image;
      var W = (base && base.width) ? base.width : 0;
      var H = (base && base.height) ? base.height : 0;
      if (!W || !H) {
        var ls = slot.layers || [];
        for (var i = 0; i < ls.length; i++) {
          var im = ls[i] && ls[i].img;
          if (im && im.width) { W = im.width; H = im.height; break; }
        }
      }
      if (!W || !H) { W = H = 1024; }
      /* 保持长宽比等比压到上限：贴图必须和基础层同一个 UV 比例，改比例会整片拉伸 */
      var sc = Math.min(1, MIX_MAX_SIDE / Math.max(W, H));
      return { w: Math.max(4, Math.round(W * sc)), h: Math.max(4, Math.round(H * sc)) };
    }

    /* 遮罩 → alpha 图。约定「白=显示、黑=隐藏」，跟常见灰度遮罩一致；
     * 透明区域一律算隐藏（白色形状 + 透明底 的 PNG 不会整片糊上去）。
     * 反相只翻灰度、不动透明度——否则透明底会变成整块不透明，层直接消失。
     * 按「尺寸 + 反相 + 是否上下翻」缓存：拖滑杆时每帧都重算像素会卡。 */
    function maskAlpha(rec, w, h, flip) {
      /* 手绘遮罩本身就是「透明底 + 白色笔迹」，等于一张现成的 alpha 图；
       * 尺寸和合成画布一致、又不反相时直接拿去用。拖动笔刷时这就省掉了
       * 每帧对整张 1024/2048 贴图做一次 getImageData 的开销。 */
      if (rec.__direct && !rec.invert && !flip &&
          rec.img && rec.img.width === w && rec.img.height === h) return rec.img;
      if (!rec.__mc) rec.__mc = {};
      var key = w + 'x' + h + (rec.invert ? 'i' : '') + (flip ? 'f' : '');
      if (rec.__mc[key]) return rec.__mc[key];
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var ctx = cv.getContext('2d');
      if (flip) { ctx.translate(0, h); ctx.scale(1, -1); }
      ctx.drawImage(rec.img, 0, 0, w, h);
      var data = ctx.getImageData(0, 0, w, h);
      var px = data.data;
      for (var i = 0; i < px.length; i += 4) {
        var l = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
        if (rec.invert) l = 255 - l;
        px[i + 3] = Math.round(l * px[i + 3] / 255);
      }
      ctx.putImageData(data, 0, 0);
      var keys = Object.keys(rec.__mc);
      if (keys.length > 5) delete rec.__mc[keys[0]];
      rec.__mc[key] = cv;
      return cv;
    }

    function composeSlot(slot) {
      var sz = mixSize(slot);
      var W = sz.w, H = sz.h;
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      /* 没有自带贴图时从白底开始：OBJ 的默认材质就是白色，
       * 用黑底会让「叠一层带透明洞的图」变成黑影，跟直觉相反。 */
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      var base = slot.baseTex && slot.baseTex.image;
      if (base && base.width) ctx.drawImage(base, 0, 0, W, H);

      /* 每层先画到自己那张纸上（顺便让遮罩裁一次），再整体混上去：
       * 直接在主画布上做 destination-in 会把底下的东西一起裁掉。 */
      var tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = H;
      var tctx = tmp.getContext('2d');
      var ls = slot.layers || [];
      for (var i = 0; i < ls.length; i++) {
        var l = ls[i];
        if (!l || !l.img) continue;
        var a = clampNum(l.opacity, 0, 1);
        if (a <= 0) continue;
        tctx.globalCompositeOperation = 'source-over';
        tctx.clearRect(0, 0, W, H);
        tctx.drawImage(l.img, 0, 0, W, H);
        if (l.mask && l.mask.img) {
          tctx.globalCompositeOperation = 'destination-in';
          tctx.drawImage(maskAlpha(l.mask, W, H, false), 0, 0);
          tctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = a;
        ctx.globalCompositeOperation = blendOp(l.blend);
        ctx.drawImage(tmp, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      return cv;
    }

    function applyMix(slot) {
      ensureBase(slot);
      var n = 0, ls = slot.layers || [];
      for (var i = 0; i < ls.length; i++) if (ls[i] && ls[i].img && clampNum(ls[i].opacity, 0, 1) > 0) n++;
      if (!n) {
        if (slot.__mixTex) { slot.__mixTex.dispose(); slot.__mixTex = null; }
        if (slot.mat.map !== slot.baseTex) {
          slot.mat.map = slot.baseTex || null;
          slot.mat.needsUpdate = true;
        }
        return;
      }
      var tex = new THREE.CanvasTexture(composeSlot(slot));
      tex.flipY = conventionFlipY(slot);
      if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      tex.name = (slot.mat.name || 'slot') + '-mix';
      tex.needsUpdate = true;
      var old = slot.__mixTex;
      slot.__mixTex = tex;
      slot.mat.map = tex;
      slot.mat.needsUpdate = true;
      if (old && old !== slot.baseTex) old.dispose();
    }
    /* 拖比例滑杆时每帧都合成会掉帧：合并到一帧一次，留最后一次的值就够 */
    function scheduleMix(slot) {
      if (slot.__mixRaf) return;
      slot.__mixRaf = requestAnimationFrame(function () {
        slot.__mixRaf = 0;
        applyMix(slot);
      });
    }

    function resetMix(slot) {
      if (painting) stopPaint(false);
      ensureBase(slot);
      slot.layers = [];
      if (slot.__mixRaf) { cancelAnimationFrame(slot.__mixRaf); slot.__mixRaf = 0; }
      applyMix(slot);
      persistSlot(slot);
      refreshList();
      if (mixerAlive) renderMix();
    }

    /* ---------------- 烘焙 ----------------
     * 把「基础贴图 + 所有混合层」压成一张 PNG 落进图库，并升格为该槽的新基础贴图，
     * 图层清空。之后模型只认这一张图：不用每次打开都重新合成 8 层，
     * 导出的 GLB 也小一号（原来内嵌的是基础图，图层只是视口里的合成）。
     * 反过来，烘焙之后再叠图层仍然有效——合成永远从 baseTex 起算。
     * 没有桌面桥（网页版）时资产库落不了盘：改为下载 PNG，本次会话内照样生效。 */
    async function bakeSlot(slot, btn) {
      if (!slot) return;
      var ls = slot.layers || [], n = 0;
      for (var i = 0; i < ls.length; i++) if (ls[i] && ls[i].img && clampNum(ls[i].opacity, 0, 1) > 0) n++;
      if (!n) { hint.textContent = '还没有混合层，当前就是基础贴图，无需烘焙'; return; }
      if (painting) stopPaint(false);

      var old = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '烘焙中…'; }
      hint.style.color = '';
      hint.textContent = '正在烘焙…';
      try {
        ensureBase(slot);
        /* flipY 必须沿用原基础图的约定（glTF 不翻 / OBJ 翻），否则烘焙后贴图上下颠倒 */
        var flip = conventionFlipY(slot);
        var cv = composeSlot(slot);
        var url = cv.toDataURL('image/png');
        var safe = String(slot.mat && slot.mat.name || '材质').replace(/[\\/:*?"<>|]/g, '_');
        var fileName = baseName + '_' + safe + '_烘焙.png';
        var id = await putImageAsset(url, fileName, '纹理烘焙');

        var tex = new THREE.CanvasTexture(cv);
        tex.flipY = flip;
        if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 4;
        tex.name = (slot.mat.name || 'slot') + '-baked';
        tex.needsUpdate = true;

        /* 原来的图是模型自带的（可能被别的槽共用），不 dispose；
         * 合成出来的临时贴图是本槽私有的，要还回去。 */
        if (slot.__mixTex) { slot.__mixTex.dispose(); slot.__mixTex = null; }
        slot.baseTex = tex;
        slot.__baked = { id: id || '', name: fileName, flipY: flip };
        slot.layers = [];
        slot.mat.map = tex;
        slot.mat.needsUpdate = true;

        persistSlot(slot);
        refreshList();
        if (mixerAlive) renderMix();

        if (id) {
          hint.textContent = '已烘焙成「' + fileName + '」存入图库，并设为本材质的基础贴图';
        } else {
          downloadDataURL(fileName, url);
          hint.textContent = '浏览器里存不进图库，已下载「' + fileName + '」，本次会话内生效';
        }
      } catch (e) {
        hint.style.color = '#e05252';
        hint.textContent = '烘焙失败：' + ((e && e.message) || e);
      } finally {
        if (btn) { btn.textContent = old; }
        /* 烘焙成功后图层已经清空，按钮该回到置灰态；renderMix 里那次同步会被这里覆盖，所以再同步一次 */
        syncBakeBtn(slot);
      }
    }
    /* 按钮态跟着「有没有有效图层」走：没层时烘焙的结果就是基础贴图本身，没意义还费时间 */
    function syncBakeBtn(slot) {
      if (!bakeBtn) return;
      var ls = (slot && slot.layers) || [], can = false;
      for (var i = 0; i < ls.length; i++) {
        if (ls[i] && ls[i].img && clampNum(ls[i].opacity, 0, 1) > 0) { can = true; break; }
      }
      bakeBtn.disabled = !can;
      bakeBtn.style.opacity = can ? '1' : '.45';
      bakeBtn.style.cursor = can ? 'pointer' : 'not-allowed';
    }

    /* 打开模型时把上次的混合层贴回去。资产被删掉的那层直接丢，并改写配置，
     * 否则每次打开都白读一次、还看不出少了一层。 */
    async function restoreTextures() {
      var cfg = slotCfg();
      var slots = collectSlots();
      for (var b = 0; b < slots.length; b++) ensureBase(slots[b]);
      if (!cfg) { refreshList(); return; }
      var d = window.openagiDesktop;
      if (!(d && typeof d.assetRead === 'function')) { refreshList(); return; }
      var dirty = false, restored = 0;
      for (var i = 0; i < slots.length; i++) {
        var slot = slots[i];
        var rec = cfg.map[slotKey(slot)];
        if (!rec) continue;
        /* 烘焙图先接管基础层，后面的图层再叠在它上面（和烘焙前的观感一模一样） */
        if (rec.baked && rec.baked.id) {
          try {
            var bimg = await readAssetImage(rec.baked.id);
            var btex = new THREE.CanvasTexture(bimg);
            btex.flipY = rec.baked.flipY !== false;
            if (THREE.sRGBEncoding !== undefined) btex.encoding = THREE.sRGBEncoding;
            btex.wrapS = btex.wrapT = THREE.RepeatWrapping;
            btex.anisotropy = 4;
            btex.name = (slot.mat.name || 'slot') + '-baked';
            btex.needsUpdate = true;
            slot.baseTex = btex;
            slot.__baked = { id: String(rec.baked.id), name: rec.baked.name || '', flipY: btex.flipY };
          } catch (e) { dirty = true; }
        }
        var recs = rec.layers ? rec.layers : (rec.id ? [rec] : []);
        var kept = [];
        for (var j = 0; j < recs.length; j++) {
          var L = recs[j];
          if (!L || !L.id) continue;
          try {
            var img = await readAssetImage(L.id);
            var layer = {
              id: String(L.id), name: L.name || '', flipY: L.flipY !== false, img: img,
              opacity: (L.opacity == null ? 1 : clampNum(L.opacity, 0, 1)),
              blend: L.blend || 'normal', mask: null
            };
            if (L.mask && L.mask.id) {
              try {
                layer.mask = {
                  id: String(L.mask.id), name: L.mask.name || '',
                  flipY: L.mask.flipY !== false, invert: !!L.mask.invert,
                  painted: !!L.mask.painted,
                  groups: Array.isArray(L.mask.groups) ? L.mask.groups.map(function (g, gi) {
                    return {
                      name: String((g && g.name) || ('组 ' + (gi + 1))),
                      ids: ((g && g.ids) || []).map(Number)
                    };
                  }) : [],
                  img: await readAssetImage(L.mask.id)
                };
              } catch (e2) { dirty = true; }
            }
            kept.push(layer);
          } catch (e) { dirty = true; }
        }
        if (kept.length !== recs.length) dirty = true;
        slot.layers = kept;
        if (kept.length) { applyMix(slot); restored++; }
      }
      if (dirty) for (var k = 0; k < slots.length; k++) persistSlot(slots[k]);
      if (restored) refreshList();
      refreshList();
    }

    /* 材质槽收集：按材质 uuid 去重，记录共用它的 mesh（取名 / 展示用）。
     *
     * ⚠ 包装对象必须**按 uuid 复用**（slotCache）：混合层、基础贴图这些状态挂在包装对象上，
     *   每次新建一个的话，下一次 refreshList 就全丢——症状是「配置里明明有 2 层，面板显示无贴图」。
     *   meshes 每次重算（材质被换到别的网格上时不能留旧引用）。 */
    var slotCache = {};
    function collectSlots() {
      var slots = [], seen = {};
      model.root.traverse(function (o) {
        if (!o.isMesh || !o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
        var mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
        mats.forEach(function (m) {
          if (!m) return;
          var s = seen[m.uuid];
          if (!s) {
            s = seen[m.uuid] = slotCache[m.uuid] || (slotCache[m.uuid] = { mat: m, meshes: [] });
            s.mat = m;
            s.meshes = [];
            slots.push(s);
          }
          s.meshes.push(o);
        });
      });
      return slots;
    }

    function slotName(slot, i) {
      var mesh = slot.meshes[0] && slot.meshes[0].name;
      /* glTF 导入器会把节点名写成 TEMPORARY_IMPORT_NAMESPACE_xxx_obj1:inputSurface，
       * 摆到面板上就是一串看不懂的乱码（中文还会变方块）。这种情况退回材质名。 */
      var n = (mesh && !/^TEMPORARY_IMPORT_NAMESPACE_/i.test(mesh)) ? mesh : slot.mat.name;
      return n || mesh || ('插槽 ' + (i + 1));
    }
    /* 混合面板标题旁边显示「在改哪个材质」：和列表同一套取名规则 */
    function slotLabel(slot) {
      return slotName(slot, 0) || '当前材质';
    }

    /* 槽的贴图缩略图：没有贴图返回 null。glTF 贴图 flipY=false，缩略图要翻回来才不颠倒 */
    function thumbOfTex(tex, size) {
      var img = tex && tex.image;
      if (!img || !img.width) return null;
      var c = document.createElement('canvas');
      c.width = c.height = size;
      var ctx = c.getContext('2d');
      if (tex.flipY === false) {
        ctx.translate(0, size); ctx.scale(1, -1);
      }
      ctx.drawImage(img, 0, 0, size, size);
      return c;
    }
    function thumbOf(slot, size) { return thumbOfTex(slot.mat.map, size); }

    /* 单层的缩略图：连遮罩一起画（已经抠掉的部分直接不显示），一眼看出这层到底盖在哪里 */
    function layerThumb(l, size) {
      if (!l || !l.img) return null;
      var c = document.createElement('canvas');
      c.width = c.height = size;
      var ctx = c.getContext('2d');
      var flip = l.flipY === false;
      if (flip) { ctx.translate(0, size); ctx.scale(1, -1); }
      ctx.drawImage(l.img, 0, 0, size, size);
      if (l.mask && l.mask.img) {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(maskAlpha(l.mask, size, size, flip), 0, 0);
      }
      return c;
    }

    function metaText(slot) {
      var matType = (slot.mat.type || 'Material')
        .replace('MeshStandardMaterial', 'PBR').replace('MeshPhongMaterial', 'Phong').replace('MeshBasicMaterial', 'Basic');
      var ls = slot.layers || [], masks = 0;
      for (var i = 0; i < ls.length; i++) if (ls[i].mask && ls[i].mask.id) masks++;
      var state = ls.length
        ? (ls.length + ' 层混合' + (masks ? ' · ' + masks + ' 个遮罩' : ''))
        : (slot.__baked ? '烘焙贴图' : (slot.baseTex ? '自带贴图' : '无贴图'));
      return matType + ' · ' + slot.meshes.length + ' 个网格 · ' + state;
    }

    function refreshList() {
      if (!listEl) return;
      listEl.innerHTML = '';
      var slots = collectSlots();
      if (!slots.length) {
        var empty = document.createElement('div');
        empty.style.cssText = 'color:#8b90a0;font-size:12px;line-height:1.6;';
        empty.textContent = '模型里没有材质（纯几何）——OBJ 模型常见。仍可导出 GLB，但没地方贴图。';
        listEl.appendChild(empty);
        return;
      }
      slots.forEach(function (slot, i) {
        ensureBase(slot);
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;background:#171a21;border:1px solid #23262e;border-radius:10px;padding:10px;';

        var th = thumbOf(slot, 52);
        var box = document.createElement('div');
        box.style.cssText = 'flex:0 0 52px;height:52px;border-radius:8px;background:#0a0b0e;border:1px solid #23262e;overflow:hidden;display:flex;align-items:center;justify-content:center;';
        if (th) box.appendChild(th);
        else {
          var no = document.createElement('span');
          no.textContent = '无';
          no.style.cssText = 'color:#5a5f70;font-size:11px;';
          box.appendChild(no);
        }
        row.appendChild(box);

        var info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;';
        var nm = document.createElement('div');
        nm.textContent = slotName(slot, i);
        nm.title = nm.textContent;
        nm.style.cssText = 'color:#e8eaf0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        var meta = document.createElement('div');
        meta.textContent = metaText(slot);
        meta.style.cssText = 'color:#8b90a0;font-size:11px;';
        info.appendChild(nm); info.appendChild(meta);

        var btns = document.createElement('div');
        btns.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
        btns.appendChild(mkBtn('纹理混合', function () { openMixer(slot); }));
        if ((slot.layers || []).length) {
          btns.appendChild(mkBtn('清除', function () { resetMix(slot); }));
        }
        info.appendChild(btns);
        row.appendChild(info);
        listEl.appendChild(row);
      });
    }

    function ensurePanel() {
      if (panel) { panel.style.display = 'flex'; refreshList(); return panel; }
      panel = document.createElement('div');
      panel.setAttribute('data-slot-panel', '1');
      /* 有前端 dock（预览器右侧那一条）时不再自己定位 / 自己画边框：
       * 位置、宽度、阴影都归 dock，这里只负责内容。没有 dock 的旧调用退回自己的抽屉。 */
      panel.style.cssText = deps.dock
        ? 'position:static;flex:1;min-height:0;width:auto;background:transparent;display:flex;flex-direction:column;'
        /* 380：混合层一行要放「缩略图 + 名字 + 三个小按钮」，340 会挤成两行放不下 */
        : 'position:absolute;top:0;right:0;bottom:0;width:380px;max-width:86%;background:rgba(13,15,20,.97);border-left:1px solid #23262e;display:flex;flex-direction:column;z-index:5;';

      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #23262e;flex:0 0 auto;';
      var t = document.createElement('div');
      t.textContent = '材质插槽';
      t.style.cssText = 'font-weight:600;flex:1;min-width:0;color:#e8eaf0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      var x = document.createElement('button');
      x.textContent = '×';
      x.title = '收起面板';
      x.style.cssText = 'border:0;background:transparent;color:#8b90a0;font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;flex:0 0 auto;';
      x.onclick = closeSlotPanel;
      head.appendChild(t); head.appendChild(x);

      listEl = document.createElement('div');
      listEl.style.cssText = 'flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;min-height:0;';

      var foot = document.createElement('div');
      foot.style.cssText = 'flex:0 0 auto;padding:10px 12px;border-top:1px solid #23262e;display:flex;gap:8px;flex-wrap:wrap;';
      var saveBtn = mkBtn('导出 GLB 存入模型库', function () { saveGLB(saveBtn); });
      var dlBtn = mkBtn('下载 GLB', function () { downloadGLB(dlBtn); });
      foot.appendChild(saveBtn); foot.appendChild(dlBtn);
      var tip = document.createElement('div');
      tip.textContent = 'GLB 内嵌合成后的贴图，导出后双击打开就是混合好的状态';
      tip.style.cssText = 'color:#8b90a0;font-size:11px;flex-basis:100%;';
      foot.appendChild(tip);

      panel.appendChild(head); panel.appendChild(listEl); panel.appendChild(foot);
      (deps.dock || stage).appendChild(panel);
      refreshList();
      return panel;
    }

    /* 收面板的唯一出口：× 按钮 / 打开 UV / 打开参考图 都走这里，
     * 免得「关了一半忘了通知 dock」把右边那条留在屏幕上。 */
    function closeSlotPanel() {
      /* 滑杆只松手才写盘；收抽屉前补一次，免得「拖到一半点别处」把最后一格丢了 */
      if (mixerSlot) persistSlot(mixerSlot);
      closePicker(); closeMixer();
      if (panel) panel.style.display = 'none';
      if (typeof deps.onPanelClose === 'function') deps.onPanelClose();
    }

    /* 本机文件选择（input 复用，选同一个文件也能再触发 onchange） */
    function ensureFileInput() {
      if (fileInput) return fileInput;
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/png,image/jpeg,image/webp';
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
      return fileInput;
    }

    function loadImg(src) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () { res(img); };
        img.onerror = function () { rej(new Error('贴图图片解码失败')); };
        img.src = src;
      });
    }

    /* ---------------- 贴图选择器（面板内二级层） ----------------
     * 贴图和遮罩走同一个选择器：只有标题和数据落点不同。
     * onPick 收到 { dataURL, name, texId? }；texId 只有「从图库选」才有（图已经在资产库里了）。
     * opts.multi —— 允许一次选多张（加图层时用，遮罩只认一张）。 */
    function closePicker() {
      pickerAlive = false;
      if (picker && picker.parentNode) picker.parentNode.removeChild(picker);
      picker = null;
    }

    function openPicker(title, onPick, opts) {
      opts = opts || {};
      /* 选图会离开「在模型上画」的状态：先把画了一半的存下来 */
      if (painting) stopPaint(true);
      closePicker();
      pickerAlive = true;
      picker = document.createElement('div');
      picker.style.cssText = 'position:absolute;inset:0;background:rgba(13,15,20,.98);z-index:7;display:flex;flex-direction:column;';

      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #23262e;flex:0 0 auto;';
      var t = document.createElement('div');
      t.textContent = title || '选择图片';
      t.style.cssText = 'font-weight:600;flex:1;color:#e8eaf0;font-size:13px;';
      var cancelB = document.createElement('button');
      cancelB.textContent = '取消';
      cancelB.style.cssText = 'padding:5px 10px;border-radius:8px;border:1px solid #2c303a;background:#191c22;color:#e8eaf0;cursor:pointer;font-size:12px;';
      cancelB.onclick = closePicker;
      head.appendChild(t); head.appendChild(cancelB);

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'padding:10px 12px;display:flex;gap:8px;flex:0 0 auto;';
      var upBtn = mkBtn('本机文件…', function () {
        var fi = ensureFileInput();
        fi.multiple = !!opts.multi;
        fi.onchange = function () {
          var files = Array.prototype.slice.call(fi.files || []);
          if (!files.length) return;
          if (!opts.multi) files = files.slice(0, 1);
          var reads = files.map(function (f) {
            return new Promise(function (res) {
              var rd = new FileReader();
              rd.onload = function () { res(rd.result); };
              rd.onerror = function () { res(''); };
              rd.readAsDataURL(f);
            });
          });
          Promise.all(reads).then(async function (urls) {
            closePicker();
            /* 多张按选择顺序逐层往上叠：后选的盖在前选的上面，跟列表顺序一致 */
            for (var i = 0; i < files.length; i++) {
              if (!urls[i]) continue;
              try { await onPick({ dataURL: urls[i], name: files[i].name }); }
              catch (e) { hint.textContent = '贴图失败：' + ((e && e.message) || e); }
            }
          });
          fi.value = '';
        };
        fi.click();
      });
      var libBtn = mkBtn('从图库选择', function () { showGallery(); });
      btnRow.appendChild(upBtn); btnRow.appendChild(libBtn);

      var body = document.createElement('div');
      body.style.cssText = 'flex:1;overflow-y:auto;padding:0 12px 12px;min-height:0;';

      picker.appendChild(head); picker.appendChild(btnRow); picker.appendChild(body);
      panel.appendChild(picker);

      function showGallery() {
        upBtn.disabled = libBtn.disabled = true;
        body.innerHTML = '';
        var d = window.openagiDesktop;
        if (!(d && typeof d.assetList === 'function')) {
          body.textContent = '网页版没有资产库，用「本机文件」上传贴图';
          body.style.cssText += 'color:#8b90a0;font-size:12px;padding:12px;';
          return;
        }
        body.textContent = '读取图库…';
        d.assetList().then(function (l) {
          if (!pickerAlive) return;
          var imgs = (l.assets || []).filter(function (a) { return a.kind === 'image' && !a.missing; });
          if (!imgs.length) {
            body.textContent = '图库里还没有图片';
            body.style.cssText += 'color:#8b90a0;font-size:12px;padding:12px;';
            return;
          }
          body.innerHTML = '';
          body.style.cssText += 'display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px;align-content:start;';
          /* 缩略图逐张补：assetRead 拉的是整图，一次全拉会把内存打爆。
           * 先摆名字卡片占位，再按顺序读、谁先到谁先显示；关掉面板就停。 */
          imgs.slice(0, 120).forEach(function (a) {
            var card = document.createElement('div');
            card.title = a.name;
            card.style.cssText = 'aspect-ratio:1;border-radius:8px;background:#171a21;border:1px solid #23262e;overflow:hidden;cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;';
            var label = document.createElement('span');
            label.textContent = String(a.ext || '').toUpperCase() || '?';
            label.style.cssText = 'color:#5a5f70;font-size:10px;';
            card.appendChild(label);
            card.onclick = function () {
              d.assetRead(a.id).then(function (r) {
                if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
                closePicker();
                return onPick({ dataURL: r.dataURL, name: a.name, texId: a.id });
              }).catch(function () {
                label.textContent = '失败';
                label.style.color = '#e05252';
              });
            };
            body.appendChild(card);
            d.assetRead(a.id).then(function (r) {
              if (!pickerAlive || !r || !r.ok) return;
              var img = document.createElement('img');
              img.src = r.dataURL;
              img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
              card.innerHTML = '';
              card.appendChild(img);
            }).catch(function () { });
          });
          var more = imgs.length - 120;
          if (more > 0) {
            var note = document.createElement('div');
            note.textContent = '还有 ' + more + ' 张未显示（搜索/整理请去图库 App）';
            note.style.cssText = 'grid-column:1/-1;color:#8b90a0;font-size:11px;padding:4px;';
            body.appendChild(note);
          }
        }).catch(function (e) {
          if (pickerAlive) body.textContent = '读取图库失败：' + ((e && e.message) || e);
        });
      }
    }

    /* ---------------- 添加图层 / 设置遮罩 ---------------- */
    async function addLayer(slot, pick) {
      ensureBase(slot);
      if ((slot.layers || []).length >= MIX_LIMIT) {
        hint.textContent = '一个插槽最多 ' + MIX_LIMIT + ' 层';
        return;
      }
      var img;
      try { img = await loadImg(pick.dataURL); }
      catch (e) { hint.textContent = '贴图失败：' + ((e && e.message) || e); return; }
      var id = pick.texId ? String(pick.texId) : await putImageAsset(pick.dataURL, pick.name);
      var layer = {
        id: id, name: pick.name || '贴图', flipY: conventionFlipY(slot), img: img,
        opacity: 1, blend: 'normal', mask: null
      };
      slot.layers.push(layer);
      applyMix(slot);
      persistSlot(slot);
      refreshList();
      if (mixerAlive) renderMix();
      hint.textContent = '已叠加「' + layer.name + '」' + (id ? '' : '（网页版：本次会话内有效）');
    }

    async function setMask(layer, pick) {
      var img;
      try { img = await loadImg(pick.dataURL); }
      catch (e) { hint.textContent = '遮罩失败：' + ((e && e.message) || e); return; }
      var id = pick.texId ? String(pick.texId) : await putImageAsset(pick.dataURL, pick.name || '遮罩');
      layer.mask = { id: id, name: pick.name || '遮罩', flipY: layer.flipY, invert: false, img: img };
      if (mixerSlot) applyMix(mixerSlot);
      if (mixerSlot) persistSlot(mixerSlot);
      refreshList();
      if (mixerAlive) renderMix();
      hint.textContent = '遮罩已设置：白色显示、黑色隐藏';
    }

    /* ---------------- 手绘遮罩 ----------------
     * 直接在模型上画：鼠标位置 → 射线打当前材质所在的网格 → 交点 UV → 笔刷盖到遮罩画布。
     *
     * 三个关键约定：
     *   ① 画布是「透明底 + 白色笔迹」。maskAlpha 本来就把透明当隐藏，所以这张画布
     *      直接就是一张 alpha 遮罩，不用再算一遍灰度（见 maskAlpha 里的 __direct 快路径）。
     *   ② layer.mask.img 在绘制期间直接指向这张画布：每帧重合成，视口里立刻见效果。
     *   ③ UV → 画布要跟着贴图的翻转约定走（OBJ flipY=true / glTF false），
     *      否则会出现「画在正面、显示在背面」的上下颠倒。
     */
    var painting = null;
    var paintEl = null;

    function slotHasUv(slot) {
      var ms = slot.meshes || [];
      for (var i = 0; i < ms.length; i++) {
        var g = ms[i] && ms[i].geometry;
        if (g && g.attributes && g.attributes.uv) return true;
      }
      return false;
    }

    /* 分组配置深拷贝：取消绘制时要回到 prev，不能把改过的组一起带回去 */
    function copyGroups(src) {
      var out = [], gs = src && src.groups;
      if (!gs || !gs.length) return out;
      for (var i = 0; i < gs.length; i++) {
        out.push({
          name: String((gs[i] && gs[i].name) || ('组 ' + (i + 1))),
          ids: ((gs[i] && gs[i].ids) || []).map(Number)
        });
      }
      return out;
    }

    function stopPaint(commit) {
      var st = painting;
      if (!st) return;
      painting = null;
      canvas.removeEventListener('pointerdown', st.fnDown, true);
      canvas.removeEventListener('pointermove', st.fnMove);
      window.removeEventListener('pointerup', st.fnUp);
      canvas.style.cursor = '';
      if (controls) controls.enabled = st.ctrlWas;
      if (paintEl && paintEl.parentNode) paintEl.parentNode.removeChild(paintEl);
      paintEl = null;
      /* 混合面板是整屏铺的、插槽面板占右侧 380：绘制时先收起来，
       * 否则画布被盖住，点在模型上根本收不到事件 */
      if (mixer) mixer.style.display = '';
      panel.style.display = '';

      if (!commit) {
        st.layer.mask = st.prev;
        applyMix(st.slot);
        refreshList();
        if (mixerAlive) renderMix();
        hint.textContent = '已取消，遮罩回到绘制前';
        return;
      }
      applyMix(st.slot);
      refreshList();
      if (mixerAlive) renderMix();
      savePainted(st);
    }

    /* 画布先留在 layer.mask 上（视口不用闪一下），资产入库异步做 */
    async function savePainted(st) {
      var live = st.live, cv = st.cv;
      var id = '';
      var d = window.openagiDesktop;
      if (d && typeof d.assetPut === 'function') {
        try {
          var r = await d.assetPut({
            /* 上次也是手绘的就原地覆盖，不越画越多一张资产 */
            id: st.reuseId || undefined,
            kind: 'image', name: baseName + '-手绘遮罩',
            data: cv.toDataURL('image/png'), source: '模型贴图'
          });
          if (r && r.ok && r.asset && r.asset.id) id = String(r.asset.id);
        } catch (e) { }
      }
      /* 期间层可能被删 / 被换掉：只在还是同一张遮罩时才回写 */
      if (st.layer.mask !== live) return;
      live.id = id;
      live.painted = true;
      persistSlot(st.slot);
      refreshList();
      if (mixerAlive) renderMix();
      hint.textContent = id
        ? '手绘遮罩已保存（白色显示、擦除处隐藏）'
        : '遮罩已画好（网页版：本次会话内有效）';
    }

    function startPaint(layer) {
      var slot = mixerSlot;
      if (!slot || !layer) return;
      /* 换层继续画：先把上一张存下来，别让「没点完成」变成白画 */
      if (painting) stopPaint(true);
      if (!slotHasUv(slot)) {
        hint.textContent = '这个材质所在的网格没有 UV，没法在模型上画遮罩（先用建模软件展开 UV）';
        return;
      }
      if (!global.THREE || !camera || !canvas) {
        hint.textContent = '视口还没准备好，稍后再试';
        return;
      }
      closePicker();
      if (typeof deps.onEditStart === 'function') deps.onEditStart();

      var sz = mixSize(slot);
      var W = sz.w, H = sz.h;
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      var prev = layer.mask || null;
      /* 和贴图同一个翻转约定：OBJ 是 flipY=true，glTF 是 false */
      var flip = layer.flipY !== false;
      if (prev && prev.img) {
        /* 已有遮罩当底稿：透明处继续隐藏，方便在原有基础上补画 */
        try { ctx.drawImage(prev.img, 0, 0, W, H); } catch (e) { }
      }
      var live = {
        id: prev && prev.id ? prev.id : '',
        name: '手绘遮罩', flipY: layer.flipY,
        invert: prev ? !!prev.invert : false,
        img: cv, __direct: true, painted: true
      };
      layer.mask = live;
      applyMix(slot);

      var THREEx = global.THREE;
      var ray = new THREEx.Raycaster();
      var ndc = new THREEx.Vector2();
      var st = {
        layer: layer, slot: slot, cv: cv, ctx: ctx, W: W, H: H, flip: flip, prev: prev,
        reuseId: (prev && prev.painted && prev.id) ? String(prev.id) : '',
        live: live, size: Math.max(6, Math.round(Math.min(W, H) * 0.06)),
        /* paint=笔刷显示 / erase=擦除 / add=拾取 UV 岛加入 / sub=拾取 UV 岛去掉 */
        mode: 'paint', down: false, lastOk: false, lastX: 0, lastY: 0, lastIsland: -1,
        pointerId: null, ctrlWas: controls ? controls.enabled : true,
        a: null, meshList: null, triOff: null,
        /* 岛分组：只影响编辑手感，不决定遮罩像素；随遮罩配置一起存 */
        groups: [],
        /* 每岛遮罩状态 on / off / partial，由遮罩图像素采样得出（左栏大纲的眼睛用） */
        states: [], areaTotal: 0
      };
      st.groups = copyGroups(prev);
      /* live.groups 直接挂着同一份数组：分组改动不需要额外同步就能被 persistSlot 写走 */
      live.groups = st.groups;
      painting = st;
      if (controls) controls.enabled = false;
      canvas.style.cursor = 'crosshair';

      function uvPx(uv) {
        /* UV 可以超出 0–1（贴图重复），先折回一格，笔刷才落在对应的平铺上 */
        var u = uv.x - Math.floor(uv.x);
        var v = uv.y - Math.floor(uv.y);
        return { x: u * st.W, y: (st.flip ? (1 - v) : v) * st.H };
      }

      function hitAt(e) {
        var r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1,
                -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        /* 只打这个材质所在的网格：在别的插槽上画遮罩没有意义 */
        var hits = ray.intersectObjects(slot.meshes || [], false);
        for (var i = 0; i < hits.length; i++) if (hits[i].uv) return hits[i];
        return null;
      }

      function hitPx(e) {
        var hit = hitAt(e);
        return hit ? uvPx(hit.uv) : null;
      }

      /* UV 岛数据只算一次。analyzeRoot 的 parts 顺序 = root 里网格的遍历顺序，
       * 所以射线命中的 mesh 在那个顺序里的下标，就是 part 下标。 */
      function islandData() {
        if (st.a) return st.a;
        if (!window.ModelTex || typeof ModelTex.analyzeRoot !== 'function') {
          hint.textContent = 'UV 岛功能不可用（缺少 modeltex.js）';
          return null;
        }
        model.root.updateMatrixWorld(true);
        var a;
        try { a = ModelTex.analyzeRoot(model.root); }
        catch (e) { hint.textContent = 'UV 岛分析失败：' + ((e && e.message) || e); return null; }
        var ms = [];
        model.root.traverse(function (o) {
          if (o.isMesh && o.geometry && o.geometry.attributes.position) ms.push(o);
        });
        if (ms.length !== a.parts.length) {
          hint.textContent = 'UV 岛数据对不上网格，没法拾取';
          return null;
        }
        st.a = a; st.meshList = ms;
        st.triOff = [];
        var off = 0;
        for (var i = 0; i < a.parts.length; i++) { st.triOff.push(off); off += a.parts[i].tri; }
        return a;
      }

      /* 把一个 UV 岛的所有三角形按 UV 铺到遮罩画布上：＋= 白色盖上去，－= 擦掉。
       * 一次 fill 画完所有三角形，岛再碎也只付一次光栅化。 */
      function fillIsland(id, add) {
        var a = st.a;
        var isl = a && a.islands[id];
        if (!isl) return false;
        ctx.globalCompositeOperation = add ? 'source-over' : 'destination-out';
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        for (var i = 0; i < isl.tris.length; i++) {
          var ref = isl.tris[i], part = a.parts[ref.part];
          var ix = part.idx;
          for (var k = 0; k < 3; k++) {
            var vi = ix ? ix.getX(ref.t * 3 + k) : ref.t * 3 + k;
            var x = part.uv.getX(vi) * st.W;
            var y = (st.flip ? (1 - part.uv.getY(vi)) : part.uv.getY(vi)) * st.H;
            if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
        }
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        return true;
      }

      function pickIsland(e, add) {
        var a = islandData();
        if (!a) return;
        var hit = hitAt(e);
        if (!hit) { hint.textContent = '点在模型上才能拾取 UV 岛'; return; }
        var pi = st.meshList.indexOf(hit.object);
        if (pi < 0 || hit.faceIndex == null) { hint.textContent = '没认出点到的是哪个网格'; return; }
        var id = a.triIsland[st.triOff[pi] + hit.faceIndex];
        if (id == null || id < 0) { hint.textContent = '这个三角形不属于任何 UV 岛'; return; }
        if (id === st.lastIsland) return;
        st.lastIsland = id;
        if (!fillIsland(id, add)) return;
        st.states[id] = add ? 'on' : 'off';
        paintEyes();
        scheduleMix(st.slot);
        hint.textContent = (add ? '加入' : '去掉') + ' UV 岛 #' + (id + 1) +
          '（共 ' + a.islands.length + ' 个岛）';
      }

      /* ---------------- 岛状态：从遮罩图采样 ----------------
       * 左栏眼睛要回答「这个岛现在在不在遮罩里」。遮罩画布可能有 2048，
       * 每落一笔都读整张图会卡手，所以先缩到 192×192 再采样——
       * 只需要区分 整岛有 / 没有 / 一半，这个精度够用。
       * 每岛最多采 32 个三角形质心，岛再碎也不拖慢。 */
      var sampCv = null, sampCtx = null;
      function maskSampler() {
        if (!sampCv) {
          sampCv = document.createElement('canvas');
          sampCv.width = sampCv.height = 192;
          sampCtx = sampCv.getContext('2d');
        }
        sampCtx.clearRect(0, 0, 192, 192);
        sampCtx.drawImage(st.cv, 0, 0, 192, 192);
        return { w: 192, h: 192, d: sampCtx.getImageData(0, 0, 192, 192).data };
      }

      function refreshStates() {
        var a = st.a;
        if (!a) return;
        var s = maskSampler();
        var states = [];
        for (var i = 0; i < a.islands.length; i++) {
          var isl = a.islands[i];
          var step = Math.max(1, Math.ceil(isl.tris.length / 32));
          var on = 0, tot = 0;
          for (var j = 0; j < isl.tris.length; j += step) {
            var ref = isl.tris[j], part = a.parts[ref.part], ix = part.idx;
            var su = 0, sv = 0;
            for (var k = 0; k < 3; k++) {
              var vi = ix ? ix.getX(ref.t * 3 + k) : ref.t * 3 + k;
              su += part.uv.getX(vi); sv += part.uv.getY(vi);
            }
            var u = su / 3 - Math.floor(su / 3);
            var v = sv / 3 - Math.floor(sv / 3);
            var px2 = Math.min(s.w - 1, Math.max(0, Math.round(u * s.w)));
            var py2 = Math.min(s.h - 1, Math.max(0, Math.round((st.flip ? 1 - v : v) * s.h)));
            tot++;
            if (s.d[(py2 * s.w + px2) * 4 + 3] > 40) on++;
          }
          states[i] = tot ? (on / tot >= 0.85 ? 'on' : (on / tot <= 0.15 ? 'off' : 'partial')) : 'off';
        }
        st.states = states;
      }

      /* 笔刷带一点软边：遮罩边界不会在 2K 贴图上留下锯齿 */
      function dab(x, y, r) {
        var g = ctx.createRadialGradient(x, y, 0, x, y, r);
        var cc = st.mode === 'erase' ? '0,0,0' : '255,255,255';
        if (st.mode === 'erase') ctx.globalCompositeOperation = 'destination-out';
        else ctx.globalCompositeOperation = 'source-over';
        g.addColorStop(0, 'rgba(' + cc + ',1)');
        g.addColorStop(0.62, 'rgba(' + cc + ',1)');
        g.addColorStop(1, 'rgba(' + cc + ',0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }

      function strokeTo(px) {
        var r = st.size;
        if (!st.lastOk) dab(px.x, px.y, r);
        else {
          var dx = px.x - st.lastX, dy = px.y - st.lastY;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > Math.max(r * 8, 160)) {
            /* UV 缝两侧在贴图上离得很远：插值会把整张图拉出一条长线，所以这里只落一个点 */
            dab(px.x, px.y, r);
          } else {
            var step = Math.max(1, r * 0.3);
            var n = Math.max(1, Math.ceil(dist / step));
            for (var i = 1; i <= n; i++) dab(st.lastX + dx * i / n, st.lastY + dy * i / n, r);
          }
        }
        st.lastX = px.x; st.lastY = px.y; st.lastOk = true;
        scheduleMix(st.slot);
      }

      function onDown(e) {
        if (!painting || e.button !== 0 || e.target !== canvas) return;
        st.down = true; st.lastOk = false; st.lastIsland = -1;
        st.pointerId = e.pointerId;
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
        if (st.mode === 'add' || st.mode === 'sub') {
          pickIsland(e, st.mode === 'add');
          return;
        }
        var px = hitPx(e);
        if (!px) { hint.textContent = '点在模型上才能画遮罩'; return; }
        strokeTo(px);
        hint.textContent = st.mode === 'erase' ? '擦除中：抹掉的地方这一层就隐藏' : '绘制中：涂到的地方这一层显示';
      }
      function onMove(e) {
        if (!painting || !st.down) return;
        if (st.mode === 'add' || st.mode === 'sub') {
          /* 按住拖过多个岛就连续拾取，不用一个个点 */
          pickIsland(e, st.mode === 'add');
          return;
        }
        var px = hitPx(e);
        if (px) strokeTo(px);
      }
      function onUp() {
        if (!painting || !st.down) return;
        st.down = false; st.lastOk = false; st.lastIsland = -1;
        try { canvas.releasePointerCapture(st.pointerId); } catch (err) { }
        st.pointerId = null;
        /* 一笔画完再重算岛状态：眼睛跟着笔画走，描边时不做无谓的采样 */
        if (st.a && (st.mode === 'paint' || st.mode === 'erase')) {
          refreshStates();
          paintEyes();
        }
      }
      st.fnDown = onDown; st.fnMove = onMove; st.fnUp = onUp;
      canvas.addEventListener('pointerdown', onDown, true);
      canvas.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);

      /* ---------------- 左栏：UV 岛大纲 ----------------
       * 一个岛一行，眼睛开关 = 整岛加入 / 移出遮罩（和「岛＋ / 岛－」同一条路）。
       * 点岛名是多选，底部「成组」把选中的岛绑成一组；组头的眼睛整组一起开关。
       * 分组只是编辑辅助：遮罩永远由那张图说了算，组不参与合成。
       * 上千个岛不能整屏铺开（截图里 1177 个）：默认只列 REST_PAGE 个未分组岛，
       * 上方给搜索框 + 筛选片，找不到的岛用编号搜；左栏还能整条收起让出画面。 */
      var REST_PAGE = 80;          // 未分组岛一屏先列多少个，「显示更多」再翻倍
      var restLimit = REST_PAGE;
      var filter = 'all';          // all / on 已加入 / off 未加入 / big 大岛（≥1%）
      var query = '';              // 搜索：岛号（#12）
      var collapsed = false;
      var rowEls = {}, groupEyes = [], selIds = [];
      var outBody = null, outSub = null, footInfo = null, btnMake = null;
      var outEl = null, pillEl = null, chipEls = [], searchEl = null;

      function mkEl(tag, css, text) {
        var e = document.createElement(tag);
        if (css) e.style.cssText = css;
        if (text != null) e.textContent = text;
        return e;
      }
      function btnCss(on) {
        return 'flex:0 0 auto;padding:3px 9px;border-radius:5px;border:1px solid ' +
          (on ? '#a3345e' : '#2c303a') + ';background:' + (on ? '#3a1c28' : '#191c22') +
          ';color:' + (on ? '#ffb3cd' : '#c9cede') + ';cursor:pointer;font-size:11px;line-height:1.5;';
      }

      function inGroup(id) {
        for (var i = 0; i < st.groups.length; i++) {
          if (st.groups[i].ids.indexOf(id) >= 0) return i;
        }
        return -1;
      }
      function areaText(area) {
        if (!st.areaTotal) return '';
        var p = area / st.areaTotal * 100;
        return p >= 9.95 ? p.toFixed(0) + '%' : p.toFixed(1) + '%';
      }
      function setPickMark(id) {
        var r = rowEls[id];
        if (!r) return;
        var on = selIds.indexOf(id) >= 0;
        r.pick.style.background = on ? '#e88a00' : '#0f1116';
        r.pick.style.borderColor = on ? '#e88a00' : '#3a3f4b';
        r.row.style.background = on ? 'rgba(232,138,0,.10)' : '';
      }
      function toggleSel(id) {
        var i = selIds.indexOf(id);
        if (i >= 0) selIds.splice(i, 1); else selIds.push(id);
        setPickMark(id);
        updateFoot();
      }

      /* 眼睛：● 整岛在遮罩里 / ◐ 只进去一部分 / ○ 完全没进 */
      function mkEye(getState, onClick) {
        var b = mkEl('button', 'flex:0 0 auto;width:20px;height:18px;padding:0;border:1px solid #2c303a;' +
          'border-radius:4px;background:#191c22;cursor:pointer;font-size:12px;line-height:16px;' +
          'text-align:center;font-family:system-ui,sans-serif;');
        b.type = 'button';
        var o = {
          el: b,
          paint: function () {
            var s = getState();
            b.textContent = s === 'on' ? '●' : (s === 'partial' ? '◐' : '○');
            b.title = s === 'on' ? '整岛在遮罩里（点一下移出）'
              : (s === 'partial' ? '只进去一部分（点一下整岛加入）' : '不在遮罩里（点一下整岛加入）');
            b.style.color = s === 'on' ? '#ffd75e' : (s === 'partial' ? '#b9a06a' : '#6b7183');
            b.style.borderColor = s === 'on' ? '#a3730e' : '#2c303a';
            b.style.background = s === 'on' ? '#33280d' : '#191c22';
          }
        };
        b.onclick = function (e) { e.stopPropagation(); onClick(); };
        return o;
      }

      function paintEyes() {
        Object.keys(rowEls).forEach(function (k) { rowEls[k].eye.paint(); });
        for (var i = 0; i < groupEyes.length; i++) groupEyes[i].paint();
      }

      function setMaskIsland(id, on) {
        if (!fillIsland(id, on)) return;
        st.states[id] = on ? 'on' : 'off';
        paintEyes();
        scheduleMix(st.slot);
        hint.textContent = 'UV 岛 #' + (id + 1) + (on ? ' 整块加入遮罩' : ' 整块移出遮罩');
      }

      function groupState(gi) {
        var g = st.groups[gi], on = 0, off = 0;
        for (var i = 0; i < g.ids.length; i++) {
          var s = st.states[g.ids[i]] || 'off';
          if (s === 'on') on++; else if (s === 'off') off++;
        }
        if (!g.ids.length || off === g.ids.length) return 'off';
        if (on === g.ids.length) return 'on';
        return 'partial';
      }

      function toggleGroup(gi) {
        var g = st.groups[gi];
        if (!g || !st.a) return;
        var want = groupState(gi) !== 'on';
        for (var i = 0; i < g.ids.length; i++) {
          var id = g.ids[i];
          if (!st.a.islands[id]) continue;
          if (!fillIsland(id, want)) continue;
          st.states[id] = want ? 'on' : 'off';
        }
        paintEyes();
        scheduleMix(st.slot);
        hint.textContent = '组「' + g.name + '」' + (want ? '整组加入遮罩' : '整组移出遮罩');
      }

      function makeGroup() {
        if (!selIds.length) return;
        var ids = selIds.slice();
        /* 先从原组里摘出来，空组自动消失——一个岛只待在一个组里 */
        for (var i = st.groups.length - 1; i >= 0; i--) {
          var g = st.groups[i], keep = [];
          for (var j = 0; j < g.ids.length; j++) if (ids.indexOf(g.ids[j]) < 0) keep.push(g.ids[j]);
          g.ids = keep;
          if (!g.ids.length) st.groups.splice(i, 1);
        }
        st.groups.push({ name: '组 ' + (st.groups.length + 1), ids: ids });
        selIds = [];
        renderOut();
        updateFoot();
        hint.textContent = '已把 ' + ids.length + ' 个岛分成一组，点组头的眼睛可整组开关';
      }

      function islandRow(id, indent) {
        var isl = st.a.islands[id];
        var row = mkEl('div', 'display:flex;align-items:center;gap:5px;padding:2px 5px;margin:1px 0;' +
          'border-radius:5px;cursor:pointer;' + (indent ? 'margin-left:10px;' : ''));
        var pick = mkEl('span', 'flex:0 0 auto;width:11px;height:11px;border-radius:3px;' +
          'border:1px solid #3a3f4b;background:#0f1116;box-sizing:border-box;');
        var eye = mkEye(function () { return st.states[id] || 'off'; }, function () {
          setMaskIsland(id, (st.states[id] || 'off') !== 'on');
        });
        var nm = mkEl('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
          'color:#c9cede;font-size:11.5px;', '#' + (id + 1) + ' · ' + areaText(isl.area));
        nm.title = 'UV 岛 #' + (id + 1) + ' · ' + isl.tris.length + ' 个三角形 · UV 面积占比 ' + areaText(isl.area);
        row.appendChild(pick); row.appendChild(eye.el); row.appendChild(nm);
        row.onclick = function () { toggleSel(id); };
        rowEls[id] = { row: row, pick: pick, eye: eye };
        setPickMark(id);
        return row;
      }

      function groupRow(gi) {
        var g = st.groups[gi];
        var row = mkEl('div', 'display:flex;align-items:center;gap:5px;padding:3px 5px;margin:6px 0 2px;' +
          'border-radius:5px;background:#181c24;border:1px solid #2b303b;');
        var fold = mkEl('button', 'flex:0 0 auto;width:16px;height:16px;padding:0;border:0;background:none;' +
          'color:#8b90a0;cursor:pointer;font-size:11px;line-height:16px;', g.__fold ? '▸' : '▾');
        fold.type = 'button';
        fold.onclick = function () { g.__fold = !g.__fold; renderOut(); };
        var eye = mkEye(function () { return groupState(gi); }, function () { toggleGroup(gi); });
        var nm = document.createElement('input');
        nm.type = 'text';
        nm.value = g.name || ('组 ' + (gi + 1));
        nm.style.cssText = 'flex:1;min-width:0;background:transparent;border:0;outline:0;padding:0;' +
          'color:#e8eaf0;font:600 11.5px/1.4 system-ui,"Microsoft YaHei",sans-serif;';
        nm.title = '点进去可以改名';
        nm.oninput = function () { g.name = nm.value; };
        var cnt = mkEl('span', 'flex:0 0 auto;color:#7d8291;font-size:10.5px;', '(' + g.ids.length + ')');
        var un = mkEl('button', btnCss(false), '散组');
        un.type = 'button';
        un.style.fontSize = '10px';
        un.onclick = function (e) {
          e.stopPropagation();
          st.groups.splice(gi, 1);
          renderOut();
          updateFoot();
          hint.textContent = '已散组，岛回到「未分组」';
        };
        row.appendChild(fold); row.appendChild(eye.el); row.appendChild(nm); row.appendChild(cnt); row.appendChild(un);
        groupEyes.push(eye);
        return row;
      }

      /* 筛选 / 搜索的判定：先看状态，再看是否大岛，最后按岛号匹配 */
      function islandPass(id) {
        var s = st.states[id] || 'off';
        if (filter === 'on' && s === 'off') return false;
        if (filter === 'off' && s !== 'off') return false;
        if (filter === 'big' && st.areaTotal) {
          var isl = st.a.islands[id];
          if (!isl || isl.area / st.areaTotal < 0.01) return false;
        }
        if (query && ('#' + (id + 1)).indexOf(query) < 0) return false;
        return true;
      }

      /* 「还有 N 个」按钮：一次多放 200 行，别一上来就建 1177 个 DOM */
      function moreBtn(left, fn) {
        var b = mkEl('button', 'display:block;width:100%;margin:6px 0 2px;padding:5px 8px;border-radius:6px;' +
          'border:1px dashed #2c303a;background:#15181f;color:#8b90a0;cursor:pointer;font-size:11px;' +
          'font-family:inherit;text-align:center;', '显示更多（还有 ' + left + ' 个）');
        b.type = 'button';
        b.onclick = fn;
        return b;
      }

      function renderOut() {
        if (!outBody || !st.a) return;
        rowEls = {}; groupEyes = [];
        outBody.textContent = '';
        var total = st.a.islands.length;

        /* 有筛选 / 搜索时拍平成一张结果表：分组结构在此刻反而是噪音，
         * 找到目标岛（开关它）才是目的。 */
        if (filter !== 'all' || query) {
          var hit = [];
          for (var i = 0; i < total; i++) if (islandPass(i)) hit.push(i);
          outBody.appendChild(mkEl('div', 'color:#7d8291;font-size:10.5px;margin:2px 2px 6px;',
            '筛选结果 · ' + hit.length + ' 个'));
          var shown = Math.min(hit.length, restLimit);
          for (var k = 0; k < shown; k++) outBody.appendChild(islandRow(hit[k], false));
          if (hit.length > shown) {
            outBody.appendChild(moreBtn(hit.length - shown, function () { restLimit += 200; renderOut(); }));
          }
          outSub.textContent = '共 ' + total + ' 个岛 · 筛选中 ' + hit.length + ' 个';
          paintEyes();
          updateFoot();
          return;
        }

        for (var gi = 0; gi < st.groups.length; gi++) {
          outBody.appendChild(groupRow(gi));
          if (!st.groups[gi].__fold) {
            var ids = st.groups[gi].ids;
            for (var j = 0; j < ids.length; j++) if (st.a.islands[ids[j]]) outBody.appendChild(islandRow(ids[j], true));
          }
        }
        var rest = [];
        for (var r = 0; r < total; r++) if (inGroup(r) < 0) rest.push(r);
        if (st.groups.length) {
          outBody.appendChild(mkEl('div', 'color:#7d8291;font-size:10.5px;margin:10px 0 2px;padding:6px 2px 0;' +
            'border-top:1px dashed #262a33;', '未分组 · ' + rest.length));
        }
        var restShown = Math.min(rest.length, restLimit);
        for (var q2 = 0; q2 < restShown; q2++) outBody.appendChild(islandRow(rest[q2], false));
        if (rest.length > restShown) {
          outBody.appendChild(moreBtn(rest.length - restShown, function () { restLimit += 200; renderOut(); }));
        }
        outSub.textContent = '共 ' + total + ' 个岛 · 眼睛＝加入/移出遮罩';
        paintEyes();
        updateFoot();
      }

      function updateFoot() {
        if (!footInfo) return;
        footInfo.textContent = selIds.length ? '已选 ' + selIds.length + ' 个岛' : '点岛名多选，可成组';
        if (btnMake) {
          btnMake.style.opacity = selIds.length ? '1' : '.45';
          btnMake.style.pointerEvents = selIds.length ? 'auto' : 'none';
        }
      }

      /* 收起：整条左栏缩到 0 宽，只留左边一个小胶囊能再打开。
       * 上千个岛时左栏会占掉视口 1/4，「先看模型、再翻岛」反而更常用。 */
      function setCollapsed(v) {
        collapsed = !!v;
        if (outEl) {
          outEl.style.width = collapsed ? '0px' : '252px';
          outEl.style.borderRight = collapsed ? '0' : '1px solid #2c303a';
          outEl.style.overflow = 'hidden';
        }
        if (pillEl) pillEl.style.display = collapsed ? '' : 'none';
      }

      function buildOut() {
        var o = mkEl('div', 'pointer-events:auto;position:absolute;left:0;top:0;bottom:0;width:252px;' +
          'display:flex;flex-direction:column;background:rgba(13,15,20,.96);' +
          'border-right:1px solid #2c303a;box-shadow:8px 0 24px rgba(0,0,0,.35);' +
          'transition:width .16s ease;');
        outEl = o;
        var head = mkEl('div', 'flex:0 0 auto;padding:9px 10px 8px;border-bottom:1px solid #262a33;');

        var titleRow = mkEl('div', 'display:flex;align-items:center;gap:6px;');
        titleRow.appendChild(mkEl('div', 'flex:1;min-width:0;font-weight:600;color:#e8eaf0;font-size:13px;' +
          'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;', 'UV 岛大纲'));
        var foldBtn = mkEl('button', btnCss(false), '‹');
        foldBtn.type = 'button';
        foldBtn.title = '收起左栏';
        foldBtn.style.cssText += 'padding:1px 7px;font-size:13px;line-height:1.3;';
        foldBtn.onclick = function () { setCollapsed(true); };
        titleRow.appendChild(foldBtn);
        head.appendChild(titleRow);

        outSub = mkEl('div', 'color:#7d8291;font-size:10.5px;margin-top:3px;line-height:1.5;', '正在读取 UV 岛…');
        head.appendChild(outSub);

        searchEl = document.createElement('input');
        searchEl.type = 'search';
        searchEl.placeholder = '搜岛号（如 #127）';
        searchEl.style.cssText = 'width:100%;box-sizing:border-box;margin-top:7px;padding:4px 8px;border-radius:6px;' +
          'border:1px solid #2c303a;background:#12151b;color:#e8eaf0;font:11.5px/1.5 inherit;outline:none;';
        searchEl.oninput = function () {
          query = String(searchEl.value || '').trim().replace(/\s+/g, '');
          restLimit = REST_PAGE;
          renderOut();
        };
        head.appendChild(searchEl);

        /* 筛选片：眼睛状态不好在大列表里找，用「只看已加入」收窄最常用 */
        var chipRow = mkEl('div', 'display:flex;flex-wrap:wrap;gap:4px;margin-top:7px;');
        [['all', '全部'], ['on', '已加入'], ['off', '未加入'], ['big', '大岛']].forEach(function (it) {
          var b = mkEl('button', btnCss(it[0] === 'all'), it[1]);
          b.type = 'button';
          b.setAttribute('data-filter', it[0]);
          b.style.cssText += 'flex:0 0 auto;padding:2px 8px;font-size:10.5px;';
          b.onclick = function () {
            filter = it[0];
            restLimit = REST_PAGE;
            chipEls.forEach(function (x) {
              var on = x.getAttribute('data-filter') === filter;
              x.style.borderColor = on ? '#a3345e' : '#2c303a';
              x.style.background = on ? '#3a1c28' : '#191c22';
              x.style.color = on ? '#ffb3cd' : '#c9cede';
            });
            renderOut();
          };
          chipEls.push(b);
          chipRow.appendChild(b);
        });
        head.appendChild(chipRow);

        outBody = mkEl('div', 'flex:1;min-height:0;overflow:auto;padding:6px 8px 10px;');
        var foot = mkEl('div', 'flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:7px 8px;' +
          'border-top:1px solid #262a33;');
        footInfo = mkEl('span', 'flex:1;min-width:0;color:#8b90a0;font-size:10.5px;', '点岛名多选，可成组');
        btnMake = mkEl('button', btnCss(true), '成组');
        btnMake.type = 'button';
        btnMake.onclick = makeGroup;
        var clr = mkEl('button', btnCss(false), '清空选择');
        clr.type = 'button';
        clr.onclick = function () { selIds = []; renderOut(); updateFoot(); };
        foot.appendChild(footInfo); foot.appendChild(btnMake); foot.appendChild(clr);
        o.appendChild(head); o.appendChild(outBody); o.appendChild(foot);
        return o;
      }

      /* 绘制工具条移到右侧：左边整块留给 UV 岛大纲。
       * 绘制期间插槽抽屉与混合面板都收起，所以这里必须自带「完成 / 取消」。 */
      var ui = document.createElement('div');
      ui.style.cssText = 'pointer-events:auto;position:absolute;right:12px;top:12px;z-index:6;display:flex;flex-direction:column;gap:7px;' +
        'padding:9px 11px;border-radius:10px;background:rgba(13,15,20,.96);border:1px solid #2c303a;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.45);max-width:min(330px,60%);';
      var h1 = document.createElement('div');
      h1.textContent = '遮罩绘制';
      h1.style.cssText = 'font-weight:600;color:#e8eaf0;font-size:13px;';
      var h2 = document.createElement('div');
      h2.textContent = '在模型上按住拖动 · 白=显示，擦除处隐藏';
      h2.style.cssText = 'color:#8b90a0;font-size:11px;margin-top:-4px;line-height:1.5;';
      ui.appendChild(h1); ui.appendChild(h2);

      var sizeRow = document.createElement('div');
      sizeRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
      var lb = document.createElement('span');
      lb.textContent = '笔刷';
      lb.style.cssText = 'flex:0 0 auto;color:#c9cede;font-size:11px;';
      var rng = document.createElement('input');
      rng.type = 'range';
      rng.min = '4';
      rng.max = String(Math.max(32, Math.round(Math.min(W, H) * 0.5)));
      rng.step = '1';
      rng.value = String(st.size);
      rng.style.cssText = 'flex:1;min-width:90px;height:16px;accent-color:#e88a00;';
      var rv = document.createElement('b');
      rv.textContent = String(st.size);
      rv.style.cssText = 'flex:0 0 34px;text-align:right;color:#e8eaf0;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;';
      rng.oninput = function () { st.size = Math.max(2, Number(rng.value) || 2); rv.textContent = String(st.size); };
      sizeRow.appendChild(lb); sizeRow.appendChild(rng); sizeRow.appendChild(rv);

      function mkStyle(b, on) {
        b.style.cssText = 'flex:0 0 auto;padding:4px 9px;border-radius:6px;border:1px solid ' +
          (on ? '#a3345e' : '#2c303a') + ';background:' + (on ? '#3a1c28' : '#191c22') +
          ';color:' + (on ? '#ffb3cd' : '#c9cede') + ';cursor:pointer;font-size:11.5px;line-height:1.4;';
      }

      /* 模式行：绘制 / 擦除 / 岛＋ / 岛－（岛模式在模型上点，左栏也能点） */
      var modeRow = document.createElement('div');
      modeRow.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;';
      var MODE_HINT = {
        paint: '绘制中：涂到的地方这一层显示',
        erase: '擦除中：抹掉的地方这一层就隐藏',
        add: '拾取 UV 岛：点模型把整个岛加进遮罩（拖动可连续选）',
        sub: '拾取 UV 岛：点模型把整个岛从遮罩去掉（拖动可连续选）'
      };
      var modeBtns = [];
      function modeBtn(text, key) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.dataset.mvMode = key;
        mkStyle(b, st.mode === key);
        b.onclick = function () {
          if (key === 'add' || key === 'sub') {
            /* 岛模式的射线拾取要有岛数据：分析失败就别切过去 */
            if (!islandData()) return;
          }
          st.mode = key;
          modeBtns.forEach(function (x) { mkStyle(x, x.dataset.mvMode === key); });
          hint.textContent = MODE_HINT[key];
        };
        modeBtns.push(b);
        modeRow.appendChild(b);
        return b;
      }
      modeBtn('绘制', 'paint');
      modeBtn('擦除', 'erase');
      modeBtn('岛＋', 'add');
      modeBtn('岛－', 'sub');

      var actRow = document.createElement('div');
      actRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
      function actBtn(text, fn, on) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        mkStyle(b, !!on);
        b.onclick = fn;
        actRow.appendChild(b);
        return b;
      }
      actBtn('清空', function () {
        ctx.clearRect(0, 0, st.W, st.H);
        if (st.a) { refreshStates(); paintEyes(); }
        scheduleMix(st.slot);
      });
      actBtn('取消', function () { stopPaint(false); });
      actBtn('完成', function () { stopPaint(true); }, true);

      var tip = document.createElement('div');
      tip.textContent = '遮罩 ' + W + '×' + H + ' · 只在「' + slotLabel(slot) + '」上画';
      tip.style.cssText = 'color:#7d8291;font-size:10.5px;';
      ui.appendChild(sizeRow); ui.appendChild(modeRow); ui.appendChild(actRow); ui.appendChild(tip);

      /* 一层不拦事件的包裹层：左栏 + 右侧工具条都挂它下面，收尾只删一个节点 */
      var wrap = document.createElement('div');
      wrap.setAttribute('data-mask-paint', '1');
      wrap.style.cssText = 'position:absolute;inset:0;z-index:6;pointer-events:none;';
      wrap.appendChild(buildOut());
      /* 左栏收起后留一个薄胶囊，随时能再打开 */
      pillEl = mkEl('button', 'pointer-events:auto;display:none;position:absolute;left:8px;top:8px;z-index:7;' +
        'padding:5px 9px;border-radius:7px;border:1px solid #2c303a;background:rgba(13,15,20,.96);' +
        'color:#e8eaf0;cursor:pointer;font:11.5px/1.4 system-ui,"Microsoft YaHei",sans-serif;', 'UV 岛 ›');
      pillEl.type = 'button';
      pillEl.title = '展开 UV 岛大纲';
      pillEl.onclick = function () { setCollapsed(false); };
      wrap.appendChild(pillEl);
      wrap.appendChild(ui);
      paintEl = wrap;
      stage.appendChild(wrap);

      /* 建完 DOM 再分析岛：拿得到数据才画得出大纲 */
      var a0 = islandData();
      if (a0) {
        st.areaTotal = 0;
        for (var ai = 0; ai < a0.islands.length; ai++) st.areaTotal += a0.islands[ai].area;
        refreshStates();
        renderOut();
      } else {
        outSub.textContent = 'UV 岛不可用';
        outBody.appendChild(mkEl('div', 'color:#8b90a0;font-size:11px;line-height:1.7;padding:8px 2px;',
          '这个模型没有可用的 UV 岛数据（网格缺 UV，或没加载 modeltex.js）。左栏用不了，笔刷绘制不受影响。'));
      }
      updateFoot();

      /* 绘制时把两层 UI 都收起来，把画布整块让出来 */
      if (mixer) mixer.style.display = 'none';
      panel.style.display = 'none';
      if (typeof deps.onPanelClose === 'function') deps.onPanelClose();
      hint.textContent = '遮罩绘制：在模型上按住拖动，白色=显示，擦除=隐藏；左栏可按岛分组开关';
    }

    /* ---------------- 纹理混合面板 ----------------
     * 一个材质槽 = 一叠图层。列表从上到下就是合成顺序（最上面最后叠加），
     * 最下面是「模型自带贴图」，不可删、不可调比例（它就是底）。
     * 每层三个旋钮：混合模式 / 比例（不透明度）/ 遮罩。
     */
    function closeMixer() {
      /* 返回 / 换槽 / 收面板都算「画完了」：不静默丢弃笔画 */
      if (painting) stopPaint(true);
      mixerAlive = false;
      mixerSlot = null;
      mixBody = null;
      bakeBtn = null;
      if (mixer && mixer.parentNode) mixer.parentNode.removeChild(mixer);
      mixer = null;
    }

    /* 拖滑杆只重合成、不重绘列表（重绘会把手指下面的 range 换掉）；
     * 松手才写盘 + 刷新外层卡片上的「N 层混合」。 */
    function renderMix() {
      var slot = mixerSlot; if (!slot) return;
      mixBody.innerHTML = '';
      var ls = slot.layers || [];

      if (!ls.length) {
        var zero = document.createElement('div');
        zero.style.cssText = 'color:#8b90a0;font-size:12px;line-height:1.7;background:#12151b;border:1px dashed #2c303a;border-radius:10px;padding:10px;';
        zero.textContent = slot.__baked
          ? '当前已经是烘焙后的贴图（见下方底层）。还想继续改：再叠新图层，效果会从这张烘焙图起算。'
          : '还没有混合层。点下面「＋ 本机贴图」加一张，它会盖在模型自带贴图上；再加第二张就能用「比例 + 遮罩」做过渡、脏迹、旧化这类效果。';
        mixBody.appendChild(zero);
      }

      /* 从上往下画：数组最后一项是最上面那层 */
      for (var i = ls.length - 1; i >= 0; i--) mixBody.appendChild(layerRow(ls, i));
      mixBody.appendChild(baseRow());

      /* 没有有效图层时没必要烘焙（结果就是基础贴图本身），按钮置灰说明白 */
      syncBakeBtn(slot);
    }

    function layerRow(ls, idx) {
      var slot = mixerSlot; if (!slot) return null;
      var l = ls[idx];
      var row = document.createElement('div');
      row.style.cssText = 'background:#171a21;border:1px solid #23262e;border-radius:10px;padding:8px;display:flex;flex-direction:column;gap:7px;';

      /* 第一行：缩略图 + 名字 + 上移/下移/删除 */
      var line1 = document.createElement('div');
      line1.style.cssText = 'display:flex;align-items:center;gap:8px;';
      var thBox = document.createElement('div');
      thBox.style.cssText = 'flex:0 0 40px;height:40px;border-radius:6px;background:#0a0b0e;border:1px solid #23262e;overflow:hidden;';
      var lth = layerThumb(l, 40);
      if (lth) thBox.appendChild(lth);
      line1.appendChild(thBox);

      var nm = document.createElement('div');
      nm.textContent = l.name || ('图层 ' + (idx + 1));
      nm.title = nm.textContent;
      nm.style.cssText = 'flex:1;min-width:0;color:#e8eaf0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      line1.appendChild(nm);

      function miniBtn(text, title, fn, on) {
        var b = document.createElement('button');
        b.textContent = text;
        b.title = title;
        b.style.cssText = 'flex:0 0 auto;min-width:26px;height:24px;padding:0 6px;border-radius:6px;border:1px solid ' +
          (on ? '#3f6ea8' : '#2c303a') + ';background:' + (on ? '#1d3550' : '#191c22') +
          ';color:' + (on ? '#cfe4ff' : '#c9cede') + ';cursor:pointer;font-size:12px;line-height:1;';
        b.onclick = fn;
        line1.appendChild(b);
        return b;
      }
      /* 列表是倒序显示的：视觉上「上移」= 数组往后挪一位 */
      if (idx < ls.length - 1) miniBtn('↑', '上移一层', function () { moveLayer(ls, idx, idx + 1); });
      if (idx > 0) miniBtn('↓', '下移一层', function () { moveLayer(ls, idx, idx - 1); });
      miniBtn('×', '删除这一层', function () {
        if (painting && painting.layer === l) stopPaint(false);
        ls.splice(idx, 1);
        applyMix(slot); persistSlot(slot); refreshList(); renderMix();
      });
      row.appendChild(line1);

      /* 第二行：混合模式 + 比例 */
      var line2 = document.createElement('div');
      line2.style.cssText = 'display:flex;align-items:center;gap:8px;';
      var sel = document.createElement('select');
      sel.style.cssText = 'flex:0 0 92px;padding:4px 6px;border-radius:6px;border:1px solid #2c303a;background:#0f1116;color:#e8eaf0;font-size:12px;';
      BLEND_MODES.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.key; o.textContent = m.label;
        sel.appendChild(o);
      });
      sel.value = l.blend || 'normal';
      sel.onchange = function () { l.blend = sel.value; scheduleMix(slot); persistSlot(slot); };
      line2.appendChild(sel);

      var rng = document.createElement('input');
      rng.type = 'range'; rng.min = '0'; rng.max = '100'; rng.step = '1';
      rng.value = String(Math.round(clampNum(l.opacity, 0, 1) * 100));
      rng.style.cssText = 'flex:1;min-width:0;accent-color:#4d8cf5;height:18px;';
      var val = document.createElement('span');
      val.textContent = rng.value + '%';
      val.style.cssText = 'flex:0 0 38px;text-align:right;color:#9aa0b0;font-size:11px;font-variant-numeric:tabular-nums;';
      rng.oninput = function () {
        l.opacity = Number(rng.value) / 100;
        val.textContent = rng.value + '%';
        scheduleMix(slot);
      };
      rng.onchange = function () { persistSlot(slot); refreshList(); };
      line2.appendChild(rng); line2.appendChild(val);
      row.appendChild(line2);

      /* 第三行：遮罩（白色显示 / 黑色隐藏，可反相） */
      var line3 = document.createElement('div');
      line3.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
      if (l.mask && l.mask.id) {
        var mtag = document.createElement('span');
        mtag.textContent = '遮罩 ' + (l.mask.name || '');
        mtag.title = mtag.textContent;
        mtag.style.cssText = 'flex:1;min-width:0;color:#7fbf8f;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        line3.appendChild(mtag);
        var invB = document.createElement('button');
        invB.textContent = '反相';
        invB.style.cssText = 'flex:0 0 auto;padding:3px 8px;border-radius:6px;border:1px solid ' +
          (l.mask.invert ? '#3f6ea8' : '#2c303a') + ';background:' + (l.mask.invert ? '#1d3550' : '#191c22') +
          ';color:' + (l.mask.invert ? '#cfe4ff' : '#c9cede') + ';cursor:pointer;font-size:11px;';
        invB.onclick = function () {
          l.mask.invert = !l.mask.invert;
          applyMix(slot); persistSlot(slot); refreshList(); renderMix();
        };
        line3.appendChild(invB);
        var paintB = document.createElement('button');
        paintB.textContent = '画';
        paintB.title = '在模型上继续画这张遮罩（可拾取 UV 岛）';
        paintB.style.cssText = 'flex:0 0 auto;padding:3px 8px;border-radius:6px;border:1px solid #6b4a1e;background:#2a2118;color:#f0c98a;cursor:pointer;font-size:11px;';
        paintB.onclick = function () { startPaint(l); };
        line3.appendChild(paintB);
        var reB = document.createElement('button');
        reB.textContent = '换';
        reB.title = '换一张遮罩';
        reB.style.cssText = 'flex:0 0 auto;padding:3px 8px;border-radius:6px;border:1px solid #2c303a;background:#191c22;color:#c9cede;cursor:pointer;font-size:11px;';
        reB.onclick = function () {
          openPicker('选择遮罩', function (pick) { return setMask(l, pick); });
        };
        line3.appendChild(reB);
        var clrB = document.createElement('button');
        clrB.textContent = '去遮罩';
        clrB.style.cssText = 'flex:0 0 auto;padding:3px 8px;border-radius:6px;border:1px solid #2c303a;background:#191c22;color:#c9cede;cursor:pointer;font-size:11px;';
        clrB.onclick = function () {
          if (painting && painting.layer === l) stopPaint(false);
          l.mask = null;
          applyMix(slot); persistSlot(slot); refreshList(); renderMix();
        };
        line3.appendChild(clrB);
      } else {
        var mPaint = document.createElement('button');
        mPaint.textContent = '画遮罩';
        mPaint.title = '直接在模型上画遮罩（支持 UV 岛拾取）';
        mPaint.style.cssText = 'flex:0 0 auto;padding:3px 8px;border-radius:6px;border:1px solid #6b4a1e;background:#2a2118;color:#f0c98a;cursor:pointer;font-size:11px;';
        mPaint.onclick = function () { startPaint(l); };
        line3.appendChild(mPaint);
        var mAdd = document.createElement('button');
        mAdd.textContent = '＋ 遮罩';
        mAdd.title = '用一张黑白图决定这一层显示在哪里';
        mAdd.style.cssText = 'flex:0 0 auto;padding:3px 8px;border-radius:6px;border:1px solid #2c303a;background:#191c22;color:#c9cede;cursor:pointer;font-size:11px;';
        mAdd.onclick = function () {
          openPicker('选择遮罩（白=显示 黑=隐藏）', function (pick) { return setMask(l, pick); });
        };
        line3.appendChild(mAdd);
      }
      row.appendChild(line3);
      return row;
    }

    function moveLayer(ls, from, to) {
      var slot = mixerSlot; if (!slot) return;
      var tmp = ls[to];
      ls[to] = ls[from];
      ls[from] = tmp;
      applyMix(slot); persistSlot(slot); refreshList(); renderMix();
    }

    function baseRow() {
      var slot = mixerSlot; if (!slot) return null;
      var has = !!(slot.baseTex && slot.baseTex.image);
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;background:#12151b;border:1px dashed #2c303a;border-radius:10px;padding:8px;';
      var box = document.createElement('div');
      box.style.cssText = 'flex:0 0 40px;height:40px;border-radius:6px;background:#0a0b0e;border:1px solid #23262e;overflow:hidden;display:flex;align-items:center;justify-content:center;';
      var th = thumbOfTex(slot.baseTex, 40);
      if (th) box.appendChild(th);
      else {
        var sp = document.createElement('span');
        sp.textContent = '无';
        sp.style.cssText = 'color:#5a5f70;font-size:10px;';
        box.appendChild(sp);
      }
      row.appendChild(box);
      var col = document.createElement('div');
      col.style.cssText = 'flex:1;min-width:0;';
      var a = document.createElement('div');
      a.textContent = slot.__baked ? '烘焙贴图（底层）' : '模型自带贴图（底层）';
      a.style.cssText = 'color:#c9cede;font-size:12px;';
      var b = document.createElement('div');
      b.textContent = slot.__baked
        ? '由混合层合并生成 · ' + (slot.__baked.id ? '已存入图库' : '已下载到本机') + ' · 不可删除'
        : (has ? '不可删除、不参与混合比例' : '模型没有自带贴图，合成从白底开始');
      b.style.cssText = 'color:#7d8291;font-size:11px;';
      col.appendChild(a); col.appendChild(b);
      row.appendChild(col);
      return row;
    }


    function openMixer(slot) {
      if (!panel) return;
      closePicker();
      closeMixer();
      ensureBase(slot);
      mixerSlot = slot;
      mixerAlive = true;

      mixer = document.createElement('div');
      mixer.setAttribute('data-mix-root', '1');
      mixer.style.cssText = 'position:absolute;inset:0;background:rgba(13,15,20,.99);z-index:6;display:flex;flex-direction:column;';

      var head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #23262e;flex:0 0 auto;';
      var t = document.createElement('div');
      t.style.cssText = 'flex:1;min-width:0;';
      var t1 = document.createElement('div');
      t1.textContent = '纹理混合';
      t1.style.cssText = 'font-weight:600;color:#e8eaf0;font-size:13px;';
      var t2 = document.createElement('div');
      t2.textContent = slotLabel(slot);
      t2.style.cssText = 'color:#8b90a0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      t.appendChild(t1); t.appendChild(t2);
      var backB = document.createElement('button');
      backB.textContent = '返回';
      backB.style.cssText = 'padding:5px 10px;border-radius:8px;border:1px solid #2c303a;background:#191c22;color:#e8eaf0;cursor:pointer;font-size:12px;';
      backB.onclick = function () {
        if (mixerSlot) persistSlot(mixerSlot);
        closeMixer(); refreshList();
      };
      head.appendChild(t); head.appendChild(backB);

      var body = document.createElement('div');
      body.style.cssText = 'flex:1;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-height:0;';
      mixBody = body;

      var foot = document.createElement('div');
      foot.style.cssText = 'flex:0 0 auto;padding:10px 12px;border-top:1px solid #23262e;display:flex;flex-direction:column;gap:8px;';
      var addRow = document.createElement('div');
      addRow.style.cssText = 'display:flex;gap:8px;';
      addRow.appendChild(mkBtn('＋ 本机贴图', function () {
        openPicker('添加贴图', function (pick) { return addLayer(slot, pick); }, { multi: true });
      }));
      addRow.appendChild(mkBtn('＋ 从图库', function () {
        openPicker('添加贴图', function (pick) { return addLayer(slot, pick); }, { multi: true });
      }));
      var resetB = mkBtn('清空混合', function () { resetMix(slot); });
      addRow.appendChild(resetB);

      /* 烘焙单独占一行：它是「一步收尾」的动作，和三颗加/清按钮混排会让人以为它也是图层操作 */
      var bakeRow = document.createElement('div');
      bakeRow.style.cssText = 'display:flex;gap:8px;';
      bakeBtn = mkBtn('烘焙成贴图', function () { bakeSlot(slot, bakeBtn); });
      bakeBtn.title = '把基础贴图 + 所有混合层压成一张 PNG，存入图库并设为本材质的基础贴图（混合层会清空）';
      bakeBtn.style.flex = '1 1 auto';
      bakeBtn.style.height = '30px';
      bakeBtn.style.borderColor = '#3f6ea8';
      bakeBtn.style.background = '#1d3550';
      bakeBtn.style.color = '#cfe4ff';
      bakeRow.appendChild(bakeBtn);

      var tip = document.createElement('div');
      var sz = mixSize(slot);
      tip.textContent = '合成 ' + sz.w + '×' + sz.h + ' · 最多 ' + MIX_LIMIT + ' 层 · 遮罩白=显示 黑=隐藏';
      tip.style.cssText = 'color:#8b90a0;font-size:11px;';
      foot.appendChild(addRow); foot.appendChild(bakeRow); foot.appendChild(tip);

      mixer.appendChild(head); mixer.appendChild(body); mixer.appendChild(foot);
      panel.appendChild(mixer);

      renderMix();
    }

    /* ---------------- GLB 导出 ---------------- */
    function exportGLBBuffer() {
      if (!THREE.GLTFExporter) throw new Error('GLTFExporter 未加载（vendor/GLTFExporter.js）');
      var exp = new THREE.GLTFExporter();
      return new Promise(function (res, rej) {
        exp.parse(model.root, res, rej, { binary: true });
      }).then(function (r) {
        if (!(r instanceof ArrayBuffer)) throw new Error('GLB 导出结果异常');
        return r;
      });
    }

    /* 这两个是模块级 bufToDataURL / saveDataURL 的薄别名（原来各写一份，导出 GLB 与
     * UV 排布都要用，留两份迟早「一处改了另一处没改」） */
    function abToDataURL(buf) { return bufToDataURL(buf, 'model/gltf-binary'); }
    function downloadDataURL(name, url) { saveDataURL(name, url); }

    async function saveGLB(btn) {
      var old = btn.textContent;
      btn.disabled = true; btn.textContent = '导出中…';
      hint.textContent = '正在导出 GLB…';
      try {
        var buf = await exportGLBBuffer();
        var url = abToDataURL(buf);
        var d = window.openagiDesktop;
        if (!(d && typeof d.assetPut === 'function')) {
          downloadDataURL(baseName + '_贴图.glb', url);
          hint.textContent = '浏览器里存不进模型库，已改为下载 GLB';
          return;
        }
        var r = await d.assetPut({
          kind: 'model', ext: 'glb',
          name: baseName + '_贴图.glb',
          data: url, source: 'texture'
        });
        if (!(r && r.ok && r.asset && r.asset.id)) throw new Error((r && r.message) || '入库失败');
        /* 缩略图顺手存一张：模型库磁贴直接显示带贴图的样子（失败不影响入库） */
        try {
          var th = await renderThumb(url, { size: 256 });
          await d.assetThumbSave(r.asset.id, th.dataURL);
        } catch (e) { }
        hint.textContent = '已存入模型库：「' + baseName + '_贴图.glb」';
      } catch (e) {
        hint.textContent = '导出失败：' + ((e && e.message) || e);
        hint.style.color = '#e05252';
      } finally {
        btn.disabled = false; btn.textContent = old;
      }
    }

    async function downloadGLB(btn) {
      var old = btn.textContent;
      btn.disabled = true; btn.textContent = '导出中…';
      try {
        var buf = await exportGLBBuffer();
        downloadDataURL(baseName + '_贴图.glb', abToDataURL(buf));
        hint.textContent = 'GLB 已开始下载';
      } catch (e) {
        hint.textContent = '导出失败：' + ((e && e.message) || e);
        hint.style.color = '#e05252';
      } finally {
        btn.disabled = false; btn.textContent = old;
      }
    }

    (deps.barAsset || bar).appendChild(mkBtn('材质插槽', function () {
      if (typeof deps.onPanelOpen === 'function') deps.onPanelOpen();
      ensurePanel();
    }));

    /* 模型加载完就把上次的贴图贴回去（异步，加载不阻塞视口） */
    restoreTextures();

    /* 给 UV 视图用：切过去之前把抽屉和它的二级层一起收掉 */
    return {
      hide: closeSlotPanel
    };
  }

  M.setupSlotPanel = setupSlotPanel;
})(window);
