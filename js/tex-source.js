/* 纹理来源统一读取：全工程「这个槽的底图是哪张」只有一个答案
 *
 * 背景（2026-11-11 调研，docs/纹理系统-整合与架构兼容方案.html）：
 * 纹理混合 / 绘画 / 投射烘焙 / UV 编辑器四处各自回答了一次「底图从哪来」，
 * 答案互不相同 ——
 *   绘画：ctx.baseImageFor（baked 优先）
 *   混合：slotMaps 当底层
 *   投射烘焙：baseImg → sharedTexture → liveSlotImage（视口里合成后的那张）
 *   UV 编辑器：只认 slotMaps
 * 结果是同一个动作（拖岛 → 烘焙）在 slotMaps 空 / 非空时走向两个相反的错误，
 * 而且都是静默的。
 *
 * 本模块只做一件事：把「读」收成一处，返回 from 供上层观测与断言。
 * **不碰任何写路径** —— 写仍然各自写 slotMaps（切片三才改层），所以可以单独上线，
 * 风险接近于零。
 *
 * 取图顺序（写死，不按调用方心情）：
 *   1. slotMaps[slot] 的纹理像素    —— 未合成的底座，写回安全（笔迹/投射都在这上面画）
 *   2. 混合模块的 baked 底           —— 上一次「固化为底图」的结果
 *   3. 调用方给的解码缓存（opt.cached）—— 已经解好的一张大图，别重复解码
 *   4. liveSlotImage                 —— 材质上真正挂着的那张（含混合合成结果）
 *   5. 都没有 → img:null，调用方自己决定是画槽位底色还是拒绝操作
 *
 * 为什么第 4 条排最后：live 可能已经是「底 + 混合层」的合成图。
 * 拿它当编辑底座画完再写回 slotMaps，混合层就被烙进基础图，下次合成再叠一次
 * —— 这正是 P0-2（视口悄悄变浓）的成因。只有前三层全空时才用它，
 * 此时它是唯一能看到的东西，总比一片灰好，但 from 会如实报 'live'。
 *
 * 对外（window.TexSource）：
 *   bind({ doc, sharedTexture, liveSlotImage, bakedOf, composedOf })
 *   resolveBase(slot, opt) → { img, from, url, w, h }
 *   slotColor(slot)
 *   __debug(slot)
 */
(function (global) {
  'use strict';

  var D = null;

  /* 拿像素尺寸。Image 用 naturalWidth（width 在没解码完时可能是占位值），
   * Canvas / VideoFrame 没有 naturalWidth，退回 width。 */
  function px(img) {
    if (!img) return 0;
    var w = img.naturalWidth || img.width || 0;
    return w > 0 ? w : 0;
  }
  function py(img) {
    if (!img) return 0;
    var h = img.naturalHeight || img.height || 0;
    return h > 0 ? h : 0;
  }

  function docOf() {
    if (!D || !D.doc) return null;
    try { return D.doc(); } catch (e) { return null; }
  }

  function slotUrl(slot) {
    var doc = docOf();
    var list = (doc && doc.materials && doc.materials.slotMaps) || [];
    return list[slot] || '';
  }

  function slotColor(slot) {
    var doc = docOf();
    var list = (doc && doc.materials && doc.materials.slotColors) || [];
    return list[slot] || '#c9ccd4';
  }

  /* 唯一的读入口。
   * opt.cached  调用方自己的解码缓存（已经确认属于这个槽、且 url 对得上）
   * opt.skipMix 跳过 baked —— 「固化为底图」时要拿真正的原始底座 */
  function resolveBase(slot, opt) {
    opt = opt || {};
    var out = { img: null, from: '', url: slotUrl(slot), w: 0, h: 0 };
    if (!D) return out;

    /* 1. slotMaps 原件 */
    if (out.url && D.sharedTexture) {
      var t = null;
      try { t = D.sharedTexture(out.url); } catch (e) { t = null; }
      if (t && px(t.image)) { out.img = t.image; out.from = 'slot'; }
    }

    /* 2. 混合模块留下的 baked 底 */
    if (!out.img && !opt.skipMix && D.bakedOf) {
      var b = null;
      try { b = D.bakedOf(slot); } catch (e) { b = null; }
      if (px(b)) { out.img = b; out.from = 'baked'; }
    }

    /* 3. 调用方缓存 —— 按 url 校验，避免换图后还画着上一张 */
    if (!out.img && opt.cached && px(opt.cached)) {
      if (!opt.cachedUrl || !out.url || opt.cachedUrl === out.url) {
        out.img = opt.cached;
        out.from = 'cache';
      }
    }

    /* 4. 材质上真正挂着的那张。
     * 但要排除「纹理混合合成图」：它是 TB.compose 现算出来的，**不透明**（先填白底）。
     * 把它当底座会丢掉所有透明信息 —— 具体症状是「第二层叠加后整张贴图变白」，
     * 而且它每帧都可能变，拿它做编辑底座等于在流沙上盖楼。 */
    if (!out.img && D.liveSlotImage) {
      var lv = null;
      try { lv = D.liveSlotImage(slot); } catch (e) { lv = null; }
      var composed = null;
      if (lv && D.composedOf) { try { composed = D.composedOf(slot); } catch (e) { composed = null; } }
      if (px(lv) && lv !== composed) { out.img = lv; out.from = 'live'; }
    }

    if (out.img) { out.w = px(out.img); out.h = py(out.img); }
    return out;
  }

  /* 只要图，不要元信息（多数调用点用这个） */
  function baseImage(slot, opt) {
    return resolveBase(slot, opt).img;
  }

  function bind(deps) {
    D = deps || null;
  }

  function __debug(slot) {
    var i = slot == null ? 0 : slot;
    var r = resolveBase(i);
    var lv = null, composed = null;
    if (D && D.liveSlotImage) { try { lv = D.liveSlotImage(i); } catch (e) {} }
    if (D && D.composedOf) { try { composed = D.composedOf(i); } catch (e) {} }
    return {
      bound: !!D,
      url: r.url ? (r.url.length > 60 ? r.url.slice(0, 60) + '…(' + r.url.length + ')' : r.url) : '',
      from: r.from, w: r.w, h: r.h,
      color: slotColor(i),
      /* 三者身份关系：排查「底座是不是取到了合成图」只有这里能看清 */
      live: lv ? (lv.width || lv.naturalWidth) : 0,
      composed: composed ? (composed.image ? 1 : 2) : 0,
      liveIsComposed: !!(lv && composed && lv === composed)
    };
  }

  global.TexSource = {
    bind: bind,
    resolveBase: resolveBase,
    baseImage: baseImage,
    slotColor: slotColor,
    __debug: __debug
  };
})(window);
