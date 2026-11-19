/* 材质槽贴图仓储（P0 · 写路径收口）
 *
 * 为什么要有这一层（docs/建模App-架构分析与技术债务.html · P0）：
 *   「这一槽的底图是哪张」已经统一到 TexSource，但**写**仍散落在
 *   md-paint / md-texmix / md-proj-bake / md-uv-editor / 外壳五处，
 *   各自直接改 doc.materials.slotMaps 与 material.map。
 *   近期三个线上缺陷（合成图当底座、换文档串状态、贴图解码竞态）都出在这条写路径上。
 *
 * 本模块只负责「材质槽贴图」一件事：
 *   ① 共享解码缓存与状态：loading / ready / error（绘画据此拒绝在半解码底图上起画）
 *   ② 挂图：把一张贴图挂到所有视口对象（含平涂缓存材质）的第 slot 个材质
 *   ③ 读：视口里这一槽真正显示的那张图 / 那张纹理 / 是否还在解码
 *   ④ 文档里 slotColors / slotMaps 的最小读写（不做历史、不重建网格）
 * 它不创建材质、不做混合、不碰历史 —— 材质工厂仍在外壳，混合归 MIX，层栈归 TexStack。
 *
 * 对外（window.MDMaterialStore）：create(ctx) →
 *   { sharedTexture, texState, applySlotTexture, liveSlotImage, liveSlotTexture,
 *     baseLoading, slotColor, slotMap, setSlotColor, setSlotMap, __debug }
 * ctx：{ THREE, requestRender, eachViewPivot, doc }
 *   doc / requestRender / eachViewPivot 都必须传函数：材质槽随文档切换而变，
 *   仓储不能把 st 或某个网格拷进来。
 */
(function (global) {
  'use strict';

  function create(ctx) {
    var THREE = ctx.THREE;
    var requestRender = ctx.requestRender || function () {};
    var eachViewPivot = ctx.eachViewPivot || function () {};
    var docOf = ctx.doc || function () { return null; };

    /* 基础色贴图按 data URL 全局共享。
     * 拖动挤出时预览网格会反复重建材质，如果每次都 new Texture 重新解码一串 data URL，
     * 解码完成前的那几帧就是黑的 —— 用户看到的「拖坐标轴时贴图短暂变黑」。
     * 共享后同一张贴图只解码一次，新材质挂上去立刻就有像素。 */
    var TEX_CACHE = Object.create(null);

    function matsOf() {
      var doc = docOf();
      return (doc && doc.materials) || {};
    }

    /* 贴图是否可用：loading / ready / error。
     * ready / error 都算「有结论」，只有 loading 需要调用方等待。 */
    function texState(tex) {
      if (!tex) return '';
      var u = tex.userData || {};
      if (u.mdTexState === 'error' || u.mdTexState === 'ready') return u.mdTexState;
      var img = tex.image;
      /* 老缓存 / 外部创建的纹理没写过状态：image 已经有像素就是就绪 */
      if (img && (img.width || img.naturalWidth)) { u.mdTexState = 'ready'; return 'ready'; }
      return 'loading';
    }

    function sharedTexture(url) {
      var tex = TEX_CACHE[url];
      if (tex) return tex;
      /* 解码是异步的：首帧渲染时 image 还是空的，材质会被画成黑片。
       * 按需渲染下解码完成后必须显式补一帧，否则要等用户碰一下视口才恢复。 */
      tex = new THREE.TextureLoader().load(url, function () {
        tex.userData.mdTexState = 'ready';
        requestRender(0);
      }, undefined, function () {
        /* 加载失败：材质上只剩槽底色。标成 error，否则绘画会一直把它当「还在解码」挡着 */
        tex.userData.mdTexState = 'error';
        requestRender(0);
      });
      if ('encoding' in tex && THREE.sRGBEncoding != null) tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 4;
      tex.userData.mdShared = true;
      tex.userData.mdTexState = 'loading';
      TEX_CACHE[url] = tex;
      return tex;
    }

    /* 把一张贴图挂到所有对象「第 slot 个材质」上（含平涂缓存材质）。
     * 画笔与纹理混合共用这条路径：谁最后决定材质上放哪张图，都由调用方算好。
     * mdBaseMap 一起换，显示开关「贴图」关掉再打开才不会回到上一张旧图。
     * 返回实际挂上的材质数：0 = 视口里没有这个槽的材质（画笔用它提示「画了看不见」）。 */
    function applySlotTexture(slot, tex) {
      var applied = 0;
      /* 只有「贴图的有无 / 编码 / 翻转」变了才需要重编译着色器。
       * 同一张贴图换像素靠 texture.needsUpdate 就够 —— 每帧都置
       * material.needsUpdate 会让 three 反复重编译程序，画起来一闪一卡
       * （绘画时每帧都会走到这里）。 */
      var sig = tex ? (tex.encoding || '') + '|' + (tex.flipY === false ? 'n' : 'y') : 'none';
      function setMap(m) {
        if (!m) return false;
        if (!m.userData.mdPaintOrig) m.userData.mdPaintOrig = m.map || null;
        m.map = tex || null;
        m.userData.mdBaseMap = tex || null;
        if (m.userData.mdMapSig !== sig) { m.userData.mdMapSig = sig; m.needsUpdate = true; }
        return true;
      }
      eachViewPivot(function (pv) {
        pv.traverse(function (o) {
          if (!o.userData || o.userData.mdPart !== 'solid') return;
          if (o.material) {
            var arr = Array.isArray(o.material) ? o.material : [o.material];
            if (setMap(arr[slot])) applied++;
          }
          if (o.userData.mdFlatMats) {
            if (setMap(o.userData.mdFlatMats[slot])) applied++;
          }
        });
      });
      /* 换的是材质上的贴图，不是场景结构：指纹看不出来，必须显式请求一帧 */
      requestRender(0);
      return applied;
    }

    function liveSlotTexture(slot) {
      var out = null;
      eachViewPivot(function (pv) {
        if (out) return;
        pv.traverse(function (o) {
          if (out || !o.userData || o.userData.mdPart !== 'solid') return;
          var arr = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
          var m = arr[slot];
          if (m && m.map) out = m.map;
        });
      });
      return out;
    }

    /* 「视口里这一槽现在真正显示的那张图」。
     * 为什么不能只读 doc.materials.slotMaps：材质上的 map 还有别的来源 ——
     * 纹理混合（MIX.texFor 合成出来的 canvas）、绘画工具写回、外部导入只挂了
     * material.map 的老资产。烘焙 / 绘画工作区的**底图**必须是这一张：
     * 取不到就会拿槽位底色起一张空画布，写回后整片贴图被洗掉。 */
    function liveSlotImage(slot) {
      var out = null;
      eachViewPivot(function (pv) {
        if (out) return;
        pv.traverse(function (o) {
          if (out || !o.userData || o.userData.mdPart !== 'solid') return;
          var arr = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
          var m = arr[slot];
          var img = m && m.map && m.map.image;
          if (img && (img.width || img.naturalWidth)) out = img;
        });
      });
      return out;
    }

    /* 「这一槽的底图是否还在解码」。材质上可能已经挂了贴图（makeMaterials 挂的
     * slotMaps 地址），但 TextureLoader 是异步的：打开大模型 / 刚应用完修改器重建
     * 材质时，image 还没有像素。绘画工作区必须据此拒绝拿槽底色建平铺底工作副本 ——
     * 否则吸管吸到白色，抬笔后整张平铺白底还会被采纳成最终贴图（模型整片变白）。
     * 加载失败（error）返回 false：此时材质本来就只剩底色，挡着画不让画没有意义。 */
    function baseLoading(slot) {
      var tex = liveSlotTexture(slot);
      var url = (matsOf().slotMaps || [])[slot] || '';
      if (url && (!tex || TEX_CACHE[url] === tex)) tex = sharedTexture(url);
      if (!tex) return false;
      return texState(tex) === 'loading';
    }

    function slotColor(slot) {
      var list = matsOf().slotColors || [];
      return list[slot] || '#c9ccd4';
    }
    function slotMap(slot) {
      var list = matsOf().slotMaps || [];
      return list[slot] || '';
    }

    /* 槽色只改文档字段；重建材质 / 记历史由调用方（外壳 slotEdit）负责 */
    function setSlotColor(slot, color) {
      var doc = docOf();
      if (!doc) return false;
      var m = doc.materials || (doc.materials = {});
      var colors = m.slotColors || (m.slotColors = []);
      while (colors.length <= slot) colors.push('#c9ccd4');
      colors[slot] = color;
      return true;
    }
    /* 同上：只写 slotMaps，不碰材质与历史 */
    function setSlotMap(slot, url) {
      var doc = docOf();
      if (!doc) return false;
      var m = doc.materials || (doc.materials = {});
      var arr = m.slotMaps || (m.slotMaps = []);
      while (arr.length <= slot) arr.push('');
      arr[slot] = url || '';
      return true;
    }

    function __debug(slot) {
      var i = slot == null ? 0 : slot;
      var tex = liveSlotTexture(i);
      return {
        slot: i,
        url: slotMap(i) ? String(slotMap(i)).length : 0,
        color: slotColor(i),
        tex: !!tex,
        state: texState(tex),
        liveW: tex && tex.image ? (tex.image.width || tex.image.naturalWidth || 0) : 0
      };
    }

    return {
      sharedTexture: sharedTexture,
      texState: texState,
      applySlotTexture: applySlotTexture,
      liveSlotImage: liveSlotImage,
      liveSlotTexture: liveSlotTexture,
      baseLoading: baseLoading,
      slotColor: slotColor,
      slotMap: slotMap,
      setSlotColor: setSlotColor,
      setSlotMap: setSlotMap,
      __debug: __debug
    };
  }

  global.MDMaterialStore = { create: create };
})(window);
