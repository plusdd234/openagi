/* ============================================================
 * 多视图 App · 图层定义（mv-layers）
 *
 * 只有数据与纯逻辑：图层的名字、固定位、默认顺序、不透明度归一。
 * 面板怎么画（mv-layer-panel）和渲染怎么用（model3d.js）都从这里读，
 * 加一层只改这一处 + 渲染核的 LAYER_TABLE。
 * ============================================================ */
(function () {
  'use strict';

  var MV = window.MV;
  if (!MV) throw new Error('mv-layers.js 必须在 mv-core.js 之后加载');

  /* tag 只是显示用的角标（3D / 2D），**不再限制拖动**：任意两层都能互换。
   * 渲染核按 layerOrder 切段——相邻的 3D 层合成一段渲一次，2D 层夹在两次渲染之间。
   * 顺序真源是 state.layerOrder（**绘制先后**，先画的在前）；
   * 面板倒着显示（上层在上），跟 PS 的直觉一致。
   * d 是每层属性面板顶上那句说明：滑条名字都很短（「深度差」vs「深度范围」），
   * 没有这句过两天就分不清哪个是干嘛的。 */
  MV.LAYER_META = {
    grade:    { n: '后期处理', f: 'grade',      tag: '2D', fixed: 'top',
      d: '调最终输出图像的饱和度 / 对比度 / 亮度。它永远在最上面，不参与拖拽——放在中间就不是「后期」了。' },
    bg:       { n: '背景',     f: 'bg',         tag: '2D', fixed: 'bottom',
      d: '整幅铺一层纯色底（含格间距）。默认关着——这套图本来就是透明底、方便叠到别处。它固定在最底下：拖到模型上面会把模型整块盖掉。' },
    labels:   { n: '视图标签', f: 'labels',     tag: '2D',
      d: '每格左下角烘一个视角名。它是画上去的字，导出的 PNG 不带。' },
    dedge:    { n: '深度描边', f: 'depthEdge',  tag: '2D',
      d: '相邻像素的前后距离差超过阈值就描线。剪影之外还能描出遮挡边界和硬折角。' },
    outline:  { n: '外轮廓',   f: 'outline',    tag: '2D',
      d: '沿「模型 / 背景」的交界描一圈，纯剪影，不管物体内部结构。' },
    dgray:    { n: '深度灰',   f: 'depthGray',  tag: '2D',
      d: '把表面到相机的距离画成灰度（近白远黑），用来看前后层次。' },
    uvseam:   { n: 'UV 描边',  f: 'uvEdge',     tag: '3D',
      d: '沿 UV 岛边界画线：岛内部不画，只有被撕开的接缝才画。用来检查展 UV。' },
    crease:   { n: '角度线框', f: 'wireAngle',  tag: '3D',
      d: '只画折角大于阈值的边，按折角给粗细——结构线，不是全部骨架。' },
    wire:     { n: '线框',     f: 'wire',       tag: '3D',
      d: '所有边都画、粗细一致。跟「角度线框」是同一个开关的两档，只能开一个。' },
    uvisland: { n: 'UV 岛色',  f: 'uvIsland',   tag: '3D',
      d: '每只 UV 岛一个颜色，一眼看出 UV 切得碎不碎。' }
  };

  /* 绘制顺序（先画的在前）。深度灰排在线的下面：它是底色，线才是结构。
   * 半透明时下面那几层就会透出来——这才是图层该有的样子。
   * 末尾的 grade 是「后期处理」层：它永远在最上面，排序时会被强制甩到末尾。 */
  MV.LAYER_ORDER_DEF = ['bg', 'uvisland', 'dgray', 'wire', 'crease', 'uvseam', 'outline', 'dedge', 'labels', 'grade'];

  /* 老版本的默认顺序（深度灰在线的上面）。存档里如果还是这一份，静默换成新的：
   * 那是「深度灰强制盖住线」的旧行为，留着的话升级后灰度图上就没有线了。
   * 第二份是加了背景层、还没加后期处理层的中间版本，同样迁。 */
  MV.LAYER_ORDER_OLD = ['uvisland', 'wire', 'crease', 'uvseam', 'dgray', 'outline', 'dedge', 'labels'];
  MV.LAYER_ORDER_OLD2 = ['bg', 'uvisland', 'dgray', 'wire', 'crease', 'uvseam', 'outline', 'dedge', 'labels'];

  /* 每层默认不透明度（%）。键 = LAYER_META 的 k，加图层不用再来这里补一行 */
  MV.defaultOpacity = function () {
    var o = {};
    for (var k in MV.LAYER_META) o[k] = 100;
    return o;
  };

  /* 存档里可能缺层（老版本存的）或带脏值：补齐 + 夹到 0~100 */
  MV.normalizeOpacity = function (raw) {
    var d = MV.defaultOpacity();
    if (!raw || typeof raw !== 'object') return d;
    for (var k in d) {
      var v = Number(raw[k]);
      if (isFinite(v)) d[k] = Math.max(0, Math.min(100, Math.round(v)));
    }
    return d;
  };

  /* 存档里的顺序可能缺层（老版本存的）或多层（改过名）：补默认、去重复。
   * 两个「固定位」：bg 永远在最底下（它是底色，盖住模型就没意义了），
   * grade 永远在最上面（它是后期处理，必须在所有层之后）。 */
  MV.normalizeLayerOrder = function (arr) {
    var META = MV.LAYER_META, DEF = MV.LAYER_ORDER_DEF;
    var out = [], seen = {};
    (Array.isArray(arr) ? arr : []).forEach(function (k) {
      if (META[k] && !seen[k]) { seen[k] = 1; out.push(k); }
    });
    DEF.forEach(function (k) {
      if (seen[k]) return;
      /* 背景补在最底下：老存档里没有这一层，补到末尾会变成「盖住一切」 */
      if (k === 'bg') out.unshift(k);
      else out.push(k);
    });
    /* 固定位收敛：不管存档里写在哪，背景在最底、后期处理在最上。
     * 背景被拖到模型上面 → 整块盖掉模型（用户会以为模型坏了）。 */
    var bi = out.indexOf('bg');
    if (bi > 0) { out.splice(bi, 1); out.unshift('bg'); }
    var gi = out.indexOf('grade');
    if (gi >= 0) { out.splice(gi, 1); out.push('grade'); }
    return out;
  };
})();
