/* 建模 App · 投射烘焙编辑器（UV 岛 → 原画 重采样）
 *
 * 解决的问题：AI 图生 3D 出来的贴图往往在细节处糊掉（眼睛、纹理、字）。
 * 原画本身是清晰的，只是没对上 UV。这里做一台「把原画的那一块搬到 UV 上」的机器：
 *
 *   左：原画（可上传；默认铺当前材质槽的贴图，方便直接对照）
 *   右：UV 岛视图，每个面用「当前摄像机渲染图」的对应位置着色
 *       —— 之所以要相机着色而不是纯线框：不然一堆岛长得一模一样，认不出哪块是眼睛
 *   交互：右栏按住某个岛 → 拖到左栏原画的对应位置 → 松手 = 建立绑定
 *        再点「烘焙」按绑定把原画那块重采样进 UV 贴图
 *
 * 为什么右栏是「真实 UV 布局 + 相机着色」而不是「相机画面切块」：
 *   烘焙是按 UV 映射采样的，右栏形状必须就是 UV 形状，否则拖上去的框和实际采样
 *   的位置对不上（透视会引入形变）。相机信息只用来说「这块是哪」。
 *
 * 采样靠 Canvas 仿射：岛在原画上的位置 = 一个平移 + 等比缩放，
 * 所以「原图像素 → 贴图像素」是一个仿射矩阵，clip 到岛的 UV 多边形后 drawImage
 * 一次就得到插值正确的烘焙结果（比逐像素 JS 采样快两个数量级，且自带双线性）。
 *
 * 贴图真源仍是 doc.materials.slotMaps（与绘画工具箱同一套），
 * 一条烘焙 = 一条贴图补丁历史（{patch:{slot,before,after}}），Ctrl+Z 可回。
 *
 * 加载顺序：在 js/model-desk.js 之前（外壳 create 它）。
 */
(function (global) {
  'use strict';

  function create(ctx) {
    var st = ctx.st, $ = ctx.$, THREE = ctx.THREE, SeedModel = ctx.SeedModel, esc = ctx.esc;
    var setStatus = ctx.setStatus;
    var paintAll = ctx.paintAll, rebuildModel = ctx.rebuildModel;
    var sharedTexture = ctx.sharedTexture, applySlotTexture = ctx.applySlotTexture;
    /* 「视口里这一槽现在真正显示的那张图」：材质上的 map（含纹理混合合成图）。
     * 底图与工作区都优先用它 —— 取不到就会拿槽位底色起一张空画布，
     * 写回后整片贴图被洗掉（用户看到的「烘焙完贴图不见了」）。 */
    var liveSlotImage = ctx.liveSlotImage;

    var BAKE_MAX = 1024;        /* 烘焙贴图长边下限档：没有旧贴图时新建工作区用这个，
                                 * 与绘画工具箱（MDPaint.PAINT_MAX）保持一致 */
    var BAKE_CAP = 2048;        /* 旧贴图更大时工作区跟着走，最多到这一档。
                                 * 以前一律压到 1024：4096 的资产烘一次就永久变糊。 */
    var REPROJ_MAX = 12000;     /* 三角数超过这个就不做逐三角重投影，改逐面平色。
                                 * 平色是「每个三角一个平均色」，几千面时能看出点状马赛克；
                                 * 1.2 万次 clip+drawImage 约 0.3–0.6 秒，只在抓视角时跑一次，值。 */
    var PICK_SLOP = 14;         /* 右侧拾取岛时的容差（屏幕像素） */

    /* 模块状态。不放 st 上：投射编辑器是独立窗口，生命周期自带 open/close，
     * 塞进 st 只会让外壳多一份没人读的字段。 */
    var S = {
      open: false, win: null, mode: 'drag',
      srcImg: null, srcName: '', srcUrl: '',
      /* viewSrc：左栏正在「看原画」而不是「看合成结果」。
       * 上传完原画必须立刻把图铺出来 —— 否则用户点完上传，画布上一点动静都没有
       * （底图是旧贴图，原画平时只在拖岛选材时才出现），看起来就是「点击无反应」。
       * 拖第一个岛落地后自动切回合成视图。 */
      viewSrc: false,
      /* 底图层的内容：模型当前这一槽的贴图，和「原画」是**两张不同的图**。
       * 不分开的话底图与层永远一模一样，图层就没有可视意义了。
       * baseImg 是 Image/Canvas（THREE 贴图的 .image 也行），可直接 drawImage。 */
      baseImg: null, baseUrl: '', baseKey: '', baseFrom: '',
      /* baseKey：底图当前对应的是「哪个来源」（url 或 live）；baseFrom：实际用的是哪一条取法 */
      camView: null, camDirty: true, camInfo: '',
      idMap: null, idMapCv: null,   /* 拾取用：每个像素属于哪个岛（半分辨率） */
      left: { w: 0, h: 0, dpr: 1 },
      /* 左栏画布视图：z = 相对「contain 居中」的放大倍数，ox/oy = 平移（画布 CSS px）。
       * 只影响 leftFit()，不改 bind.s —— 岛的大小由角点拖动改，
       * 这样「看图」和「改绑定」是两套手势，不会互相顶掉。 */
      leftView: { z: 1, ox: 0, oy: 0 },
      rightV: { w: 0, h: 0, dpr: 1 },
      islands: [],               /* [{ id, faces, corners, bounds, slot }] */
      /* 连选（Shift 多选）。**始终包含 S.sel**（单选时 = [sel]），
       * 这样「选中的岛」只有一个真源：以前只改 S.sel 的地方不会留下半套状态。
       * 拖拽判据见 selGroup()：点在组里 → 整组一起走。 */
      multi: [],
      binds: Object.create(null),/* islandId -> { cx, cy, s, on, op }（原图像素坐标 / 原图像素 per **相机像素**，
                                 *  形状取当前视角的投影，不再与 UV 布局挂钩） */
      /* 图层。左栏是「这张贴图最后长什么样」的合成图：
       *   底图层 = 模型当前这一槽的贴图（隐式第 0 层，不装进 layerOrder）；
       *   之后每拖一个岛过来 = 新建一层，层内容 = 该岛形状内的原画。
       * 真源仍是 S.binds（岛 → 落位），层只是它的**有序视图 + 每层自己的开关**：
       *   layerOrder 从下到上（末尾 = 最上层，后画的盖住先画的）
       *   base 是底图层的开关。谁也不能另存一份 cx/cy。 */
      layerOrder: [],
      base: { on: true, op: 1 },
      lyOpen: true, lySel: null,/* 图层面板是否展开 / 选中项（'base' 或 islandId） */
      hover: -1, sel: -1, drag: null,
      slot: 0,
      bakeCv: null, bakeCtx: null, bakeSlot: -1, bakeDoc: null, bakeFrom: '', bakeBefore: null,
      onlySel: false,
      raf: 0, busy: false
    };

    function pbWin() { return $('mdPbWin'); }

    /* ---------------- 轻提示 ---------------- */
    var toastTimer = 0;
    function toast(text, isErr) {
      var el = $('mdPbToast');
      if (!el) { if (text) setStatus(text, !!isErr); return; }
      clearTimeout(toastTimer);
      if (!text) { el.classList.remove('on'); return; }
      el.textContent = text;
      el.classList.toggle('err', !!isErr);
      el.classList.add('on');
      toastTimer = setTimeout(function () {
        var now = $('mdPbToast');
        if (now) now.classList.remove('on');
      }, 2600);
    }

    /* ---------------- 窗口 DOM ---------------- */
    function winHtml() {
      return [
        '<div class="md-pb-head" data-pbdrag="win">',
        '  <b>投射烘焙</b><span class="md-pb-target" id="mdPbTarget"></span>',
        '  <span class="md-pb-headbtns">',
        '    <button type="button" class="md-pb-hbtn" data-pbact="recapture" title="按当前摄像机重新生成右栏画面（等同按 F）">重抓视角</button>',
        '    <button type="button" class="md-pb-hbtn" data-pbact="close" title="关闭（Esc）">×</button>',
        '  </span>',
        '</div>',
        '<div class="md-pb-body">',
        '  <div class="md-pb-pane">',
        '    <div class="md-pb-ptitle"><span>原画</span><em id="mdPbSrcName">未载入</em>',
        '      <span class="md-pb-pbtns">',
        '        <button type="button" class="md-pb-tbtn txt on" data-pbact="lyToggle" id="mdPbLyBtn" title="图层：底图一层，每拖一个岛过来多一层">图层</button>',
        '        <button type="button" class="md-pb-tbtn txt" data-pbact="srcView" id="mdPbSrcView" hidden title="在「合成预览」和「原画」之间切换">看原画</button>',
        /* 用 label[for] 而不是让脚本去 click 一个 display:none 的 input：
         * 原生激活不依赖任何 JS，也不会被外壳（自定义协议页 / WebView）
         * 以「非用户手势」为由拒绝 —— 那正是「点了上传原画毫无反应」的形态。 */
        '        <label class="md-pb-tbtn txt" for="mdPbFile" id="mdPbSrcPick" role="button" tabindex="0" title="选一张 AI 出的原图作为原画">上传原画</label>',
        '        <button type="button" class="md-pb-tbtn txt" data-pbact="srcClear" title="清除当前原画">清除</button>',
        '      </span>',
        '    </div>',
        '    <div class="md-pb-cvwrap"><canvas id="mdPbLeft"></canvas>',
        '      <div class="md-pb-empty" id="mdPbLeftEmpty">',
        '        <span class="md-pb-empty-i" aria-hidden="true">',
        '          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">',
        '            <rect x="7" y="10" width="34" height="28" rx="3"/>',
        '            <circle cx="17" cy="19" r="2.6"/>',
        '            <path d="M7 32l10-8 8 6 6-4 10 7"/>',
        '          </svg>',
        '        </span>',
        '        <b>还没有原画</b>',
        '        <span>选一张 AI 出的原图作为「原画」，再把右边要修的部位拖过来</span>',
        /* 空态里直接给按钮：原来只写「点上面的上传原画」，
         * 用户的视线在画面中央，得先回去找那颗按钮（多一次往返） */
        '        <label class="md-pb-empty-go" for="mdPbFile" role="button" tabindex="0">选择原画</label>',
        '        <em>每拖一个岛就多一层，原图不会被改坏</em>',
        '      </div>',
        '      <div class="md-pb-lypanel" id="mdPbLayers">',
        '        <div class="md-pb-lyhd"><b>图层</b><em id="mdPbLyCount"></em>',
        '          <button type="button" class="md-pb-lyx" data-pbact="lyToggle" title="收起图层面板">×</button>',
        '        </div>',
        '        <div class="md-pb-lylist" id="mdPbLyList"></div>',
        '        <div class="md-pb-lyfoot" id="mdPbLyFoot">',
        '          <span>不透明度</span>',
        '          <input type="range" id="mdPbLyOp" min="0" max="100" step="1" value="100">',
        '          <em id="mdPbLyOpVal">100%</em>',
        '        </div>',
        '      </div>',
        '      <div class="md-pb-toast" id="mdPbToast"></div>',
        '      <div class="md-pb-hint md-pb-zhint" id="mdPbZoomHint" hidden></div>',
        '    </div>',
        '  </div>',
        '  <i class="md-pb-split" id="mdPbSplit" title="拖动调整左右宽度"></i>',
        '  <div class="md-pb-pane">',
        '    <div class="md-pb-ptitle"><span>UV 岛 · 当前视角</span><em id="mdPbViewInfo"></em></div>',
        '    <div class="md-pb-cvwrap"><canvas id="mdPbRight"></canvas>',
        '      <div class="md-pb-hint" id="mdPbHint">按住一个岛，拖到左边原画上</div>',
        '    </div>',
        '  </div>',
        '</div>',
        '<div class="md-pb-foot">',
        '  <span class="md-pb-flab">材质槽</span>',
        '  <select class="md-pb-sel" id="mdPbSlot"></select>',
        '  <label class="md-pb-chk"><input type="checkbox" id="mdPbOnlySel"> 只烘焙选中岛</label>',
        '  <span class="md-pb-fsep"></span>',
        '  <button type="button" class="md-pb-go" data-pbact="bake" title="按当前绑定把原画重采样成一层投射（先不写贴图，可反复调整）">烘焙</button>',
        /* 「烘焙」= 推一层（非破坏）；这一颗才是写贴图（导出 / 交给别的软件前点） */
        '  <button type="button" class="md-pb-tbtn txt" data-pbact="flatten" id="mdPbFlatten" title="把所有投射层合进贴图。导出 / 拿去别的软件之前点它；平时不点也没事，视口看到的就是合成结果">固化为底图</button>',
        '  <button type="button" class="md-pb-tbtn txt" data-pbact="clearBinds" title="解除所有岛的绑定（不影响已烘焙的贴图）">清除绑定</button>',
        '  <button type="button" class="md-pb-tbtn txt" data-pbact="rebuildUV" id="mdPbRebuild" hidden title="UV 碎成太多块时，用盒式投影重新生成一套可用的 UV（原贴图映射会失效，Ctrl+Z 可撤销）">重建 UV</button>',
        '  <span class="md-pb-stat" id="mdPbStat"></span>',
        '</div>',
        /* 不能写 hidden：display:none 的 file input 在部分外壳里点不动 */
        '<input type="file" id="mdPbFile" class="md-pb-filein" accept="image/*" tabindex="-1">',
        '<i class="md-pb-rs" data-pbresize="br" title="拖动调整窗口大小"></i>'
      ].join('');
    }

    /* ---------------- 取数据 ---------------- */
    function meshReady() {
      if (!st.mesh || !st.doc) return false;
      if (!st.mesh.uvs || !st.mesh.uvs.length || st.mesh.uvs.length !== st.mesh.faceIndices.length * 2) {
        SeedModel.Mesh.ensureUV(st.mesh);
        SeedModel.Mesh.bump(st.mesh);
      }
      return true;
    }

    function slotOfIsland(isl) {
      var fs = st.mesh && st.mesh.faceSlots;
      if (!fs || !isl.faces.length) return 0;
      /* 取岛内出现最多的槽：岛通常整块属于同一个材质槽，取众数比取首面稳 */
      var cnt = Object.create(null), best = 0, bestN = -1;
      for (var i = 0; i < isl.faces.length; i++) {
        var s = fs[isl.faces[i]] || 0;
        cnt[s] = (cnt[s] || 0) + 1;
        if (cnt[s] > bestN) { bestN = cnt[s]; best = s; }
      }
      return best;
    }

    function buildIslands() {
      if (!st.mesh || !global.SeedUV) { S.islands = []; return; }
      var list = global.SeedUV.islands(st.mesh, null) || [];
      for (var i = 0; i < list.length; i++) {
        list[i].slot = slotOfIsland(list[i]);
        if (!list[i].bounds) list[i].bounds = global.SeedUV.boundsOf(st.mesh, list[i].corners);
      }
      /* 只保留有面积的岛：退化的空岛画不出东西，拖也没意义 */
      S.islands = list.filter(function (x) {
        return x.bounds && (x.bounds.w > 1e-6 || x.bounds.h > 1e-6);
      });
      /* 「显著岛」标记：岛一多就不全描边了（那条满屏青线是「一堆洞」观感的主要来源），
       * 但也不能一片都不画 —— 用户会不知道能点哪里。判据用 UV 包围盒，
       * 不逐岛投影，省掉 O(n) 的投影开销。 */
      for (var j = 0; j < S.islands.length; j++) {
        var bj = S.islands[j].bounds;
        S.islands[j]._big = Math.max(bj.w, bj.h) >= 0.02;
      }
    }

    /* ---------------- 相机渲染图（右栏着色的色源） ----------------
     * 不走 canvas.toDataURL：主画布没开 preserveDrawingBuffer，读出来多半是黑的。
     * 用离屏 RenderTarget 渲一次再 readPixels，这条路径与是否合成无关。
     * 渲完必须恢复 renderTarget 并重画主视口，否则视口会停在「被偷渲染」的那一帧。 */
    function captureView() {
      if (!st.renderer || !st.scene || !st.camera || !st.canvas) return null;
      var cw = st.canvas.clientWidth || st.canvas.width || 800;
      var ch = st.canvas.clientHeight || st.canvas.height || 600;
      var sc = Math.min(1, 1400 / Math.max(cw, ch));
      var W = Math.max(64, Math.round(cw * sc));
      var H = Math.max(64, Math.round(ch * sc));
      /* 只拍「当前对象」：别的对象会挡在前面，被挡住的 UV 面会采到它的颜色，
       * 烘焙出来就是一块灰 —— 实测立方体挡球体时整片 UV 变灰。
       * 顺带关掉地面栅格与边线/顶点叠加层，它们同样会污染取色。 */
      var hidden = [];
      function hide(o) { if (o && o.visible) { hidden.push(o); o.visible = false; } }
      var activeId = st.node ? st.node.id : '';
      var pid;
      for (pid in st.pivots) {
        if (pid !== activeId) hide(st.pivots[pid]);
      }
      var ovl = [];
      if (st.pivot) {
        st.pivot.traverse(function (o) {
          if (o === st.pivot) return;
          var part = o.userData && o.userData.mdPart;
          if (part && part !== 'solid' && o.visible) { ovl.push(o); o.visible = false; }
        });
      }
      hide(st.gridHelper);
      hide(st.compPivot);
      if (st.gizmo) hide(st.gizmo.root || st.gizmo.group || st.gizmo.gizmo);
      var oldBg = st.scene.background;
      st.scene.background = new THREE.Color(0x000000);

      var rt = null, buf = null, prev = st.renderer.getRenderTarget();
      try {
        rt = new THREE.WebGLRenderTarget(W, H, {
          minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
          depthBuffer: true, stencilBuffer: false
        });
        st.renderer.setRenderTarget(rt);
        st.renderer.render(st.scene, st.camera);
        st.renderer.setRenderTarget(prev);
        buf = new Uint8Array(W * H * 4);
        st.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
      } catch (e) {
        try { st.renderer.setRenderTarget(prev); } catch (e2) {}
        restoreScene();
        if (rt) { try { rt.dispose(); } catch (e3) {} }
        return null;
      }
      try { rt.dispose(); } catch (e4) {}
      restoreScene();

      function restoreScene() {
        var i;
        for (i = 0; i < hidden.length; i++) hidden[i].visible = true;
        for (i = 0; i < ovl.length; i++) ovl[i].visible = true;
        st.scene.background = oldBg;
      }
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var c2 = cv.getContext('2d');
      var id = c2.createImageData(W, H);
      /* readPixels 的原点在左下：逐行翻过来才和屏幕坐标一致。
       * 同时做 linear → sRGB：渲染到 RenderTarget 时不走画布那套 outputEncoding，
       * 读出来是线性值，直接用会整体偏暗（球体白模会变成深蓝灰）。 */
      var LUT = new Uint8Array(256);
      for (var q = 0; q < 256; q++) {
        var lin = q / 255;
        var srgb = lin <= 0.0031308 ? lin * 12.92 : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
        LUT[q] = Math.max(0, Math.min(255, Math.round(srgb * 255)));
      }
      var row = W * 4, d = id.data, src, dst, i;
      var covered = 0, edgePx = 0;
      for (var y = 0; y < H; y++) {
        src = (H - 1 - y) * row;
        dst = y * row;
        var edgeRow = (y === 0 || y === H - 1);
        for (i = 0; i < row; i += 4) {
          var r0 = LUT[buf[src + i]], g0 = LUT[buf[src + i + 1]], b0 = LUT[buf[src + i + 2]];
          d[dst + i] = r0;
          d[dst + i + 1] = g0;
          d[dst + i + 2] = b0;
          d[dst + i + 3] = 255;
          if (r0 + g0 + b0 > 30) {
            covered++;
            /* 贴着画面边缘还有内容 = 对象被裁掉了一块，投射会缺边 */
            if (edgeRow || i === 0 || i + 4 >= row) edgePx++;
          }
        }
      }
      S.camCoverage = covered / (W * H);
      S.camEdge = edgePx;
      c2.putImageData(id, 0, 0);
      S.camW = W; S.camH = H;
      return cv;
    }

    /* ---------------- 右栏：UV 空间着色位图 ----------------
     * 对每个面三角：UV 三角 → 屏幕三角 求仿射，clip 到 UV 三角后把相机图贴进去。
     * 结果是「UV 布局的形状 + 相机看到的内容」，既能认部位、形状又可用于精确烘焙。 */
    /* ---------------- 拾取用的 id 位图 ----------------
     * 右栏现在是「相机画面 + 岛边界」，拿 UV 空间的多边形做拾取已经不成立；
     * 逐个三角做屏幕命中又太慢（3 万面 × 每次指针移动）。
     * 所以预先渲一张「每个像素属于哪个岛」的半分辨率位图，拾取 O(1) 查表。
     * 同岛的面合进一个 Path2D 再一次 fill，颜色就是岛的 id（低字节 + 高字节）。 */
    /* 颜色里必须有个「亮标记」：直接拿 id 当红色时，id=1 就是 rgb(1,0,0)，
     * 读回来会被量化成 0（实测拾取全失败）。所以 R 通道固定当存在标记，
     * id 放进 G/B —— 岛数上限 65535 足够。
     * 标记位现在装的是**深度桶**（128 最近 … 255 最远，见 depthBucket）：
     * 拾取只看「R >= 120 就算有东西」，所以换成深度**不影响拾取**，
     * 却让同一张图顺手成了遮挡判据 —— 不用再画第二张深度图。 */
    function idColor(id, zb) {
      return 'rgb(' + (zb == null ? 200 : zb) + ',' + (id & 255) + ',' + ((id >> 8) & 255) + ')';
    }

    /* NDC z → 深度桶。z 越小越近（Vector3.project 已经除过 w）。
     * 128 级量化 ÷ 整个网格的 z 跨度：对「前后两个面」这种真正的遮挡绰绰有余，
     * 对同一片上几乎共面的邻面又足够宽容（差 1~2 桶不算遮挡）。 */
    function depthBucket(z, z0, z1) {
      if (!(z1 > z0 + 1e-9)) return 200;
      var t = (z - z0) / (z1 - z0);
      if (t < 0) t = 0; else if (t > 1) t = 1;
      return 128 + Math.round(t * 127);
    }

    function buildIdMap() {
      S.idMap = null;
      if (!st.mesh || !st.pivot || !S.camView || !S.islands.length) return;
      var iw = Math.max(16, Math.round(S.camW));
      var ih = Math.max(16, Math.round(S.camH));
      /* 拾取位图必须与相机图**同分辨率**。以前是 /2：
       * 一个三角在 666px 的画面里只有 ~5px 宽，落到 2.5px 的位图上被抗锯齿一混，
       * 读回来的 id 就四舍五入成了隔壁岛 —— 实测 3072 个碎岛的球体上，
       * 「点岛自己的位置选中自己」只成 589/3072，其余全点到邻岛（用户说「拖起来选错岛」）。
       * 面积成本可以忽略：这些三角形本来就小，开销主要在一次 beginPath/fill 的调用数上。 */
      var W = iw, H = ih;
      var cv = S.idMapCv || (S.idMapCv = document.createElement('canvas'));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      var c2 = cv.getContext('2d', { willReadFrequently: true });
      if (!c2) return;
      c2.setTransform(1, 0, 0, 1, 0, 0);
      c2.clearRect(0, 0, W, H);

      var mesh = st.mesh, pos = mesh.positions, nv = pos.length / 3;
      var kx = W / iw, ky = H / ih;
      /* 顶点投影一次全算好：既要画 id，又要按深度排序 */
      var px = new Float32Array(nv), py = new Float32Array(nv), pz = new Float32Array(nv);
      var v = new THREE.Vector3();
      for (var vi = 0; vi < nv; vi++) {
        v.set(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        v.applyMatrix4(st.pivot.matrixWorld).project(st.camera);
        px[vi] = (v.x * 0.5 + 0.5) * iw;
        py[vi] = (0.5 - v.y * 0.5) * ih;
        pz[vi] = v.z;
      }

      /* 深度桶的归一化范围 = 整个网格的 NDC z 跨度（这里 pz 已经全算好了）。
       * 跨度退化（纯平面 / 顶点都被压在同一深度）时 zok=false，
       * 下游直接不做剔除，别拿一堆同一个桶去误判遮挡。 */
      var z0 = Infinity, z1 = -Infinity;
      for (var zi = 0; zi < nv; zi++) { if (pz[zi] < z0) z0 = pz[zi]; if (pz[zi] > z1) z1 = pz[zi]; }
      var zok = (z1 > z0 + 1e-9);
      if (!zok) { z0 = 0; z1 = 1; }

      /* **必须按深度从远到近画**（画家算法）：否则背面的岛后画，会把正面的
       * 岛盖掉 —— 症状就是「点脸上的眼睛，选中了脑后那块看不见的岛」。
       * 网格绕序不统一，靠面法线剔除不可靠；深度排序对这类闭合体最稳。 */
      var items = [];
      for (var i = 0; i < S.islands.length; i++) {
        var isl = S.islands[i];
        for (var fi = 0; fi < isl.faces.length; fi++) {
          var f = isl.faces[fi], s0 = mesh.faceOffsets[f], e0 = mesh.faceOffsets[f + 1];
          if (e0 - s0 < 3) continue;
          var z = 0;
          for (var c = s0; c < e0; c++) z += pz[mesh.faceIndices[c]];
          items.push({ f: f, id: isl.id + 1, d: z / (e0 - s0) });
        }
      }
      items.sort(function (a2, b2) { return b2.d - a2.d; });

      var lastFill = '';
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        /* 一个面一种颜色（id 相同、深度不同），所以 fillStyle 得逐面设 —— 不能像
         * 以前那样「id 变了才设」。字符串相同的（同 id 同桶）跳过，省下重复解析。 */
        var fl = idColor(it.id, depthBucket(it.d, z0, z1));
        if (fl !== lastFill) { c2.fillStyle = fl; lastFill = fl; }
        var fs = mesh.faceOffsets[it.f], fe = mesh.faceOffsets[it.f + 1];
        c2.beginPath();
        for (var cc = fs; cc < fe; cc++) {
          var g = mesh.faceIndices[cc];
          if (cc === fs) c2.moveTo(px[g] * kx, py[g] * ky);
          else c2.lineTo(px[g] * kx, py[g] * ky);
        }
        c2.closePath();
        c2.fill();
      }

      S.idMap = { cv: cv, ctx: c2, w: W, h: H, data: null, kx: kx, ky: ky, iw: iw, ih: ih, ver: 0,
        z0: z0, z1: z1, zok: zok };
      var tris = 0;
      for (var tf = 0; tf < mesh.faceIds.length; tf++) {
        var tn = mesh.faceOffsets[tf + 1] - mesh.faceOffsets[tf];
        if (tn >= 3) tris += tn - 2;
      }
      S.camInfo = '当前视角 · ' + tris + ' 三角 · ' + S.islands.length + ' 岛';
    }

    /* ---------------- id 位图查询 ----------------
     * 位图与相机图同分辨率，所以换算就是乘一个 kx/ky（建图时算好存下，
     * 不要每次拿 S.camW / M.w 重算 —— 抓视角时两者可能不同步）。 */
    function ensureIdData(M) {
      if (M.data) return true;
      try { M.data = M.ctx.getImageData(0, 0, M.w, M.h).data; }
      catch (e) { M.data = null; return false; }
      return true;
    }
    /* 位图像素 → 岛 id（0 = 空，-1 = 读不出来） */
    function idAtMap(M, px, py) {
      if (px < 0 || py < 0 || px >= M.w || py >= M.h) return 0;
      if (!ensureIdData(M)) return -1;
      var o = (py * M.w + px) * 4;
      if (M.data[o] < 120) return 0;
      return M.data[o + 1] | (M.data[o + 2] << 8);
    }
    /* 某个「相机像素坐标」属于哪个岛（0 = 空） */
    function idAtCam(x, y) {
      var M = S.idMap;
      if (!M) return 0;
      return idAtMap(M, Math.round(x * M.kx), Math.round(y * M.ky));
    }

    /* 由近到远找一个岛。
     * 第一枪必须查**精确像素**：不然加容差会把「点哪就是哪」变成「点附近最大的那个」。
     * 不中才一圈一圈往外扩到 slop；同一圈里若出现「当前悬停 / 选中的岛」优先给它，
     * 免得鼠标压在两个岛的交界上时目标来回跳（3 万面碎岛网格上特别明显）。 */
    function idNear(M, mx, my, slop, pref) {
      var cx = Math.round(mx), cy = Math.round(my);
      var hit = idAtMap(M, cx, cy);
      if (hit !== 0) return hit > 0 ? hit : 0;
      for (var r = 1; r <= slop; r++) {
        var x0 = cx - r, x1 = cx + r, y0 = cy - r, y1 = cy + r;
        var fallback = 0, q, x, y;
        for (x = x0; x <= x1; x++) {
          q = idAtMap(M, x, y0);
          if (q > 0) { if (q === pref) return q; if (!fallback) fallback = q; }
          q = idAtMap(M, x, y1);
          if (q > 0) { if (q === pref) return q; if (!fallback) fallback = q; }
        }
        for (y = y0 + 1; y < y1; y++) {
          q = idAtMap(M, x0, y);
          if (q > 0) { if (q === pref) return q; if (!fallback) fallback = q; }
          q = idAtMap(M, x1, y);
          if (q > 0) { if (q === pref) return q; if (!fallback) fallback = q; }
        }
        if (fallback) return fallback;
      }
      return 0;
    }

    /* 把顶点从质心朝外推 grow 像素。只用于「clip 三角外扩」：
     * 相邻三角共用边，抗锯齿各留半格会在贴图上拼出一条半透明的缝。 */
    function growTo(c2, mx, my, x, y, grow, first) {
      var dx = x - mx, dy = y - my;
      var len = Math.sqrt(dx * dx + dy * dy);
      var k = len > 1e-6 ? 1 + grow / len : 1;
      var px = mx + dx * k, py = my + dy * k;
      if (first) c2.moveTo(px, py); else c2.lineTo(px, py);
    }

    /* ---------------- 坐标系 ----------------
     * 右栏是「当前摄像机看到的画面」，所以坐标就是视口像素，
     * 再按 contain 等比贴到画布上。这里没有 UV 空间的 cu/cv/scale ——
     * 用户要的是「人形被岛切开」，不是「UV 展开图」。 */
    function rightSize() {
      var c = $('mdPbRight');
      return { w: S.rightV.w || (c && c.clientWidth) || 600, h: S.rightV.h || (c && c.clientHeight) || 600 };
    }
    /* 相机图 → 画布（等比居中）。k = 相机像素 → 画布像素 */
    function camFit() {
      var s = rightSize();
      var iw = S.camW || (S.camView && S.camView.width) || 1;
      var ih = S.camH || (S.camView && S.camView.height) || 1;
      var k = Math.min(s.w / iw, s.h / ih);
      return { x: (s.w - iw * k) / 2, y: (s.h - ih * k) / 2, w: iw * k, h: ih * k, k: k, iw: iw, ih: ih };
    }
    /* 原图像素 → 画布 CSS 的**唯一**映射。
     * z=1 时就是原来的 contain 居中；放大/平移全部叠在这一个映射上，
     * 下游（命中、落点、挖亮、角点、烘焙预览）都只认 { x, y, s }，不用各自再乘一遍缩放。 */
    function leftFit() {
      var img = S.srcImg;
      if (!img) return null;
      var w = S.left.w, h = S.left.h;
      if (!w || !h) return null;
      var v = S.leftView || (S.leftView = { z: 1, ox: 0, oy: 0 });
      var iw = img.naturalWidth, ih = img.naturalHeight;
      var base = Math.min(w / iw, h / ih);
      var sc = base * v.z;
      var dw = iw * sc, dh = ih * sc;
      return { x: (w - dw) / 2 + v.ox, y: (h - dh) / 2 + v.oy, w: dw, h: dh, s: sc, z: v.z, base: base };
    }

    /* ---------------- 左栏视图：滚轮缩放 / 拖动平移 ----------------
     * 目的是「贴近看细节」：UV 岛在原画上只占一小块时，1:1 的 contain 视图
     * 连边缘都看不清，落点全凭猜。 */
    var LEFT_ZMAX = 16;

    /* 滚轮增量 → 倍率。不能像以前那样「一格固定 1.16」：
     * 真鼠标一次 deltaY 常是 ±120/±240，而触控板是 ±1~±5，
     * 同一个常数在触控板上过猛、在鼠标上像卡住。这里按增量连续换算。 */
    function wheelFactor(e) {
      var d = e.deltaY || 0;
      if (e.deltaMode === 1) d *= 16;        /* 按行 */
      else if (e.deltaMode === 2) d *= 400;  /* 按页 */
      var k = Math.exp(-d * 0.0016);
      return Math.max(1 / 2, Math.min(2, k));
    }

    /* 平移约束：原画至少留 60px 在视野内。能拖到边缘看，但不会把图拖丢
     * （拖丢之后既没滚轮方向感也没快捷键，只能关窗重开）。 */
    function leftViewClamp() {
      var img = S.srcImg, v = S.leftView;
      if (!img || !v || !S.left.w || !S.left.h) return;
      var base = Math.min(S.left.w / img.naturalWidth, S.left.h / img.naturalHeight);
      var sc = base * v.z;
      var dw = img.naturalWidth * sc, dh = img.naturalHeight * sc;
      var cx = (S.left.w - dw) / 2, cy = (S.left.h - dh) / 2;
      var x = Math.min(S.left.w - 60, Math.max(60 - dw, cx + v.ox));
      var y = Math.min(S.left.h - 60, Math.max(60 - dh, cy + v.oy));
      v.ox = x - cx;
      v.oy = y - cy;
    }

    function leftResetView() {
      S.leftView = { z: 1, ox: 0, oy: 0 };
      updateZoomHint();
      requestDraw();
    }

    /* 以画布上某点为中心缩放：该点下的原图像素必须钉在原地，
     * 否则「想放大看这里」会变成「放大之后这里跑掉了」。 */
    function leftZoomAt(p, factor) {
      var fit = leftFit();
      if (!fit) return;
      var u = (p.x - fit.x) / fit.s, v2 = (p.y - fit.y) / fit.s;
      var v = S.leftView;
      var nz = Math.max(1, Math.min(LEFT_ZMAX, v.z * factor));
      if (Math.abs(nz - v.z) < 1e-4) return;
      var img = S.srcImg;
      var base = Math.min(S.left.w / img.naturalWidth, S.left.h / img.naturalHeight);
      var sc = base * nz;
      v.z = nz;
      v.ox = p.x - u * sc - (S.left.w - img.naturalWidth * sc) / 2;
      v.oy = p.y - v2 * sc - (S.left.h - img.naturalHeight * sc) / 2;
      leftViewClamp();
      updateZoomHint();
      requestDraw();
    }

    function updateZoomHint() {
      var el = $('mdPbZoomHint');
      if (!el) return;
      el.hidden = !S.srcImg;
      if (!S.srcImg) return;
      var z = (S.leftView && S.leftView.z) || 1;
      var txt = z > 1.005
        ? '放大 ' + Math.round(z * 100) + '% · 拖空白平移 · 双击复位'
        : '滚轮缩放 · 拖角点改大小 · 右键解除';
      if (el.textContent !== txt) el.textContent = txt;
    }

    /* ---------------- 画布尺寸 ---------------- */
    function resizeCanvas(canvas, store, force) {
      if (!canvas) return;
      var w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
      if (!force && w === store.w && h === store.h) return;
      var dpr = Math.min(2, global.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      store.w = w; store.h = h; store.dpr = dpr;
      var c2 = canvas.getContext('2d');
      if (c2) c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /* ---------------- 绘制：右栏（当前视角 + 岛边界） ---------------- */
    function drawRight() {
      var cv = $('mdPbRight');
      if (!cv) return;
      resizeCanvas(cv, S.rightV);
      var c2 = cv.getContext('2d');
      if (!c2) return;
      var s = rightSize();
      c2.save();
      c2.fillStyle = '#1c1c1c';
      c2.fillRect(0, 0, s.w, s.h);
      var f = camFit();
      if (S.camView && f.iw > 4) {
        c2.imageSmoothingEnabled = true;
        c2.drawImage(S.camView, f.x, f.y, f.w, f.h);
      }
      drawIslandEdges(c2, f);
      drawBindMarks(c2, f);
      var mark = (S.drag && S.drag.kind === 'pull') ? S.drag.islandId : (S.hover >= 0 ? S.hover : S.sel);
      /* 连选的其余成员先铺一层淡高亮：整组是一个整体，得看得见「都选了哪几块」。
       * 主选/悬停/拖动用强色盖在上面，避免分不清哪个是拖拽的基准。
       * 0.45 而不是更低：「淡」要是还能一眼数清是几块，太淡等于没画（鼠标必然停在
       * 某个岛上，那个岛会被强色盖掉，剩下几块全靠这一层）。
       * 拖动中用 drag.group 而不是 S.multi：Shift 拖一个**还没进组**的岛时，
       * 那个岛要到松手才真正加入（见 endPull），但拖动中它已经在整组里了。 */
      var grpHl = (S.drag && S.drag.kind === 'pull' && S.drag.group) ? S.drag.group : S.multi;
      if (grpHl.length > 1) {
        for (var mi = 0; mi < grpHl.length; mi++) {
          if (grpHl[mi] !== mark) islandHighlight(c2, f, grpHl[mi], false, 0.45);
        }
      }
      if (mark != null && mark >= 0) islandHighlight(c2, f, mark, !!(S.drag && S.drag.kind === 'pull'));
      c2.restore();
    }

    /* 已绑定的岛在画面中心打一个 ✓：重复投射时一眼能看出哪些已经投过 */
    function drawBindMarks(c2, f) {
      if (!st.mesh) return;
      c2.save();
      c2.font = '10px "Segoe UI","Microsoft YaHei UI",sans-serif';
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
      for (var i = 0; i < S.islands.length; i++) {
        var isl = S.islands[i];
        if (!S.binds[isl.id] || isl.slot !== S.slot) continue;
        var ctr = islandScrCenter(isl, f);
        if (!ctr) continue;
        c2.beginPath();
        c2.arc(ctr[0], ctr[1], 8, 0, Math.PI * 2);
        c2.fillStyle = 'rgba(24,120,84,.82)';
        c2.fill();
        c2.strokeStyle = '#7be0b0';
        c2.lineWidth = 1;
        c2.stroke();
        c2.fillStyle = '#d8fff0';
        c2.fillText('✓', ctr[0], ctr[1] + 0.5);
      }
      c2.restore();
    }

    /* 岛的**外轮廓**：岛内只被一个面用到的边（用顶点对判重）。
     * 不逐面描边：3 万面的模型会画出一片网格，看着像「满屏洞」。 */
    function islandOutline(isl) {
      var mesh = st.mesh;
      var key = mesh.version + ':' + isl.id;
      if (isl._olKey === key) return isl._ol;
      var cnt = Object.create(null);
      for (var i = 0; i < isl.faces.length; i++) {
        var f = isl.faces[i], s = mesh.faceOffsets[f], e = mesh.faceOffsets[f + 1], nv = e - s;
        for (var k = 0; k < nv; k++) {
          var c0 = s + k, c1 = s + ((k + 1) % nv);
          var a = mesh.faceIndices[c0], b = mesh.faceIndices[c1];
          var kk = Math.min(a, b) + '_' + Math.max(a, b);
          var rec = cnt[kk];
          if (!rec) cnt[kk] = { n: 1, a: a, b: b };
          else rec.n++;
        }
      }
      var out = [];
      for (var kx in cnt) if (cnt[kx].n === 1) out.push([cnt[kx].a, cnt[kx].b]);
      isl._olKey = key;
      isl._ol = out;
      return out;
    }

    /* 顶点 → 画面坐标（相机像素空间）。投影一次就够，轮廓坐标会在抓视角时缓存 */
    var _projV = null;
    function projCam(vi) {
      if (!_projV) _projV = new THREE.Vector3();
      var mesh = st.mesh, pos = mesh.positions;
      _projV.set(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
      _projV.applyMatrix4(st.pivot.matrixWorld).project(st.camera);
      return [(_projV.x * 0.5 + 0.5) * S.camW, (0.5 - _projV.y * 0.5) * S.camH];
    }
    function camToCanvas(p, f) { return [f.x + p[0] * f.k, f.y + p[1] * f.k]; }

    function drawIslandEdges(c2, f) {
      if (!st.mesh || !st.pivot || !S.islands.length || !S.camView) return;
      /* 岛一多（AI 图生 3D 常是「一个面一个碎岛」）就不要全画：
       * 那条满屏青线是「一堆洞」观感的主要来源。但一个都不画等于把
       * 「哪里能点」藏起来了，所以留「显著大岛」这条底线。 */
      var many = S.islands.length > 400;
      c2.beginPath();
      for (var i = 0; i < S.islands.length; i++) {
        var isl = S.islands[i];
        if (many && !isl._big && isl.id !== S.hover && isl.id !== S.sel
          && !selHas(isl.id) && !(S.drag && S.drag.islandId === isl.id)) continue;
        var segs = islandScreenSegs(isl);
        for (var j = 0; j < segs.length; j++) {
          /* 只画「这一段确实露在外面」的轮廓：查线段中点属于哪个岛。
           * 不查的话，转到背面/画外的轮廓会拉出一条条飘在人形外面的线，
           * 看着像「选中了看不见的岛」。 */
          if (idAtCam((segs[j][0] + segs[j][2]) / 2, (segs[j][1] + segs[j][3]) / 2) !== isl.id + 1) continue;
          var pa = camToCanvas([segs[j][0], segs[j][1]], f);
          var pb = camToCanvas([segs[j][2], segs[j][3]], f);
          c2.moveTo(pa[0], pa[1]);
          c2.lineTo(pb[0], pb[1]);
        }
      }
      c2.strokeStyle = 'rgba(120,214,236,.5)';
      c2.lineWidth = 1;
      c2.stroke();
    }

    /* 岛的轮廓线段（相机像素空间），按 camKey + 网格版本缓存：
     * 3 万面全量投影一次约 80ms，不能每帧重算（拖动时会卡）。 */
    function islandScreenSegs(isl) {
      var key = (S.camKey || 0) + ':' + st.mesh.version + ':' + isl.id;
      if (isl._scrKey === key) return isl._scr;
      var ol = islandOutline(isl), out = [];
      for (var j = 0; j < ol.length; j++) {
        var a = projCam(ol[j][0]), b = projCam(ol[j][1]);
        out.push([a[0], a[1], b[0], b[1]]);
      }
      isl._scrKey = key;
      isl._scr = out;
      return out;
    }

    /* 岛在画面上的一个代表点（画 ✓ 标记 / 当拖拽起点）。
     * 优先用**投影包围盒中心**：它和「拖到左栏时落点锚点」是同一个点，
     * 拖拽起点与落点框不会偏一截。碎岛（一个面一个岛）里包围盒中心可能落在
     * 空处（中心恰好不属于本岛），那就依次退回三角质心、轮廓端点平均。 */
    function islandScrCenter(isl, f) {
      var g = islandCamGeo(isl);
      if (g && g.box && idAtCam(g.box.cx, g.box.cy) === isl.id + 1) {
        return camToCanvas([g.box.cx, g.box.cy], f);
      }
      var i;
      if (g && g.tri && g.tri.length) {
        for (i = 0; i < g.tri.length; i += 10) {
          var tx = (g.tri[i] + g.tri[i + 2] + g.tri[i + 4]) / 3;
          var ty = (g.tri[i + 1] + g.tri[i + 3] + g.tri[i + 5]) / 3;
          /* 必须是「露在画面里」的那一块：被挡住的三角在 id 位图里不是本岛 */
          if (idAtCam(tx, ty) === isl.id + 1) return camToCanvas([tx, ty], f);
        }
      }
      var segs = islandScreenSegs(isl);
      var sx = 0, sy = 0, n = 0;
      for (i = 0; i < segs.length; i++) {
        sx += segs[i][0] + segs[i][2];
        sy += segs[i][1] + segs[i][3];
        n += 2;
      }
      if (!n) {
        var mesh = st.mesh;
        for (i = 0; i < isl.faces.length; i++) {
          var fs = mesh.faceOffsets[isl.faces[i]], fe = mesh.faceOffsets[isl.faces[i] + 1];
          for (var c = fs; c < fe; c++) {
            var q = projCam(mesh.faceIndices[c]);
            sx += q[0]; sy += q[1]; n++;
          }
        }
      }
      if (!n) return null;
      return camToCanvas([sx / n, sy / n], f);
    }

    /* 高亮 = 「这个 UV 岛在当前视角的那块面」整个亮起来。
     * 以前这里描的是 islandOutline（只被一个面用到的边）：
     *   ① 闭合网格（球体、人体）根本没有这种边 → 选中了什么都不亮；
     *   ② 碎岛（AI 图生 3D 常见「一个面一个岛」）只描出几条被遮挡判据筛剩的线段
     *      → 用户看到的是「一些断线」，不是岛。
     * 现在直接填充投影三角的并集（三角已在 islandCamGeo 里统一绕向，nonzero 不自相抵消）。
     * **只填充、不描边**：填充的边界就是形状本身，看得一清二楚；
     * 而描边无论走「三角并集 stroke」（会描出内部网格）还是走「法线采样外边界」
     * （id 位图有约 1px 栅格缝，会在岛内部冒出散落短线），都只会往干净的形状上加噪点。 */
    function islandHighlight(c2, f, islandId, pulling, alpha) {
      var isl = islandById(islandId);
      if (!isl || !st.mesh) return;
      var q = camPathOnRight(isl, f);
      if (!q) return;
      c2.save();
      c2.fillStyle = pulling ? 'rgba(255,207,134,.30)' : 'rgba(143,226,242,.26)';
      /* 连选里「不是主选」的那几块用同一个颜色、更淡：区分主次，但仍是同一族颜色，
       * 一眼能看出它们属于同一组。 */
      c2.globalAlpha = alpha == null ? 1 : alpha;
      c2.fill(q, 'nonzero');
      c2.restore();
    }

    /* ---------------- 岛的「当前视角形状」 ----------------
     * 绑定的语义是「相机画面里的这块形状 → 原画上的这个位置」，所以形状必须来自投影。
     * 以前拿 UV 角点当形状（uvToSrc + islandPathSrc），那是**平铺后的布局**：
     * 球体摊成一个长方形、立方体摊成 6 个互不相干的方块 —— 用户按住圆形的岛拖下来，
     * 落点框却画成一块长方形，贴回去当然对不上。
     * 这里把岛内所有三角形投影到相机像素空间，按 camKey + 网格版本缓存；
     * 预览、挖亮、烘焙三处共用同一份几何，形状和采样就不会各说各话。 */
    var _cgV = null;
    function islandCamGeo(isl) {
      var mesh = st.mesh;
      if (!mesh || !st.pivot || !S.camW || !S.camH) return null;
      /* 缓存键要带上「id 位图在不在」：遮挡剔除靠它，第一次算的时候位图可能还没建好，
       * 那时候只能当「全都露着」；位图一到必须重算，否则「被挡的那半张脸」永远不生效。 */
      var key = (S.camKey || 0) + ':' + mesh.version + ':' + isl.id + ':' + (S.idMap ? 1 : 0);
      if (isl._cgKey === key) return isl._cg;
      if (!_cgV) _cgV = new THREE.Vector3();
      var cw = S.camW, ch = S.camH;
      var pos = mesh.positions, off = mesh.faceOffsets, idx = mesh.faceIndices;
      var tri = [], cs = [], sb = [], k;
      /* 深度桶的归一化范围必须和 id 位图**用同一份**（它存在 S.idMap 上），
       * 否则「我自己画上去的桶」和「我这块三角的桶」不是一个刻度，判定全错。 */
      var zr = S.idMap;
      var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (var fi = 0; fi < isl.faces.length; fi++) {
        var f = isl.faces[fi], s0 = off[f], e0 = off[f + 1];
        if (e0 - s0 < 3) continue;
        cs.length = 0;
        var dz = 0;
        for (k = s0; k < e0; k++) {
          var vi = idx[k];
          _cgV.set(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
          _cgV.applyMatrix4(st.pivot.matrixWorld).project(st.camera);
          cs.push((_cgV.x * 0.5 + 0.5) * cw, (0.5 - _cgV.y * 0.5) * ch);
          dz += _cgV.z;
        }
        /* 面中心深度：烘焙必须**从远到近**画，正面才会盖住背面（与 id 位图同一口径） */
        var d = dz / (e0 - s0);
        /* 这个面在 id 位图里被涂上的是哪个深度桶 —— 和 buildIdMap 的算法逐字一致
         * （同一个面平均 z、同一份 z0/z1）。一致是硬要求：同一条面自己画上去的桶
         * 必须**等于**自己的桶，否则它会把自己判成「被挡住」。 */
        var fb = zr ? depthBucket(d, zr.z0, zr.z1) : 200;
        for (k = 2; k < cs.length; k += 2) {
          var ax = cs[0], ay = cs[1];
          var bxx = cs[k - 2], byy = cs[k - 1];
          var cxx = cs[k], cyy = cs[k + 1];
          var j1 = s0 + k / 2 - 1, j2 = s0 + k / 2;
          /* **统一绕向**：投影后正反面的绕向会相反，而高亮要用并集 path 做 nonzero 填充 ——
           * 绕向一正一反，重叠处 winding 相加归零，整块就被「抵消成空」，
           * 球体只剩一圈边（看起来还是断线）。交换 b/c 时角索引必须一起换，
           * 否则下面烘焙的三点仿射会把两个角的 UV 张冠李戴。 */
          if ((bxx - ax) * (cyy - ay) - (cxx - ax) * (byy - ay) < 0) {
            var sw = bxx; bxx = cxx; cxx = sw;
            sw = byy; byy = cyy; cyy = sw;
            sw = j1; j1 = j2; j2 = sw;
          }
          /* [ax,ay,bx,by,cx,cy, 角0, 角1, 角2, 深度] —— 平面数组，几万三角也不吃内存 */
          tri.push(ax, ay, bxx, byy, cxx, cyy, s0, j1, j2, d);
          sb.push(fb);
          if (ax < bx0) bx0 = ax; if (ax > bx1) bx1 = ax;
          if (bxx < bx0) bx0 = bxx; if (bxx > bx1) bx1 = bxx;
          if (cxx < bx0) bx0 = cxx; if (cxx > bx1) bx1 = cxx;
          if (ay < by0) by0 = ay; if (ay > by1) by1 = ay;
          if (byy < by0) by0 = byy; if (byy > by1) by1 = byy;
          if (cyy < by0) by0 = cyy; if (cyy > by1) by1 = cyy;
        }
      }
      var geo = { key: key, tri: tri, order: null, box: null, sb: sb.length ? new Uint8Array(sb) : null };
      if (tri.length) {
        var order = [];
        for (k = 0; k < tri.length; k += 10) order.push(k);
        order.sort(function (a2, b2) { return tri[b2 + 9] - tri[a2 + 9]; });
        geo.order = order;
        geo.box = {
          x0: bx0, y0: by0, x1: bx1, y1: by1,
          cx: (bx0 + bx1) / 2, cy: (by0 + by1) / 2,
          w: Math.max(1e-6, bx1 - bx0), h: Math.max(1e-6, by1 - by0)
        };
        /* 遮挡剔除：被别的岛 / 被同岛的近三角盖住的部分不算进形状（见 islandVis）。
         * 返回 null 表示「全都露着」——和没有这个功能时完全一样，下游不用分情况。 */
        geo.vis = OCC_ON ? islandVis(isl, geo) : null;
        geo.visTotal = tri.length / 10;
        geo.visN = geo.vis ? countOn(geo.vis) : geo.visTotal;
      }
      isl._cgKey = key;
      isl._cg = geo;
      isl._cgPath = null;
      return geo;
    }

    /* ---------------- 遮挡剔除：只留「露在外面的三角形」 ----------------
     * 落点形状 / 挖亮 / 烘焙必须只算**看得见的那部分岛**。
     * 以前 islandCamPath 把岛内所有三角无条件并起来，于是被鼻子挡住的那半张脸
     * 落点照样是完整一块；烘焙时那半块采到的是**鼻子的像素**，贴回脸上就是一片
     * 错位的色块 —— 用户的原话是「不要一个完整的 uv 岛」。
     *
     * 判据 = **深度**，不是「这个像素属于哪个岛」：
     *   S.idMap 的 R 通道装的是深度桶（128 最近 … 255 最远），而 id 位图本来就是
     *   按面深度从远到近画的（近的盖远的），所以「读回来的桶明显比我近」就等于
     *   「我在这儿被人挡住了」。跨岛和同岛**同一套判据**：球体/身体那种
     *   「一个岛包住整个模型」，前后都是本岛，靠 id 是分不出来的，靠深度就分得出。
     *
     * 为什么不用 id 比对（试过，被真机否掉）：实测这颗 GLB 是 543 岛、每岛上千三角，
     * 一个三角不到一个像素 —— 内部采样点全落在抗锯齿混色的像素上，读回来的 id
     * 既不是自己也不是邻居，91~97% 的三角被误判成「被挡住」，形状直接碎成噪点。
     * 深度没有这个毛病：像素最后留下的是**最近的**那个面，谁近谁的值，与分辨率无关。
     *
     * 采样点取三角内部的 4 个重心坐标点；判据是「4 个点里至少 2 个没被更近的面盖住」，
     * 单点噪声（正好压在栅格缝上）不会把一个三角判死。
     */
    var VIS_PTS = [
      [1 / 3, 1 / 3, 1 / 3], [0.5, 0.25, 0.25],
      [0.25, 0.5, 0.25], [0.25, 0.25, 0.5]
    ];
    /* 差几个深度桶才算「真的挡住」。同一个面自己画上去的桶和它自己的桶**完全相等**
     * （见 below：两边用的是同一份「面平均 z → 桶」），所以这里只需要兜住
     * 抗锯齿混色的那点偏移；调大 = 更保守（少剔除），调小 = 更容易在缝上误剔。 */
    var VIS_EPS = 2;
    /* 遮挡剔除总开关。真源是 true；留 `__occCull(false)` 是为了 A/B 量具
     * （同一个视角比「完整 uv 岛」和「只算露着的」的落点面积 / 烘焙像素数），
     * 也方便万一某个网格判错时先关掉再排查。 */
    var OCC_ON = true;

    function countOn(arr) {
      var n = 0;
      for (var i = 0; i < arr.length; i++) if (arr[i]) n++;
      return n;
    }

    /* 返回 null = 全都露着（= 没有剔除，和旧行为一条代码都不差）；
     * 返回 Uint8Array（每三角 1 个）= 1 露着 / 0 被挡住。
     * 顺手在 geo.visOther 上记「被**别的岛**挡掉几个三角」：探针要靠它找到
     * 用户报的那种情形（鼻子挡住半张脸），而不是从「被自己挡住」的岛里去猜
     * —— 后者并集不变，量不出面积差。 */
    function islandVis(isl, geo) {
      var M = S.idMap;
      if (!M || !M.zok || !geo || !geo.tri || !geo.sb || !geo.tri.length) return null;
      if (!ensureIdData(M)) return null;
      var t = geo.tri, sb = geo.sb, d = M.data, n = geo.tri.length / 10;
      var vis = new Uint8Array(n), shown = 0, byOther = 0, mine = isl.id + 1;
      for (var i = 0; i < n; i++) {
        var ti = i * 10, lim = sb[i] - VIS_EPS, ok = 0, cutO = 0;
        for (var p = 0; p < 4; p++) {
          var wp = VIS_PTS[p];
          var px = t[ti] * wp[0] + t[ti + 2] * wp[1] + t[ti + 4] * wp[2];
          var py = t[ti + 1] * wp[0] + t[ti + 3] * wp[1] + t[ti + 5] * wp[2];
          var mx = Math.round(px * M.kx), my = Math.round(py * M.ky);
          if (mx < 0 || my < 0 || mx >= M.w || my >= M.h) { ok++; continue; }
          var o = (my * M.w + mx) * 4;
          /* R < 120 = 这个像素没东西（画外 / 栅格缝）：不算被挡；
           * R >= lim = 没有比我更近的面：露着。 */
          if (d[o] < 120 || d[o] >= lim) ok++;
          else if ((d[o + 1] | (d[o + 2] << 8)) !== mine) cutO++;
        }
        if (ok >= 2) { vis[i] = 1; shown++; }
        else if (cutO >= 2) byOther++;
      }
      geo.visOther = byOther;
      /* 整个岛都被挡住 / 全都露着 → 返回 null：
       *   前者是「拖了半天什么都没出现」，比给出完整形状更让人懵；
       *   后者省掉下游每帧的数组查表，也让「没有遮挡的模型」保持旧行为一条代码不变。 */
      if (!shown || shown === n) return null;
      return vis;
    }

    /* 岛在相机像素空间的 Path2D（所有**露着**的三角形并起来）。填充起来就是
     * 「所见形状」，不需要挑轮廓边 —— 闭合网格（球/人体）根本没有「只被一个面用到的边」。 */
    function islandCamPath(isl, geo) {
      var g = geo || islandCamGeo(isl);
      if (!g || !g.tri.length) return null;
      if (isl._cgPath) return isl._cgPath;
      var p = new Path2D(), t = g.tri, vis = g.vis;
      for (var i = 0, k = 0; i < t.length; i += 10, k++) {
        if (vis && !vis[k]) continue;
        p.moveTo(t[i], t[i + 1]);
        p.lineTo(t[i + 2], t[i + 3]);
        p.lineTo(t[i + 4], t[i + 5]);
        p.closePath();
      }
      isl._cgPath = p;
      return p;
    }

    /* 岛形状 → 左栏画布坐标的 Path2D。bind.s = 原画像素 / 相机像素，
     * 锚点是岛在当前视角下的包围盒中心（拖到哪、中心就在哪）。 */
    function camPathIn(isl, bind, fit) {
      var g = islandCamGeo(isl);
      var p = g && islandCamPath(isl, g);
      if (!p || !g.box) return null;
      var k = bind.s * fit.s;
      var tx = fit.x + (bind.cx - g.box.cx * bind.s) * fit.s;
      var ty = fit.y + (bind.cy - g.box.cy * bind.s) * fit.s;
      var q = new Path2D();
      q.addPath(p, new DOMMatrix([k, 0, 0, k, tx, ty]));
      return q;
    }

    /* 同上，但返回画布上的包围盒（画虚框 / 角点 / 命中判定用）。
     * 推导要和 camPathIn 严格一致：bind.cx 是**包围盒中心**落在原画上的位置，
     * 所以左边界 = 中心 - 半个宽。写成 (b.cx - b.w/2) 就多减了一个 b.cx ——
     * 症状是虚框整体偏左上（偏移量 = 包围盒中心在相机画面里的坐标 × s），
     * 而且左栏命中初筛永远落空（拖动绑定框完全没反应）。 */
    function camBoxIn(isl, bind, fit) {
      var g = islandCamGeo(isl);
      if (!g || !g.box) return null;
      var b = g.box, k = bind.s * fit.s;
      return {
        x: fit.x + (bind.cx - (b.w / 2) * bind.s) * fit.s,
        y: fit.y + (bind.cy - (b.h / 2) * bind.s) * fit.s,
        w: b.w * k,
        h: b.h * k
      };
    }

    /* 说明：这里曾经有 islandCamBorder / camSegsIn（靠 id 位图沿法线采样求「外边界」）。
     * 左栏现在不描形状边了：有原画时「挖亮」的亮/暗交界就是边界，没原画时用淡色填充。
     * 那条采样路在自己身上漏短虚线（球体/人体上尤其明显），放大看细节时是噪音。 */

    /* 同上，但落到**右栏（当前视角画面）**：右栏 f = { x, y, k }，相机像素 → 画布 CSS。
     * 按 f 缓存，hover 每帧都会重绘，几万三角的 addPath 不能白做。 */
    function camPathOnRight(isl, f) {
      var g = islandCamGeo(isl);
      var p = g && islandCamPath(isl, g);
      if (!p) return null;
      /* 缓存键必须带上几何版本：只比 f 的话，相机一转（camKey 变）就会继续用旧 path */
      var key = g.key + '|' + f.x + ':' + f.y + ':' + f.k;
      if (isl._cgRKey === key && isl._cgR) return isl._cgR;
      var q = new Path2D();
      q.addPath(p, new DOMMatrix([f.k, 0, 0, f.k, f.x, f.y]));
      isl._cgRKey = key;
      isl._cgR = q;
      return q;
    }

    /* ---------------- 图层 ----------------
     * 「层」不是另存一份像素，而是 (岛形状 + 原画 + 落位) 的一个引用：
     * 内容永远跟着原画走，换原画 → 所有层一起变。这样做的好处是只有一个真源
     * （S.binds），图层开关（on/op）只影响「画不画」和「烘不烘」，不会出现
     * 「面板里调了、画布上没动」这种两份状态打架的事。
     */
    var LAYER_DIM = 0.52;       /* 不会被烘焙的区域压多暗（0 = 不压，1 = 全黑） */
    var LAYER_DIM_BASE_OFF = 0.86;

    var LY_EYE_ON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
      + '<path d="M1.4 8S4 3.7 8 3.7 14.6 8 14.6 8 12 12.3 8 12.3 1.4 8 1.4 8Z" fill="none" stroke="currentColor" stroke-width="1.3"/>'
      + '<circle cx="8" cy="8" r="2.1" fill="currentColor"/></svg>';
    var LY_EYE_OFF = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
      + '<path d="M1.4 8S4 3.7 8 3.7c1.2 0 2.3.4 3.2.9M14.6 8S12 12.3 8 12.3c-1.1 0-2.2-.3-3.1-.8" fill="none" stroke="currentColor" stroke-width="1.3"/>'
      + '<path d="M2.7 2.7 13.3 13.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

    function layerDefault(b) {
      if (!b) return null;
      if (b.on == null) b.on = true;
      if (b.op == null) b.op = 1;
      return b;
    }

    /* 把 S.binds 和 S.layerOrder 对齐。任何一条路径（拖岛、面板、测试钩 __bind）
     * 只要写了 binds，就自动成为一层 —— 否则会出现「绑了但图层面板里没有」的幽灵层。
     * 顺序规则：order 里已有的保持原序，缺的按岛顺序补到末尾（= 最上层）。 */
    function layerSync() {
      var i, out = [], used = Object.create(null), id;
      for (i = 0; i < S.layerOrder.length; i++) {
        id = Number(S.layerOrder[i]);
        if (!S.binds[id] || used[id]) continue;
        used[id] = 1;
        layerDefault(S.binds[id]);
        out.push(id);
      }
      for (i = 0; i < S.islands.length; i++) {
        id = S.islands[i].id;
        if (S.binds[id] && !used[id]) {
          used[id] = 1;
          layerDefault(S.binds[id]);
          out.push(id);
        }
      }
      /* binds 里可能还有不在 islands 上的（UV 重建前后留下的）：保留，别静默丢绑定 */
      for (var kk in S.binds) {
        id = Number(kk);
        if (!used[id]) {
          used[id] = 1;
          layerDefault(S.binds[id]);
          out.push(id);
        }
      }
      S.layerOrder = out;
      return out;
    }

    /* 可见的层（会被画、也会被烘焙）。
     * ⚠ 这里**不调 layerSync**：它每帧都被 drawLeft 调一次，而 layerSync 要遍历
     * 全部岛（碎岛模型上千个）。对齐交给 refreshAll / binds 变化的那几处。 */
    function layerShown() {
      var out = [];
      for (var i = 0; i < S.layerOrder.length; i++) {
        var b = S.binds[S.layerOrder[i]];
        if (layerOn(b) && (b.op == null ? 1 : b.op) > 0.002) out.push(S.layerOrder[i]);
      }
      return out;
    }

    /* 「这一层会不会被画/被烘」。binds 里 on 缺省算 true（老状态 / __bind 建的）。 */
    function layerOn(b) { return !!b && b.on !== false; }

    function layerKeyName(key) {
      return key === 'base' ? '底图' : ('岛 ' + key);
    }

    function layerByKey(key) {
      if (key === 'base') return S.base;
      var id = Number(key);
      return isFinite(id) ? S.binds[id] : null;
    }

    /* 只读快照（调试 + 回归断言用） */
    function layerSnap() {
      layerSync();
      return {
        order: S.layerOrder.slice(),
        base: { on: S.base.on !== false, op: S.base.op == null ? 1 : S.base.op },
        items: S.layerOrder.map(function (id) {
          var b = S.binds[id] || {};
          return { id: id, on: b.on !== false, op: b.op == null ? 1 : b.op };
        }),
        open: !!S.lyOpen, sel: S.lySel
      };
    }

    /* ---------------- 绘制：左栏（原画 + 绑定框） ---------------- */
    function drawLeft() {
      var cv = $('mdPbLeft');
      if (!cv) return;
      resizeCanvas(cv, S.left);
      var c2 = cv.getContext('2d');
      if (!c2) return;
      /* 窗口/分隔条改尺寸后原画可视区域变了：平移量要跟着夹一次，
       * 否则会停在「图几乎全在画布外」的位置 */
      leftViewClamp();
      updateZoomHint();
      var w = S.left.w, h = S.left.h;
      c2.save();
      c2.fillStyle = '#1b1b1b';
      c2.fillRect(0, 0, w, h);

      var fit = leftFit();
      if (fit && (S.baseImg || S.srcImg)) {
        c2.imageSmoothingEnabled = true;
        var picking = !!(S.drag && S.drag.kind === 'pull' && S.drag.overLeft && S.srcImg);
        /* 拖岛进来 = 正在「选材」：这时左栏必须显示**原画本身**，
         * 否则用户看不到该从哪块取（素材全貌只在这一刻有用）。
         * 松手立刻回到合成视图 —— 也就是烘焙后会得到的样子。
         * viewSrc 是同一件事的手动版本：刚上传完原画、还没有任何层时，
         * 画布上必须有东西可看（见 S.viewSrc 的说明）。 */
        var underSrc = picking || (S.viewSrc && !!S.srcImg);
        if (underSrc) {
          c2.drawImage(S.srcImg, fit.x, fit.y, fit.w, fit.h);
        } else if (S.base.on !== false) {
          if (S.baseImg) {
            /* 底图层（模型当前这一槽的贴图）。隐藏它只是「不显示」，
             * 烘焙后没被层覆盖的地方仍然是它 —— 见 bake() 里的说明。 */
            c2.globalAlpha = S.base.op == null ? 1 : S.base.op;
            c2.drawImage(S.baseImg, fit.x, fit.y, fit.w, fit.h);
            c2.globalAlpha = 1;
          } else {
            /* 模型这一槽没贴图：底就是槽位底色，不能拿原画兜底 ——
             * 兜了的话「半透明层」会盖在同一张原画上，看起来还是完全不透明。 */
            c2.fillStyle = slotColorOf(S.slot);
            c2.fillRect(fit.x, fit.y, fit.w, fit.h);
          }
        }
        /* 「这次烘焙不会动的地方」压暗：没绑定的岛、被隐藏的层、op 太低的层。
         * 有原画时靠亮/暗交界就把「层」这件事直接画出来了，比图层面板还直观。
         * 选材（picking）时也照压：底图这时是原画全图，压暗之后
         * 「已有层 + 落点框」才是亮的 —— 一眼就看得出哪块会被取走。 */
        var shown = layerShown();
        var pend = (S.drag && S.drag.kind === 'pull' && S.drag.pend && S.drag.overLeft) ? S.drag : null;
        /* 整片压暗只在「底图关掉了、画的又不是原画」时才做：看着原画还压一层暗罩，
         * 用户会以为上传的图本身是灰的。 */
        var dimAll = (S.base.on === false && !underSrc);
        if (shown.length || pend || dimAll) {
          c2.save();
          c2.fillStyle = 'rgba(8,9,11,' + (dimAll ? LAYER_DIM_BASE_OFF : LAYER_DIM) + ')';
          c2.fillRect(fit.x, fit.y, fit.w, fit.h);
          c2.restore();
          for (var i = 0; i < shown.length; i++) {
            var lid = shown[i];
            punchIsland(c2, islandById(lid), S.binds[lid], fit, underSrc);
          }
          if (pend) {
            /* 连选时整组的落点都要挖亮：只挖基准那块，用户会以为别的岛没在拖 */
            var pl = pend.pendList && pend.pendList.length
              ? pend.pendList
              : [{ id: pend.islandId, cx: pend.pend.cx, cy: pend.pend.cy, s: pend.pend.s }];
            for (var pi = 0; pi < pl.length; pi++) {
              var pil = islandById(pl[pi].id);
              if (pil) punchIsland(c2, pil, { cx: pl[pi].cx, cy: pl[pi].cy, s: pl[pi].s }, fit, underSrc);
            }
          }
        }
        c2.strokeStyle = 'rgba(255,255,255,.14)';
        c2.lineWidth = 1;
        c2.strokeRect(fit.x + .5, fit.y + .5, fit.w - 1, fit.h - 1);
      }
      if (fit) drawBindBoxes(c2, fit);

      /* 拖动中的落点框（连选时整组都画） */
      if (S.drag && S.drag.kind === 'pull' && S.drag.pend && fit) {
        var pendL = (S.drag.pendList && S.drag.pendList.length)
          ? S.drag.pendList
          : [{ id: S.drag.islandId, cx: S.drag.pend.cx, cy: S.drag.pend.cy, s: S.drag.pend.s }];
        drawPendingBox(c2, fit, pendL, S.drag.islandId);
      }
      c2.restore();
      var empty = $('mdPbLeftEmpty');
      if (empty) empty.hidden = !!S.srcImg;
    }

    /* 把一层「贴」到左栏：clip 到「当前视角看到的形状」再画原画。
     * op < 1 时先按 base.op 把底图补回来（抵消上面的压暗），再用 op 叠原画 ——
     * 这样看到的混合比例与烘焙时完全一致（烘焙是 globalAlpha 叠在贴图工作区上，
     * 工作区里的原内容就是旧贴图）。只压一次不补底图的话，半透明层会显出灰色，
     * 用户会以为「调了不透明度图变脏了」。 */
    function punchIsland(c2, isl, bind, fit, underSrc) {
      if (!isl || !bind || !S.srcImg) return;
      var q = camPathIn(isl, bind, fit);
      if (!q) return;
      var op = bind.op == null ? 1 : bind.op;
      if (!(op > 0.002)) return;
      c2.save();
      c2.clip(q);
      /* 先把底图补回来（抵消上面的压暗）：层的半透明度是相对**底图**的，
       * 不补底图就会相对「暗罩」混合，看起来像图变脏了。
       * 底图不存在时补槽位底色 —— 必须和 ensureTarget 打底同色。
       * 左栏画的是原画（选材 / 看原画）时补的也必须是原画，
       * 否则半透明层会露出底图那块，两种图叠在一起像脏了。 */
      if (op < 0.998 && S.base.on !== false) {
        c2.globalAlpha = 1;
        if (underSrc) {
          c2.drawImage(S.srcImg, fit.x, fit.y, fit.w, fit.h);
        } else if (S.baseImg) {
          c2.globalAlpha = S.base.op == null ? 1 : S.base.op;
          c2.drawImage(S.baseImg, fit.x, fit.y, fit.w, fit.h);
        } else {
          c2.fillStyle = slotColorOf(S.slot);
          c2.fillRect(fit.x, fit.y, fit.w, fit.h);
        }
      }
      c2.globalAlpha = op;
      c2.drawImage(S.srcImg, fit.x, fit.y, fit.w, fit.h);
      c2.restore();
    }

    function drawBindBoxes(c2, fit) {
      if (!st.mesh) return;
      c2.save();
      for (var i = 0; i < S.islands.length; i++) {
        var isl = S.islands[i];
        var bind = S.binds[isl.id];
        if (!bind) continue;
        /* 关掉的层不画框：它的内容根本不可见（那块是压暗的），
         * 画个框等于告诉用户「这里有一块东西」，点下去却没反应。 */
        if (!layerOn(bind)) continue;
        var r = camBoxIn(isl, bind, fit);
        if (!r) continue;
        var on = (S.sel === isl.id);
        /* 连选的其余成员：框染成青色，交代「它们会和主选一起被拖动」 */
        var inGrp = !on && S.multi.length > 1 && selHas(isl.id);
        /* 形状边界**不靠描边**表达，两条路都试过了：
         *   ① stroke 三角并集 → 内部三角边全被描出来，一片网格；
         *   ② 靠 id 位图算法线找外边界 → 球体/人体上会在形状内部漏出几条短虚线，
         *      1 倍看不出来，滚轮放大看细节时非常显眼（用户已经把它报成「断线」）。
         * 现在靠「挖亮」自己说明形状（亮/暗交界就是边界），这里只画包围盒：
         * 选中 = 虚框 + 八个把手，其余 = 一根淡线，用来交代「这里已经绑过」。 */
        c2.strokeStyle = on ? 'rgba(255,207,134,.62)'
          : (inGrp ? 'rgba(143,226,242,.6)' : 'rgba(120,214,236,.3)');
        c2.lineWidth = 1;
        if (on) c2.setLineDash([4, 3]);
        c2.strokeRect(r.x, r.y, r.w, r.h);
        c2.setLineDash([]);
        /* 把手只画在主选上：角点缩放目前是「单个岛改大小」，
         * 组里每个都画 8 个把手，会让人以为哪一个都能单独缩。 */
        if (on) drawHandles(c2, r);
      }
      c2.restore();
    }

    /* 四角 + 四边中点把手（PS 变换框那套）。只画在选中的岛上：
     * 它们既是「改大小」的抓手，也是「这里能拖」的提示。 */
    function drawHandles(c2, r) {
      var pts = [
        [r.x, r.y], [r.x + r.w / 2, r.y], [r.x + r.w, r.y],
        [r.x + r.w, r.y + r.h / 2], [r.x + r.w, r.y + r.h],
        [r.x + r.w / 2, r.y + r.h], [r.x, r.y + r.h], [r.x, r.y + r.h / 2]
      ];
      c2.save();
      for (var i = 0; i < pts.length; i++) {
        var corner = (i % 2 === 0), s = corner ? 7 : 6;
        c2.fillStyle = corner ? '#ffcf86' : '#ffe9cd';
        c2.fillRect(pts[i][0] - s / 2, pts[i][1] - s / 2, s, s);
        c2.strokeStyle = 'rgba(24,18,10,.9)';
        c2.lineWidth = 1;
        c2.strokeRect(pts[i][0] - s / 2 + .5, pts[i][1] - s / 2 + .5, s - 1, s - 1);
      }
      c2.restore();
    }

    /* 命中哪个把手（画布 CSS 坐标）。容差会随着框变小而收窄：
     * 框只有 20px 时，8px 的容差会把整个框吃掉 → 变成「只能改大小、不能移动」。 */
    function handleAt(isl, bind, fit, p) {
      var r = camBoxIn(isl, bind, fit);
      if (!r) return null;
      var tol = Math.min(8, Math.max(3, Math.min(r.w, r.h) * 0.3));
      var hs = [
        { sx: -1, sy: -1, cur: 'nwse-resize' },
        { sx: 0, sy: -1, cur: 'ns-resize' },
        { sx: 1, sy: -1, cur: 'nesw-resize' },
        { sx: 1, sy: 0, cur: 'ew-resize' },
        { sx: 1, sy: 1, cur: 'nwse-resize' },
        { sx: 0, sy: 1, cur: 'ns-resize' },
        { sx: -1, sy: 1, cur: 'nesw-resize' },
        { sx: -1, sy: 0, cur: 'ew-resize' }
      ];
      for (var i = 0; i < hs.length; i++) {
        var h = hs[i];
        var x = r.x + (h.sx + 1) / 2 * r.w, y = r.y + (h.sy + 1) / 2 * r.h;
        if (Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol) {
          return { sx: h.sx, sy: h.sy, cur: h.cur, x: x, y: y };
        }
      }
      return null;
    }

    /* 起手拖把手：把「锚点」钉在原图像素上。
     * 形状在相机像素空间里是绕包围盒中心缩放的（见 camPathIn），
     * 所以 bind.cx/cy 必须随 s 一起改，只改 s 框会漂走。 */
    function startScale(isl, bind, fit, hd, p) {
      var g = islandCamGeo(isl);
      if (!g || !g.box || !hd) return null;
      var b = g.box, r = camBoxIn(isl, bind, fit);
      if (!r) return null;
      var acx = b.cx - hd.sx * b.w / 2, acy = b.cy - hd.sy * b.h / 2;
      var maxDim = Math.max(b.w, b.h) || 1;
      return {
        kind: 'scale', islandId: isl.id, sx: hd.sx, sy: hd.sy,
        s0: bind.s,
        /* 锚点在原画上的位置：整个拖动过程中它一动不动 */
        aix: bind.cx + (acx - b.cx) * bind.s,
        aiy: bind.cy + (acy - b.cy) * bind.s,
        acx: acx, acy: acy, bcx: b.cx, bcy: b.cy,
        ax: hd.x, ay: hd.y,
        aax: r.x + (1 - hd.sx) / 2 * r.w,
        aay: r.y + (1 - hd.sy) / 2 * r.h,
        offx: p.x - hd.x, offy: p.y - hd.y,
        /* 最小尺寸按「投影最长边在画布上还剩 6px」算：
         * 写死一个 s 会在不同缩放级别下变成「拖不小 / 一拖就没了」 */
        minS: Math.max(0.005, 6 / (maxDim * fit.s))
      };
    }

    function moveScale(e) {
      var d = S.drag, lc = $('mdPbLeft');
      var bind = S.binds[d.islandId];
      var fit = leftFit();
      if (!bind || !fit || !lc) return;
      var p = localXY(e, lc);
      /* 按下点未必正好在把手中心：先把这段偏移扣掉，否则一按下去框会跳一下 */
      p.x -= d.offx; p.y -= d.offy;
      var vx = d.ax - d.aax, vy = d.ay - d.aay, t;
      if (!d.sx) t = Math.abs(vy) > 1e-6 ? (p.y - d.aay) / vy : 1;
      else if (!d.sy) t = Math.abs(vx) > 1e-6 ? (p.x - d.aax) / vx : 1;
      else {
        /* 角点：把指针投到「锚点→把手」这条对角线上，等比缩放才跟手 */
        var L2 = vx * vx + vy * vy;
        t = L2 > 1e-6 ? ((p.x - d.aax) * vx + (p.y - d.aay) * vy) / L2 : 1;
      }
      var ns = Math.max(d.minS, Math.min(60, d.s0 * t));
      bind.s = ns;
      bind.cx = d.aix - (d.acx - d.bcx) * ns;
      bind.cy = d.aiy - (d.acy - d.bcy) * ns;
      requestDraw();
    }

    function cornerDots(c2, rx, ry, rw, rh, color) {
      var hs = 5;
      c2.fillStyle = color;
      [[rx, ry], [rx + rw, ry], [rx, ry + rh], [rx + rw, ry + rh]].forEach(function (p) {
        c2.fillRect(p[0] - hs / 2, p[1] - hs / 2, hs, hs);
      });
    }

    /* 拖动中的落点框。连选时整组都画：每个成员一块形状填充 + 包围盒虚框，
     * 基准岛（手上拎着的那个）用满饱和颜色 + 四角把手点，其余略淡 ——
     * 一组碎岛拼在一起时，能一眼看出整组占多大、相对位置对不对。 */
    function drawPendingBox(c2, fit, list, baseId) {
      c2.save();
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var isl = islandById(it.id);
        if (!isl) continue;
        var bind = { cx: it.cx, cy: it.cy, s: it.s };
        var q = camPathIn(isl, bind, fit);
        var r = camBoxIn(isl, bind, fit);
        if (!q || !r) continue;
        var isBase = (it.id === baseId) || list.length === 1;
        /* 落点 = 「当前视角看到的形状」本身：填充把形状摊开，
         * 外边界就是填充的边缘（不再描边，理由同 drawBindBoxes：
         * 描边必然要么画出内部三角边，要么在形状里漏短虚线）。 */
        c2.save();
        c2.globalAlpha = isBase ? 1 : 0.72;
        c2.fillStyle = 'rgba(255,208,138,.24)';
        c2.fill(q);
        c2.strokeStyle = isBase ? '#ffd08a' : 'rgba(255,208,138,.66)';
        c2.lineWidth = 1.2;
        c2.setLineDash([6, 4]);
        c2.strokeRect(r.x, r.y, r.w, r.h);
        c2.setLineDash([]);
        if (isBase) cornerDots(c2, r.x, r.y, r.w, r.h, '#ffd08a');
        c2.restore();
      }
      c2.restore();
    }

    /* 岛与岛重叠检测。AI 图生 3D 偶尔会给出「每个面都铺满 0–1」的退化 UV：
     * 这时烘焙任意一个岛都会盖掉整张贴图（岛的 UV 范围就是全图），
     * 用户会以为「烘焙把图毁了」。这里只警告，不动 UV（改 UV 是 UV 编辑器的活）。 */
    function overlapPairs() {
      var n = S.islands.length, bad = 0;
      for (var i = 0; i < n; i++) {
        var a = S.islands[i].bounds;
        var areaA = Math.max(1e-9, a.w * a.h);
        for (var j = i + 1; j < n; j++) {
          var b = S.islands[j].bounds;
          var ix = Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0);
          var iy = Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0);
          if (ix <= 1e-6 || iy <= 1e-6) continue;
          var small = Math.min(areaA, Math.max(1e-9, b.w * b.h));
          if ((ix * iy) / small > 0.5) bad++;
        }
      }
      return bad;
    }

    /* ---------------- 图层面板 ----------------
     * 面板只是 S.binds / S.layerOrder 的一个视图：所有按钮改的都是那两份数据，
     * 改完重渲染。面板里不放任何独立的 cx/cy/op 副本。
     */
    function toggleLayerPanel(force) {
      S.lyOpen = (force == null) ? !S.lyOpen : !!force;
      var p = $('mdPbLayers'), b = $('mdPbLyBtn');
      if (p) p.hidden = !S.lyOpen;
      if (b) b.classList.toggle('on', S.lyOpen);
      if (S.lyOpen) renderLayers();
    }

    function renderLayers() {
      var list = $('mdPbLyList');
      if (!list) return;
      layerSync();
      var rows = [], i, id, b;
      /* 面板从上到下 = 最上层 → 最下层（与 PS 一致），所以倒着列 */
      for (i = S.layerOrder.length - 1; i >= 0; i--) {
        id = S.layerOrder[i];
        b = S.binds[id];
        if (!b) continue;
        rows.push(lyRowHtml(String(id), b, false));
      }
      rows.push(lyRowHtml('base', S.base, true));
      list.innerHTML = rows.join('');
      paintLayerThumbs();
      var cnt = $('mdPbLyCount');
      if (cnt) cnt.textContent = (S.layerOrder.length + 1) + ' 层';
      syncLayerOp();
      var foot = $('mdPbLyFoot');
      if (foot) foot.hidden = !S.lySel;
    }

    function lyRowHtml(key, b, isBase) {
      var on = b.on !== false;
      var op = b.op == null ? 1 : b.op;
      /* 连选成员也点亮：面板里得能看出「一起被拖走的到底是哪几层」 */
      var selRow = (S.lySel === key) || (!isBase && selHas(Number(key)));
      var cls = 'md-pb-ly' + (on ? '' : ' off') + (selRow ? ' on' : '');
      return '<div class="' + cls + '" data-ly="' + key + '">'
        + '<button type="button" class="md-pb-lyeye" data-lyact="eye" title="'
        + (on ? '隐藏这一层（烘焙时跳过它）' : '显示这一层') + '">'
        + (on ? LY_EYE_ON : LY_EYE_OFF) + '</button>'
        + '<canvas class="md-pb-lyth" width="26" height="26"></canvas>'
        + '<span class="md-pb-lynm">' + esc(isBase ? '模型贴图（底）' : ('岛 ' + key)) + '</span>'
        + (op < 0.995 ? '<em class="md-pb-lyop">' + Math.round(op * 100) + '%</em>' : '')
        + (isBase
          ? '<i class="md-pb-lylock" title="底图层不能删：没被层覆盖的区域烘焙后仍然是它">底</i>'
          : '<button type="button" class="md-pb-lydel" data-lyact="del" title="删除这一层（等于解除该岛绑定）">×</button>')
        + '</div>';
    }

    /* 缩略图：把这一层「形状内的原画」缩进 26×26。
     * camPathIn 的 fit 就传单位映射 {x:0,y:0,s:1} —— 这时它输出的路径本来就是
     * **原图像素坐标**，正好可以直接被 translate/scale 到缩略图上。 */
    function paintLayerThumbs() {
      var list = $('mdPbLyList');
      if (!list) return;
      var nodes = list.querySelectorAll('.md-pb-ly');
      for (var i = 0; i < nodes.length; i++) {
        var cvs = nodes[i].querySelector('.md-pb-lyth');
        if (!cvs) continue;
        var x = cvs.getContext('2d');
        if (!x) continue;
        x.clearRect(0, 0, cvs.width, cvs.height);
        var key = nodes[i].getAttribute('data-ly');
        if (key === 'base') {
          if (S.baseImg) x.drawImage(S.baseImg, 0, 0, cvs.width, cvs.height);
          else { x.fillStyle = slotColorOf(S.slot); x.fillRect(0, 0, cvs.width, cvs.height); }
          continue;
        }
        if (!S.srcImg) continue;
        var isl = islandById(Number(key));
        var b = isl && S.binds[isl.id];
        var g = isl && islandCamGeo(isl);
        if (!b || !g || !g.box) continue;
        var bw = Math.max(1e-6, g.box.w * b.s), bh = Math.max(1e-6, g.box.h * b.s);
        var k = Math.min(cvs.width / bw, cvs.height / bh);
        x.save();
        x.translate(cvs.width / 2, cvs.height / 2);
        x.scale(k, k);
        x.translate(-b.cx, -b.cy);
        var q = camPathIn(isl, b, { x: 0, y: 0, s: 1 });
        if (q) x.clip(q);
        x.globalAlpha = b.op == null ? 1 : b.op;
        x.drawImage(S.srcImg, 0, 0);
        x.restore();
      }
    }

    /* 点行 = 选中（幂等，不 toggle）：PS 里点已选中的层也不会取消选中，
     * 而 toggle 会让「刚调完不透明度、手一抖点了同一行」把滑块收走。 */
    function selectLayer(key) {
      S.lySel = key;
      if (key === 'base') selSet([]);
      else selSet([Number(key)]);
      syncInfo();
      renderLayers();
      requestDraw();
    }

    function toggleLayerVis(key) {
      var b = layerByKey(key);
      if (!b) return;
      b.on = (b.on === false);
      renderLayers();
      requestDraw();
      syncInfo();
      if (key !== 'base') {
        toast(b.on ? ('「岛 ' + key + '」已显示，会参与烘焙')
          : ('「岛 ' + key + '」已隐藏，烘焙时跳过（那块保持旧贴图）'));
      }
    }

    function removeLayer(key) {
      if (key === 'base') return;
      var id = Number(key);
      if (!S.binds[id]) return;
      delete S.binds[id];
      var i = S.layerOrder.indexOf(id);
      if (i >= 0) S.layerOrder.splice(i, 1);
      /* 删掉的是连选成员之一：只把它从集合里摘掉，别顺手清空整组 */
      if (selHas(id)) {
        var mi = S.multi.indexOf(id);
        if (mi >= 0) S.multi.splice(mi, 1);
        if (S.sel === id) S.sel = S.multi.length ? S.multi[S.multi.length - 1] : -1;
      }
      if (S.lySel === key) S.lySel = null;
      syncInfo();
      renderLayers();
      requestDraw();
      toast('已删除「岛 ' + id + '」这一层');
    }

    function syncLayerOp() {
      var inp = $('mdPbLyOp'), lab = $('mdPbLyOpVal'), foot = $('mdPbLyFoot');
      var b = S.lySel == null ? null : layerByKey(S.lySel);
      if (foot) foot.hidden = !b;
      if (!b) return;
      var op = b.op == null ? 1 : b.op;
      if (inp) inp.value = String(Math.round(op * 100));
      if (lab) lab.textContent = Math.round(op * 100) + '%';
    }

    /* 拖行排序：DOM 顺序 = 显示顺序（上 → 下），写完再把数组倒过来。
     * 底图层固定在最后，不参与排序（它是「没被覆盖的地方」，物理上就该垫底）。
     *
     * ⚠ 这里**不能 setPointerCapture**：一旦在 pointerdown 就捕获，随后派发的
     * click 的 target 会变成捕获元素，行的「点一下选中」就永远收不到
     * （症状：点眼睛好用、点行名没反应）。监听挂 document 即可，行拖不出面板。 */
    function layerDragStart(e, row) {
      var list = $('mdPbLyList');
      if (!list || !row || row.getAttribute('data-ly') === 'base') return false;
      var startY = e.clientY, moved = false;
      function mv(ev) {
        if (!moved) {
          if (Math.abs(ev.clientY - startY) < 4) return;
          moved = true;
          row.classList.add('dragging');
        }
        var rows = list.querySelectorAll('.md-pb-ly'), target = null, i;
        for (i = 0; i < rows.length; i++) {
          var r = rows[i].getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY <= r.bottom) { target = rows[i]; break; }
        }
        if (!target || target === row || target.getAttribute('data-ly') === 'base') return;
        var tr = target.getBoundingClientRect();
        /* 拖到某行下半部分就插到它后面（底图层永远在最末：插到 base 前面即可，
         * 以前这里直接 return，结果「往下拖到最后一个岛行」被无声吞掉）。 */
        if (ev.clientY > tr.top + tr.height / 2) list.insertBefore(row, target.nextSibling);
        else list.insertBefore(row, target);
      }
      function up() {
        document.removeEventListener('pointermove', mv);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        row.classList.remove('dragging');
        if (moved) layerOrderFromDom();
      }
      document.addEventListener('pointermove', mv);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
      return true;
    }

    function layerOrderFromDom() {
      var list = $('mdPbLyList');
      if (!list) return;
      var rows = list.querySelectorAll('.md-pb-ly'), out = [];
      for (var i = rows.length - 1; i >= 0; i--) {
        var k = rows[i].getAttribute('data-ly');
        if (k !== 'base') out.push(Number(k));
      }
      S.layerOrder = out;
      requestDraw();
      renderLayers();
    }

    /* 面板里的行坐标（测试用：拖排序要真实指针，得先知道行在哪） */
    function lyRowRect(key) {
      var list = $('mdPbLyList');
      if (!list) return null;
      var row = list.querySelector('.md-pb-ly[data-ly="' + key + '"]');
      if (!row) return null;
      var r = row.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }

    /* ---------------- 刷新 ---------------- */
    function requestDraw() {
      if (S.raf) return;
      S.raf = global.requestAnimationFrame(function () {
        S.raf = 0;
        drawLeft();
        drawRight();
      });
    }

    function syncInfo() {
      var el = $('mdPbViewInfo');
      if (el) el.textContent = S.camInfo || '';
      var st2 = $('mdPbStat');
      if (st2) {
        layerSync();
        var nAll = S.layerOrder.length, nHide = 0, li;
        for (li = 0; li < nAll; li++) if (S.binds[S.layerOrder[li]].on === false) nHide++;
        st2.textContent = nAll
          ? ('图层 ' + (nAll + 1) + ' 层' + (nHide ? ('（隐藏 ' + nHide + '）') : ''))
          : '只有底图';
      }
      var hint = $('mdPbHint');
      if (hint) {
        var pairs = S.overlapPairs || 0;
        var manyIslands = S.islands.length > 400;
        /* 「重建 UV」只在真需要时出现：正常模型不该多一个看不懂的按钮 */
        var rb = $('mdPbRebuild');
        if (rb) rb.hidden = !(manyIslands || pairs > 0);
        var text, warn = false;
        if (manyIslands) {
          text = '这个模型的 UV 碎成了 ' + S.islands.length + ' 个岛（差不多一个面一块），投射烘焙用不了：点「重建 UV」一键重投影';
          warn = true;
        } else if (pairs) {
          text = '检测到 ' + pairs + ' 对 UV 岛重叠（有的岛铺满整张 UV）：烘焙会覆盖同一块区域，先展开排布或点「重建 UV」';
          warn = true;
        } else if (S.autoFit) {
          text = '当前视角看不全这个对象，已自动对准（转视角后会跟着重抓）';
          warn = true;
        } else if (S.camCoverage != null && S.camCoverage < 0.15) {
          text = '对象在画面里偏小（占 ' + Math.round(S.camCoverage * 100) + '%），按 F 框显后再投射，采样会更清楚';
          warn = true;
        } else if (S.camClipped) {
          text = '对象有一部分在画面外，按 F 框显后再投射，否则缺掉的部分采不到色';
          warn = true;
        } else if (S.multi.length > 1) {
          /* 连选是隐藏操作：不写一行字，用户不知道能一次拖多个 */
          text = '已连选 ' + S.multi.length + ' 个岛：拖其中任意一个，整组一起落位（Shift+点可增减，右键整组删）';
        } else {
          text = '按住岛拖到左边：松手就多一层；Shift+点可连选多个，拖动中滚轮调大小，右键删层';
        }
        hint.textContent = text;
        hint.classList.toggle('warn', warn);
      }
      var tgt = $('mdPbTarget');
      if (tgt) tgt.textContent = (st.node && st.node.name) ? st.node.name : '';
      var nm = $('mdPbSrcName');
      if (nm) nm.textContent = S.srcImg ? (S.srcName + ' · ' + S.srcImg.naturalWidth + '×' + S.srcImg.naturalHeight) : '未载入';
      /* 「看原画 / 看合成」：只在有原画时出现。没有它，用户进到合成视图后
       * 就再也调不出原画全图（除非去拖一个岛），换素材时没法核对。 */
      var sv = $('mdPbSrcView');
      if (sv) {
        sv.hidden = !S.srcImg;
        sv.textContent = S.viewSrc ? '看合成' : '看原画';
        sv.classList.toggle('on', !!S.viewSrc);
      }
    }

    /* 对象在画面里占多大（用包围盒的投影面积比，不是数像素：
     * 白模的暗部在像素统计里会被当成「没有东西」，占比会被低估一半）。
     * clipped = 包围盒超出画面 → 有一部分采不到色。 */
    function objectScreenBox() {
      if (!st.pivot || !st.camera) return null;
      st.pivot.updateMatrixWorld(true);
      var box = new THREE.Box3().setFromObject(st.pivot);
      if (box.isEmpty()) return null;
      var min = box.min, max = box.max, v = new THREE.Vector3();
      var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, behind = false;
      for (var i = 0; i < 8; i++) {
        v.set((i & 1) ? max.x : min.x, (i & 2) ? max.y : min.y, (i & 4) ? max.z : min.z);
        v.project(st.camera);
        if (v.z > 1) behind = true;
        if (v.x < x0) x0 = v.x;
        if (v.x > x1) x1 = v.x;
        if (v.y < y0) y0 = v.y;
        if (v.y > y1) y1 = v.y;
      }
      if (!isFinite(x0)) return null;
      var w = Math.min(2, x1) - Math.max(-2, x0);
      var h = Math.min(2, y1) - Math.max(-2, y0);
      return {
        cover: Math.max(0, w / 2) * Math.max(0, h / 2),
        clipped: (x0 < -1 || x1 > 1 || y0 < -1 || y1 > 1),
        behind: behind
      };
    }

    /* 把当前对象框进画面，但**保持用户已经摆好的视角方向**（只改距离和 target）。
     * 为什么不用外壳的 frameCamera：那个会把相机摆到一个固定的斜 45°，
     * 而用户是特意「把摄像机转到正面」才来投射的，改方向等于把他的工作白做。 */
    function focusActive() {
      if (!st.pivot || !st.camera || !st.controls) return false;
      st.pivot.updateMatrixWorld(true);
      var box = new THREE.Box3().setFromObject(st.pivot);
      if (box.isEmpty()) return false;
      var sph = box.getBoundingSphere(new THREE.Sphere());
      if (!isFinite(sph.radius) || sph.radius <= 0) return false;
      var cam = st.camera, ctl = st.controls;
      var dir = new THREE.Vector3().subVectors(cam.position, ctl.target || sph.center).normalize();
      if (!isFinite(dir.x) || (dir.lengthSq() < 1e-9)) dir.set(0, 0, 1);
      var fov = (cam.fov || 45) * Math.PI / 180;
      var dist = sph.radius / Math.sin(fov / 2) * 1.12;
      ctl.target.copy(sph.center);
      cam.position.copy(sph.center).addScaledVector(dir, dist);
      cam.near = Math.max(sph.radius / 100, 0.001);
      cam.far = Math.max(sph.radius * 50, 100);
      cam.updateProjectionMatrix();
      if (ctl.update) ctl.update();
      return true;
    }

    function refreshAll(recapture) {
      if (!S.open) return;
      if (!meshReady()) return;
      buildIslands();
      /* 岛可能被重建（UV 编辑后 id 会变）：把 binds / layerOrder 对齐一次，
       * 之后的绘制循环就不用再算了。 */
      layerSync();
      /* 底图层跟着贴图走：烘焙/绘画改过这一槽之后 URL 会变，这里自动换掉。
       * URL 没变时是空转（第一行就 return）。 */
      loadBaseMap();
      if (recapture || S.camDirty || !S.camView) {
        S.camKey = (S.camKey || 0) + 1;
        S.camView = captureView();
        S.camDirty = false;
        /* 对象跑出画面（新建对象、或者用户拉远了）时必须先把镜头对准，
         * 否则右栏大片取不到色 —— 采样是按屏幕位置走的，出画的面只能拿到黑。 */
        S.autoFit = false;
        var sb0 = objectScreenBox();
        if (sb0) { S.camCoverage = sb0.cover; S.camClipped = sb0.clipped; }
        if (sb0 && (sb0.cover < 0.02 || sb0.behind) && focusActive()) {
          S.camView = captureView();
          var sb1 = objectScreenBox();
          if (sb1) { S.camCoverage = sb1.cover; S.camClipped = sb1.clipped; }
          S.autoFit = true;
        }
        /* 偷渲染过一帧：主视口必须重画，否则画面停在离屏那一帧 */
        paintAll();
      }
      /* 岛轮廓与 id 图都要用「当前抓到的这一帧」的相机参数，所以必须在 captureView 之后 */
      buildIdMap();
      S.overlapPairs = overlapPairs();
      drawLeft();
      drawRight();
      syncInfo();
      /* 岛/相机变了，缩略图也要跟着重画；但拖动中不能重建面板（会把正在按的行换掉） */
      if (S.lyOpen && !S.drag) renderLayers();
    }

    /* ---------------- 贴图工作区 / 提交 ---------------- */

    /* 一张图「真的是像素」吗：Image / Canvas / ImageBitmap 的宽高字段名不一样 */
    function imgPx(img) {
      if (!img) return 0;
      return (img.naturalWidth || img.width || 0);
    }

    /* 「模型这一槽现在挂着的贴图」唯一取法（底图与烘焙工作区共用）。
     * 三条来源按可信度排：
     *   ① S.baseImg —— loadBaseMap 已经解好的那张（同一 URL 才算数）
     *   ② sharedTexture(url).image —— 文档里的真源（slotMaps）
     *   ③ liveSlotImage(slot) —— 视口材质上实际挂着的 map
     *      （纹理混合 / 绘画 / 只有 material.map 的老资产，slotMaps 可能是空）
     * 三条都拿不到时**不能**当作「这一槽本来没贴图」：那会以槽位底色起画布，
     * 烘焙一写回整片贴图就没了。到底算不算「本来没贴图」，看 url 是否为空。 */
    /* 这一槽的底图。取法统一交给 TexSource（2026-11-11 调研）：
     * 以前这里自带一套「baseImg → sharedTexture → live」顺序，和绘画、混合、
     * UV 编辑器三处都不一样，于是同一个「拖岛→烘焙」在 slotMaps 空/非空时
     * 走向两个相反的错误。现在四个读者问同一处，from 仅用于观测与断言。 */
    function slotBaseImage() {
      var mats = (st.doc && st.doc.materials) || {};
      var url = (mats.slotMaps || [])[S.slot] || '';
      if (global.TexSource) {
        var r = global.TexSource.resolveBase(S.slot);
        return { url: url || r.url, img: r.img || null, from: r.from };
      }
      /* 降级（tex-source.js 没加载） */
      var img = null, from = '';
      if (url && S.baseImg && S.baseUrl === url && imgPx(S.baseImg)) { img = S.baseImg; from = 'base'; }
      if (!img && url && sharedTexture) {
        var tex = sharedTexture(url);
        if (tex && imgPx(tex.image)) { img = tex.image; from = 'slot'; }
      }
      if (!img && liveSlotImage) {
        var live = liveSlotImage(S.slot);
        if (imgPx(live)) { img = live; from = 'live'; }
      }
      return { url: url, img: img, from: from };
    }

    /* 这一批投射产出的增量图尺寸：跟着底座走（只缩不放大），没底座就用下限档。
     * 尺寸与底座不同不是问题 —— op 的像素对应归一化 UV，合成时按目标尺寸吞吐，
     * 形状不会变形，只是分辨率档位不同。 */
    function bakeSize() {
      var got = slotBaseImage();
      var W = BAKE_MAX, H = BAKE_MAX;
      if (imgPx(got.img)) {
        var sw = imgPx(got.img), sh = got.img.naturalHeight || got.img.height || 0;
        var srcMax = Math.max(sw, sh);
        var cap = Math.max(BAKE_MAX, Math.min(BAKE_CAP, srcMax));
        var sc = Math.min(1, cap / srcMax);
        W = Math.max(4, Math.round(sw * sc));
        H = Math.max(4, Math.round(sh * sc));
      }
      return { w: W, h: H, got: got };
    }

    /* 落点默认比例 s（原画像素 / 相机像素）。两个口径取小：
     *   ① 原画短边的 22% —— 老口径，大岛（整个人体）靠它，一块落点就占住画面一角
     *   ② 1:1 像素密度   —— 岛能装多少像素就只从原画取多少
     * 为什么必须有 ②：AI 资产把小岛切到 20~40px 很常见，按 22% 去原画上抓 150px
     * 塞进这 38px 的岛，等于 5~6 倍降采样 —— 信息全被平均掉，烘出来是一块浅色，
     * 用户看到的就是「烘焙后贴图变白」。大岛两者差不多，小岛自动变小变清楚。
     * 用 `Math.min` 而不是替换：改的是默认值，不是上限 —— 滚轮仍可放大到 20 倍。 */
    function defaultBindSize(isl, grp) {
      var imgW = (S.srcImg && S.srcImg.naturalWidth) || 1024;
      var imgH = (S.srcImg && S.srcImg.naturalHeight) || 1024;
      var list = (grp && grp.length > 1) ? grp : [isl && isl.id];
      var geo = isl ? islandCamGeo(isl) : null;
      var ub = (list.length > 1) ? groupCamBox(list) : null;
      var gb = ub ? Math.max(ub.w, ub.h) : (geo && geo.box ? Math.max(geo.box.w, geo.box.h) : 0);
      if (!(gb > 0)) gb = Math.min(imgW, imgH) * 0.22;
      var sampleW = Math.min(imgW, imgH) * 0.22;
      var texel = islandTexSide(list);
      /* 下限 6px：几像素的碎岛（AI 资产里常见）按 1:1 会得到亚像素的落点框，
       * 屏幕上按不住也没意义。6px 以内的降采样（≤2 倍）肉眼看不出区别。 */
      if (texel > 0) sampleW = Math.min(sampleW, Math.max(texel, 6));
      return {
        imgW: imgW, imgH: imgH, box: gb, sample: sampleW, texel: texel,
        s: sampleW / Math.max(gb, 1e-6)
      };
    }

    /* 岛（或整组）在**贴图上**占的边长（像素）—— 也就是「这块最多能装多少像素」。
     * 落点采的像素比它多，多出来的信息当场被平均掉，烘出来就是一块浅色
     * （这就是「烘焙后贴图变白」的成因）。整组按并集包围盒算：连选拖过去的是一组，
     * 能装的像素也得合起来算，否则一组碎岛会被算成一坨。
     * 注意这里用的是**贴图像素**，不是 UV（0~1）：两者差着 atlas 分辨率那个倍数，
     * 混用会让「1:1」这条判据整体偏几百倍。 */
    function islandTexSide(ids) {
      var sz = bakeSize();
      var W = sz.w, H = sz.h;
      if (!(W > 0)) return 0;
      var u0 = 1, v0 = 1, u1 = 0, v1 = 0, any = false;
      for (var i = 0; i < (ids || []).length; i++) {
        var isl = islandById(ids[i]);
        var b = isl && isl.bounds;
        if (!b) continue;
        any = true;
        if (b.u0 < u0) u0 = b.u0;
        if (b.v0 < v0) v0 = b.v0;
        if (b.u1 > u1) u1 = b.u1;
        if (b.v1 > v1) v1 = b.v1;
      }
      if (!any) return 0;
      return Math.max((u1 - u0) * W, (v1 - v0) * H);
    }

    /* ---------------- 烘焙 ----------------
     * 「平面投射」：把**当前视角看到的这块形状**，从原画对应位置上取下来，贴回该岛的 UV。
     * 逐三角做，每个三角一组三点对应的仿射：
     *   相机像素 (p,q) ⇄ UV 像素 (u,v)  ← 三角三个角同时有这两套坐标，仿射唯一确定
     *   相机像素 (p,q) → 原画像素 (x,y)  ← x = cx + (p - box.cx) * s
     * 先按深度**从远到近**画，正面才会盖住背面（与 id 位图同一口径）。
     * 实测 3 万三角约 60ms，比之前的「整岛一次 clip」只慢一点，换来形状真的对得上。
     */
    function bake() {
      if (S.busy) return 0;
      if (!S.open || !st.doc || !st.mesh) return 0;
      if (!S.srcImg) { toast('先上传一张原画', true); return 0; }
      /* 烘焙顺序 = 图层顺序（从下到上）：
       * 正常 UV 岛之间不重叠，顺序只影响「UV 重叠的退化模型」谁盖谁 ——
       * 那时也应该让上层说话，和左栏看到的一致。隐藏的层直接跳过。 */
      layerSync();
      var jobs = [], hidden = 0, otherSlot = 0, i, isl, bind;
      for (i = 0; i < S.layerOrder.length; i++) {
        var lid = S.layerOrder[i];
        isl = islandById(lid);
        bind = S.binds[lid];
        if (!isl || !bind) continue;
        /* 「只烘焙选中岛」也要吃连选：勾了它又连选三个，只烘一个等于白选 */
        if (S.onlySel && !selHas(isl.id)) continue;
        if (isl.slot !== S.slot) { otherSlot++; continue; }
        if (bind.on === false) { hidden++; continue; }
        if ((bind.op == null ? 1 : bind.op) <= 0.002) { hidden++; continue; }
        jobs.push({ isl: isl, bind: bind });
      }
      if (!jobs.length) {
        if (hidden) toast('这一槽的层全被隐藏了 —— 在图层面板里点眼睛打开', true);
        else if (otherSlot) toast('绑定都在别的材质槽上 —— 换个槽再烘焙', true);
        else toast('没有可烘焙的绑定（先拖一个岛到原画上）', true);
        return 0;
      }

      /* 切片二：烘焙 = 往「编辑层栈」推一层增量图，**不再写 slotMaps**。
       * 增量图是透明底、只含这一批岛的像素；底座由合成阶段合并
       * （texmix 的 baseImg = TexStack.edited）。这样才能：
       *   - 反复调落位（层留着，随时改 s / cx / cy 重新推一层）
       *   - 不把混合层烙进基础图（P0-2 双份的根因）
       *   - 历史只存一层增量，不是两张 2048² PNG
       * 真要写进贴图（导出前）走「固化为底图」。 */
      var sz = bakeSize();
      var W = sz.w, H = sz.h;
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      var c2 = cv.getContext('2d');
      var TStack = global.TexStack;
      var before = TStack ? TStack.ops(st.doc, S.slot).slice() : [];

      S.busy = true;
      var img = S.srcImg;
      var iw0 = img.naturalWidth, ih0 = img.naturalHeight, uvs = st.mesh.uvs;
      var done = 0, skipped = 0, triDrawn = 0, coarse = 0, occ = 0;
      for (var j = 0; j < jobs.length; j++) {
        var it = jobs[j], isl2 = it.isl, bd = it.bind;
        var geo = islandCamGeo(isl2);
        if (!geo || !geo.tri.length || !(bd.s > 0)) { skipped++; continue; }
        var box = geo.box, t3 = geo.tri, ord = geo.order, vv = geo.vis;
        /* 落点采的像素远多于岛能装的（>1.6 倍）就是纯降采样，烘出来必然是一片浅色。
         * 不拦（用户可能就是要一张糊底），但一定要说出来 —— 否则眼里只有「变白」。
         * 尺寸直接用上面这张工作区画布的 W/H 算，别再走 bakeSize()（每个岛一次解码查询）。 */
        var needPx = bd.s * Math.max(box.w, box.h);
        var bb0 = isl2.bounds;
        var canPx = bb0 ? Math.max((bb0.u1 - bb0.u0) * W, (bb0.v1 - bb0.v0) * H) : 0;
        if (canPx > 0 && needPx > canPx * 1.6) coarse++;
        /* 层的不透明度：drawImage 带 globalAlpha 会与工作区里已有的内容混合，
         * 工作区原内容就是旧贴图 —— 与左栏「先补底图再叠这一层」看到的一致。 */
        var lop = bd.op == null ? 1 : bd.op;
        /* 相机像素 → 原画像素：原画 = 相机 * s + o */
        var ox = bd.cx - box.cx * bd.s, oy = bd.cy - box.cy * bd.s;
        var drew = 0;
        for (var oi = 0; oi < ord.length; oi++) {
          var ti = ord[oi];
          /* 被挡住的三角不采样：那块的相机像素属于**前面那个东西**，
           * 采回来贴上去就是一条错位的色带 —— 这是「烘焙后脸上多一片」的根因。 */
          if (vv && !vv[(ti / 10) | 0]) { occ++; continue; }
          var ax = t3[ti], ay = t3[ti + 1], bxx = t3[ti + 2], byy = t3[ti + 3], cxx = t3[ti + 4], cyy = t3[ti + 5];
          /* 三个角的 UV 像素（v 向上，画布 y 向下） */
          var c0 = t3[ti + 6], c1 = t3[ti + 7], c2i = t3[ti + 8];
          var u0 = (uvs[c0 * 2] || 0) * W, v0 = (1 - (uvs[c0 * 2 + 1] || 0)) * H;
          var u1 = (uvs[c1 * 2] || 0) * W, v1 = (1 - (uvs[c1 * 2 + 1] || 0)) * H;
          var u2 = (uvs[c2i * 2] || 0) * W, v2 = (1 - (uvs[c2i * 2 + 1] || 0)) * H;
          var d1x = bxx - ax, d1y = byy - ay, d2x = cxx - ax, d2y = cyy - ay;
          var det = d1x * d2y - d2x * d1y;
          if (Math.abs(det) < 1e-9) continue;
          var du1 = u1 - u0, dv1 = v1 - v0, du2 = u2 - u0, dv2 = v2 - v0;
          var ma = (du1 * d2y - du2 * d1y) / det;
          var mc = (du2 * d1x - du1 * d2x) / det;
          var me = u0 - ma * ax - mc * ay;
          var mb = (dv1 * d2y - dv2 * d1y) / det;
          var md = (dv2 * d1x - dv1 * d2x) / det;
          var mf = v0 - mb * ax - md * ay;
          /* 三角的相机包围盒 → 原画上要取的那一小块 */
          var tminx = Math.min(ax, bxx, cxx), tmaxx = Math.max(ax, bxx, cxx);
          var tminy = Math.min(ay, byy, cyy), tmaxy = Math.max(ay, byy, cyy);
          var sx0 = ox + tminx * bd.s, sy0 = oy + tminy * bd.s;
          var sx1 = ox + tmaxx * bd.s, sy1 = oy + tmaxy * bd.s;
          /* 夹到原画边界：夹了哪边，就把目标矩形按同样比例缩回来 */
          var kxa = Math.max(0, sx0), kya = Math.max(0, sy0);
          var kxb = Math.min(iw0, sx1), kyb = Math.min(ih0, sy1);
          if (kxb - kxa < 0.5 || kyb - kya < 0.5) continue;
          var dxa = tminx + (kxa - sx0) / bd.s, dya = tminy + (kya - sy0) / bd.s;
          var dw = (kxb - kxa) / bd.s, dh = (kyb - kya) / bd.s;

          c2.save();
          /* clip 用的是**贴图（UV）像素坐标**，不是相机坐标。
           * 这一句在 setTransform 之前，此时 CTM = 单位阵，所以这里画的三角
           * 直接落在贴图画布上；如果误用相机坐标（一两位像素到几百像素的差别），
           * clip 区域和下面 drawImage 真正画的 UV 区间几乎不重叠 → 什么都贴不上。
           * 外扩 0.7px：相邻三角共用一条边，抗锯齿各留半格会拼出一条半透明暗缝。 */
          var um = (u0 + u1 + u2) / 3, vm = (v0 + v1 + v2) / 3;
          c2.beginPath();
          growTo(c2, um, vm, u0, v0, 0.7, true);
          growTo(c2, um, vm, u1, v1, 0.7, false);
          growTo(c2, um, vm, u2, v2, 0.7, false);
          c2.closePath();
          c2.clip();
          c2.setTransform(ma, mb, mc, md, me, mf);
          c2.globalAlpha = lop;
          c2.imageSmoothingEnabled = true;
          c2.imageSmoothingQuality = 'high';
          c2.drawImage(img, kxa, kya, kxb - kxa, kyb - kya, dxa, dya, dw, dh);
          c2.restore();
          drew++;
        }
        if (drew) { done++; triDrawn += drew; } else skipped++;
      }
      S.busy = false;

      if (!done) { toast('绑定落在原画外面了，往里拖一点', true); return 0; }

      if (!TStack) {
        /* 层栈没加载：退回老路（直接写 slotMaps），否则这次投射等于白做 */
        var mats0 = st.doc.materials || (st.doc.materials = {});
        var arr0 = mats0.slotMaps || (mats0.slotMaps = []);
        while (arr0.length <= S.slot) arr0.push('');
        var base0 = slotBaseImage();
        var c2b = cv.getContext('2d');
        c2b.globalCompositeOperation = 'destination-over';
        if (base0.img) c2b.drawImage(base0.img, 0, 0, W, H);
        else { c2b.fillStyle = slotColorOf(S.slot); c2b.fillRect(0, 0, W, H); }
        c2b.globalCompositeOperation = 'source-over';
        var after0 = cv.toDataURL('image/png');
        arr0[S.slot] = after0;
        SeedModel.Scene.revision(st.doc, 'current');
        var tex0 = new THREE.CanvasTexture(cv);
        if ('encoding' in tex0 && THREE.sRGBEncoding != null) tex0.encoding = THREE.sRGBEncoding;
        tex0.userData.mdShared = true;
        if (applySlotTexture) applySlotTexture(S.slot, tex0);
      } else {
        TStack.push(st.doc, S.slot, {
          type: 'project',
          label: '投射 ' + done + ' 层',
          canvas: cv, w: W, h: H, op: 1,
          /* 参数也留着：将来「重应用 / 持久化」靠它，像素只是这一次的缓存 */
          binds: jobs.map(function (jt) {
            return {
              id: jt.isl.id, faces: (jt.isl.faces || []).slice(),
              cx: jt.bind.cx, cy: jt.bind.cy, s: jt.bind.s,
              op: jt.bind.op == null ? 1 : jt.bind.op
            };
          })
        });
        pushHist({
          tex: { slot: S.slot, before: before, after: TStack.ops(st.doc, S.slot).slice() },
          label: '投射烘焙',
          bytes: W * H * 4
        });
      }
      refreshTexView();
      paintAll();

      toast('已应用投射 ' + done + ' 层'
        + (hidden ? ('，' + hidden + ' 层隐藏跳过') : '')
        + (skipped ? ('，' + skipped + ' 层落在原画外') : '')
        + (occ ? ('，' + occ + ' 个三角被遮挡（没取样）') : '')
        + (coarse ? ('，' + coarse + ' 层落点比岛大（会糊：拖动时滚轮缩小落点）') : '')
        + '（可撤销；要写进贴图点「固化为底图」）');
      /* 三角数写进状态栏：逐三角投射之后，「岛数对但画面没变」最常见的两个原因是
       * 岛内三角全被判到原画外、或 bd.s 太小 —— 有这个数就一眼能看出是哪边。 */
      setStatus('投射烘焙：' + done + ' 层（' + triDrawn + ' 个三角）已作为投射层叠加在「' + slotName(S.slot) + '」上');
      selSet([]);
      S.lySel = null;
      renderLayers();
      requestDraw();
      /* 烘焙完按新贴图重抓一次视角：右栏立刻变成「烘焙后」的样子，
       * 不用切回视口才知道有没有贴上。延迟一帧，先把贴图交给 GPU。 */
      S.camDirty = true;
      global.setTimeout(function () { if (S.open) refreshAll(true); }, 140);
      return done;
    }

    /* 让视口显示「底座 ⊕ 编辑层 ⊕ 混合层」。
     * 走混合管线的 refreshSlot：它会重算 baseImg（现在含编辑层）并重新挂材质。 */
    function refreshTexView() {
      if (ctx.mixRefresh) { ctx.mixRefresh(S.slot); return; }
      /* 混合模块不在：自己合成一张挂上去（只含底座 + 编辑层） */
      if (!ctx.applySlotTexture || !global.TexStack) return;
      var got = slotBaseImage();
      var cv = global.TexStack.edited(st.doc, S.slot, { base: got.img, baseKey: got.from + '|' + got.url });
      if (!cv) return;
      var tex = new THREE.CanvasTexture(cv);
      if ('encoding' in tex && THREE.sRGBEncoding != null) tex.encoding = THREE.sRGBEncoding;
      tex.anisotropy = 4;
      tex.userData.mdShared = true;
      ctx.applySlotTexture(S.slot, tex);
    }

    /* 「固化为底图」：把编辑层栈合进 slotMaps，层清空。
     * 这是**唯一**还写贴图的投射动作 —— 也是「烘焙」这个词以前做的全部事情。 */
    function flattenSlot() {
      if (!st.doc || !st.mesh) return false;
      var TStack = global.TexStack;
      if (!TStack || !TStack.has(st.doc, S.slot)) {
        toast('这一槽没有待固化的投射层（先「烘焙」一次）');
        return false;
      }
      var got = slotBaseImage();
      /* 文档里本来有贴图、这会儿却读不出像素（坏图 / 还在解码）：
       * 固化会把整片贴图写成「槽位灰 + 几个岛」—— 宁可不动，也不能洗掉。 */
      var mats0 = st.doc.materials || {};
      var urlNow = (mats0.slotMaps || [])[S.slot] || '';
      /* 判据是「像素到底是不是这张 URL 给的」（from==='slot'），不是「有没有像素」：
       * 上一轮合成图也会挂在材质上被 live 兜底取到，用它当底座固化
       * 等于把坏 URL 换成了「槽位灰 + 几个岛」。 */
      if (urlNow && got.from !== 'slot') {
        toast('这一槽的旧贴图还没读出来，先别固化（稍等再点，或重新打开模型）', true);
        return false;
      }
      var cv = TStack.flatten(st.doc, S.slot, {
        base: got.img, slotColor: slotColorOf(S.slot), cap: BAKE_CAP
      });
      if (!cv) { toast('固化失败：取不到底座尺寸', true); return false; }
      var mats = st.doc.materials || (st.doc.materials = {});
      var arr = mats.slotMaps || (mats.slotMaps = []);
      while (arr.length <= S.slot) arr.push('');
      var beforeMap = arr[S.slot] || '';
      var beforeOps = TStack.ops(st.doc, S.slot).slice();
      var afterMap = '';
      try { afterMap = cv.toDataURL('image/png'); } catch (e) {
        toast('固化失败：画布无法编码（可能是跨域图）', true);
        return false;
      }
      arr[S.slot] = afterMap;
      TStack.clear(st.doc, S.slot);
      SeedModel.Scene.revision(st.doc, 'current');
      pushHist({
        tex: { slot: S.slot, before: beforeOps, after: [], beforeMap: beforeMap, afterMap: afterMap },
        label: '固化为底图',
        bytes: (beforeMap.length + afterMap.length) * 2
      });
      refreshTexView();
      if (ctx.paintAll) ctx.paintAll();
      renderLayers();
      requestDraw();
      toast('已固化进「' + slotName(S.slot) + '」的贴图（Ctrl+Z 可退回未固化）');
      setStatus('投射烘焙：投射层已合进贴图，现在导出 GLB 会带上这些像素');
      return true;
    }

    function slotName(i) {
      var n = (st.doc && st.doc.materials && st.doc.materials.slotNames) || [];
      return n[i] || ('插槽 ' + (i + 1));
    }

    /* 槽位底色：模型这一槽没有贴图时的「底」。
     * 必须和 ensureTarget() 打底用的颜色是同一个，否则「左栏看到的半透明」
     * 和「烘出来的半透明」会差一个色。 */
    function slotColorOf(i) {
      var c = (st.doc && st.doc.materials && st.doc.materials.slotColors) || [];
      return c[i] || '#c9ccd4';
    }

    /* UV 碎成「一个面一个岛」时（AI 图生 3D 的常见病，动辄上万岛），投射烘焙没法用：
     * 每个岛只有几像素大，拖不准、也采不到东西。这里给一条一键出路 ——
     * 盒式投影重做一套连续 UV（6 个岛），走标准历史可撤销。
     * 代价是原贴图映射失效，但用户本来就是打算用原画重修贴图。 */
    function rebuildUV() {
      if (!st.mesh || !st.doc) { toast('没有可整理的网格', true); return false; }
      if (S.islands.length <= 400 && !(S.overlapPairs > 20)) {
        toast('当前 UV 已经是 ' + S.islands.length + ' 个岛，不需要重建');
        return false;
      }
      if (!ctx.applyMesh) { toast('外壳没有暴露 applyMesh，改用 UV 编辑器处理', true); return false; }
      var clone = SeedModel.Mesh.clone(st.mesh);
      if (!clone) { toast('这个网格复制失败，无法重建 UV', true); return false; }
      global.SeedUV.boxProject(clone);
      SeedModel.Mesh.bump(clone);
      S.binds = Object.create(null);
      S.layerOrder = [];
      selSet([]);
      S.lySel = null;
      S.camDirty = true;
      ctx.applyMesh(clone, '重建 UV（盒式投影）');
      refreshAll(true);
      toast('UV 已重建为 6 个连续岛（原贴图映射已变，Ctrl+Z 可撤销）');
      setStatus('投射烘焙：UV 已用盒式投影重建，现在可以拖岛了');
      return true;
    }

    function pushHist(entry) {
      st.history.undo.push(entry);
      st.history.redo = [];
      var guard = 0;
      while (st.history.undo.length > 1 && ctx.totalBytes() > ctx.historyBudget && guard++ < 500) {
        st.history.undo.shift();
      }
      ctx.syncBytes();
      ctx.updateChrome();
    }

    /* ---------------- 原画载入 ----------------
     * 上传入口是 label[for=mdPbFile]（原生激活，不靠脚本）。pickSrc 只留给
     * 键盘（Enter/Space）和「原画选择器不可用」时的兜底路径。 */
    function pickSrc() {
      var f = $('mdPbFile');
      if (!f) { toast('图片选择器不可用', true); return; }
      f.click();
    }

    function toggleSrcView() {
      if (!S.srcImg) { toast('还没有原画，先点「上传原画」', true); return; }
      S.viewSrc = !S.viewSrc;
      syncInfo();
      requestDraw();
    }

    function loadSrcFile(file) {
      if (!file) return;
      if (!/^image\//.test(file.type || '')) { toast('请选择图片文件', true); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var img = new Image();
        img.onload = function () {
          var changed = (S.srcName !== (file.name || ''));
          S.srcImg = img;
          S.srcName = file.name || '原画';
          /* 换了图 = 换了一张画布：上次放大到 800% 停在某个角落，
           * 新图会「看起来没载入」（那一角可能是纯色） */
          S.leftView = { z: 1, ox: 0, oy: 0 };
          /* 上传完必须让用户看见这张图。没有这一步，画布上唯一的反馈是
           * 标题旁那 10px 的小字 —— 用户点完上传只觉得「没反应」。 */
          S.viewSrc = true;
          syncInfo();
          renderLayers();     /* 层的缩略图全是「原画的一块」，换原画必须重画 */
          requestDraw();
          toast(changed ? ('已载入原画：' + S.srcName + ' · 把右边的岛拖过来取料') : '已载入原画');
        };
        img.onerror = function () { toast('图片解码失败', true); };
        img.src = String(fr.result);
      };
      fr.onerror = function () { toast('读取图片失败', true); };
      fr.readAsDataURL(file);
    }

    /* 底图层的内容 = 模型当前这一槽的贴图（取法与烘焙工作区**同一个**：
     * slotBaseImage，否则「左栏看到的底图」和「烘焙的底」会不是一张图）。
     * 必须和「原画」分开取：用户上传的原图是要盖在旧贴图上的，两者内容不同，
     * 图层才有意义（共用一张图的话，拖过来的层和底图长得一样，等于什么都没发生）。 */
    var basePending = '';   /* 正在按 URL 载底图（防止每帧重复 new Image） */
    /* 图 → dataURL（Image / Canvas 都能吃） */
    function imgToURL(img) {
      if (!img) return '';
      if (img.toDataURL && img.getContext) return img.toDataURL('image/png');
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) return '';
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0);
      return cv.toDataURL('image/png');
    }

    /* 「领养」材质上那张图：slotMaps 这一槽是空、但材质上有像素
     * （只挂了 material.map 的老资产 / 外部导入）时，把它写进文档。
     *
     * 不领养会怎样：只要发生一次材质重建（撤销 / 改槽 / 换对象），
     * 那张图就没了 —— 用户看到的是「撤销一下贴图全不见了」。
     * 领养之后 slotMaps 才是真源，和绘画 / 混合 / 导出都一致。
     *
     * 但要排除「纹理混合合成图」：把它当底座写回去，混合层就烙进基础图，
     * 下次合成再叠一次（P0-2）。合成图由 MIX 每次现算，本来就不需要领养。 */
    function adoptLiveBase() {
      if (!st.doc) return false;
      var got = slotBaseImage();
      if (got.url || !got.img) return false;
      if (ctx.mixComposed && ctx.mixComposed(S.slot) === got.img) return false;
      var mats = st.doc.materials || (st.doc.materials = {});
      var arr = mats.slotMaps || (mats.slotMaps = []);
      while (arr.length <= S.slot) arr.push('');
      var url = '';
      try { url = imgToURL(got.img); } catch (e) { return false; }
      if (!url) return false;
      arr[S.slot] = url;
      SeedModel.Scene.revision(st.doc, 'current');
      return true;
    }

    function loadBaseMap() {
      var got = slotBaseImage();
      /* 底图 = 「底座 ⊕ 编辑层」：左栏必须显示「已经投过之后的样子」，
       * 否则每投一次都得靠落点框猜结果对不对。 */
      var TStack = global.TexStack;
      var editCv = null;
      if (TStack && TStack.has(st.doc, S.slot)) {
        editCv = TStack.edited(st.doc, S.slot, { base: got.img, baseKey: got.from + '|' + got.url });
        if (editCv) got = { url: got.url, img: editCv, from: 'edited' };
      }
      var url = got.url;
      /* 没有 URL 也要试「材质上挂着的那张」：纹理混合 / 老资产只有 map 没有 slotMaps。
       * 这条以前缺了，症状是左栏底图一片灰、烘焙把整片贴图洗掉。 */
      /* key 带上来源与层版本：来源变了（live→slot）或投射层变了都要重铺，
       * 否则底图会一直停在上一张。 */
      var key = (got.from || '') + '|' + url + (editCv ? ('|' + TStack.rev(st.doc, S.slot)) : '');
      if (key === S.baseKey && S.baseImg) return;
      if (got.img) {
        basePending = '';
        S.baseKey = key; S.baseUrl = url; S.baseImg = got.img; S.baseFrom = got.from;
        renderLayers();
        requestDraw();
        return;
      }
      /* 已经在为这个来源等解码了：等它回来，别重复发请求 */
      if (key === basePending) return;
      S.baseKey = key;
      S.baseUrl = url;
      S.baseImg = null;
      S.baseFrom = '';
      if (!url) { basePending = ''; renderLayers(); requestDraw(); return; }
      /* 还没解码出来：自己按 URL 载一次，载好再铺（不阻塞绘制） */
      basePending = key;
      var img = new Image();
      img.onload = function () {
        if (basePending === key) basePending = '';
        if (S.baseUrl !== url) return;
        S.baseImg = img;
        S.baseKey = key;
        S.baseFrom = 'url';
        renderLayers();
        requestDraw();
      };
      img.onerror = function () { if (basePending === key) basePending = ''; };
      img.src = url;
    }

    /* 默认把当前槽的贴图铺成原画：多数情况下「模糊版」就在模型上，
     * 直接对着它拖比让用户先去找原图更省事（找到原图再换掉即可）。 */
    function autoLoadMap() {
      var mats = (st.doc && st.doc.materials) || {};
      var url = (mats.slotMaps || [])[S.slot] || '';
      if (!url || url === S.srcUrl) {
        if (!url) { S.srcImg = null; S.srcName = ''; syncInfo(); renderLayers(); requestDraw(); }
        return;
      }
      S.srcUrl = url;
      var img = new Image();
      img.onload = function () {
        if (S.srcUrl !== url) return;
        S.srcImg = img;
        S.srcName = '模型贴图';
        syncInfo();
        renderLayers();
        requestDraw();
      };
      img.onerror = function () {};
      img.src = url;
    }

    function clearSrc() {
      if (!S.srcImg) { toast('当前没有原画'); return; }
      S.srcImg = null; S.srcName = ''; S.srcUrl = '';
      S.viewSrc = false;   /* 没图可看了，退回合成视图 */
      syncInfo();
      renderLayers();
      requestDraw();
      /* 层是「原画上的一块」的引用，不是像素副本 —— 清掉原画不等于删层。
       * 这里说清楚，否则用户会以为层丢了。 */
      var n = S.layerOrder.length;
      toast(n ? ('已清除原画（' + n + ' 层还在，重新上传原画就接上）') : '已清除原画');
    }

    /* ---------------- 拾取 ----------------
     * 按画布坐标查 id 位图（O(1)）。岛重叠时后画的覆盖先画的，
     * 这与「用户看到的就是最后画上去那块」一致。
     * 位图分辨率现在与相机图一致，再加 PICK_SLOP 的容差 —— 原先只有半分辨率
     * 单像素查表，2.5px 宽的碎岛基本点不中，用户感受就是「按住岛没反应」。 */
    function islandAtCanvas(cx, cy) {
      var M = S.idMap;
      if (!M) return null;
      var f = camFit();
      if (f.iw < 4 || !(f.k > 0)) return null;
      /* 画布像素 → 相机像素 → 位图像素 */
      var mx = (cx - f.x) / f.k * M.kx;
      var my = (cy - f.y) / f.k * M.ky;
      /* 容差按「画布像素」定义，折算到位图；至少 1 格，否则细岛还是点不到 */
      var slop = Math.max(1, Math.round(PICK_SLOP / f.k * M.kx));
      var pref = (S.hover >= 0 ? S.hover : S.sel) + 1;
      var id = idNear(M, mx, my, slop, pref);
      return id > 0 ? islandById(id - 1) : null;
    }

    /* 岛在画布上的一个代表点（轮廓平均值），拖拽起点与测试都用它 */
    function islandCanvasPoint(isl) {
      return islandScrCenter(isl, camFit());
    }

    function islandById(id) {
      for (var i = 0; i < S.islands.length; i++) if (S.islands[i].id === id) return S.islands[i];
      return null;
    }

    /* ---------------- 连选（Shift 多选） ----------------
     * 唯一的「选中」真源是 S.multi，S.sel 只是它里面的主选（最后点的那个）。
     * 所有原来写 `S.sel = x` 的地方都要走下面三个函数，否则会出现
     * 「框画在 A 上、拖走的却是 A 和 B」这种半套状态。 */
    function selSet(ids) {
      S.multi = (ids || []).slice();
      S.sel = S.multi.length ? S.multi[S.multi.length - 1] : -1;
    }
    function selHas(id) { return S.multi.indexOf(id) >= 0; }
    function selToggle(id) {
      var i = S.multi.indexOf(id);
      if (i >= 0) S.multi.splice(i, 1);
      else S.multi.push(id);
      S.sel = S.multi.length ? S.multi[S.multi.length - 1] : -1;
    }
    /* 拖拽时用哪几个：点在组里就整组走，点在组外就只拖它自己 */
    function selGroup(baseId) {
      if (!(selHas(baseId) && S.multi.length > 1)) return [baseId];
      /* 主选排最后统一挪过去没意义，顺序照 multi，只保证 baseId 一定在内 */
      return S.multi.slice();
    }
    /* 组内所有岛在当前视角下的并集包围盒（相机像素）：整组只用一个比例尺，
     * 这样几块 UV 岛拼在一起时相对位置才是对的。 */
    function groupCamBox(ids) {
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, any = false;
      for (var i = 0; i < ids.length; i++) {
        var isl = islandById(ids[i]);
        var g = isl && islandCamGeo(isl);
        if (!g || !g.box) continue;
        var b = g.box;
        any = true;
        if (b.x0 < x0) x0 = b.x0;
        if (b.y0 < y0) y0 = b.y0;
        if (b.x1 > x1) x1 = b.x1;
        if (b.y1 > y1) y1 = b.y1;
      }
      if (!any) return null;
      return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
    }

    /* 整组落位方案：基准岛的落点 = pend，其余成员跟着它。
     * 两种情况必须分开，否则会把用户已经摆好的东西重排：
     *   ① 整组都已绑定 → **纯平移 + 等比缩放**（保持各自的大小和相对位置）
     *   ② 组里有没绑过的 → 按「当前视角里的相对位置」整体拼过去，共用一个 s
     *      （这才是「几块碎岛拼成一张皮」的正确姿势） */
    function planGroup(group, baseId, pend) {
      var out = [], i, allBound = true;
      for (i = 0; i < group.length; i++) if (!S.binds[group[i]]) { allBound = false; break; }
      if (allBound) {
        var b0 = S.binds[baseId];
        var k = b0 && b0.s ? pend.s / b0.s : 1;
        for (i = 0; i < group.length; i++) {
          var b = S.binds[group[i]];
          if (!b) continue;
          out.push({
            id: group[i],
            cx: pend.cx + (b.cx - b0.cx) * k,
            cy: pend.cy + (b.cy - b0.cy) * k,
            s: b.s * k
          });
        }
        return out;
      }
      var g0 = islandCamGeo(islandById(baseId));
      var c0 = (g0 && g0.box) ? g0.box : { cx: 0, cy: 0 };
      for (i = 0; i < group.length; i++) {
        var gi = islandCamGeo(islandById(group[i]));
        var ci = (gi && gi.box) ? gi.box : c0;
        out.push({
          id: group[i],
          cx: pend.cx + (ci.cx - c0.cx) * pend.s,
          cy: pend.cy + (ci.cy - c0.cy) * pend.s,
          s: pend.s
        });
      }
      return out;
    }

    function localXY(e, el) {
      var r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    /* ---------------- 左栏：平移 / 光标 ----------------
     * 平移只改 leftView.ox/oy（画布 CSS px），不碰 bind：
     * 「看哪里」和「岛落在哪」必须能分开，否则放大看细节时一拖就把绑定拖跑了。 */
    function startPan(e, cv, p, clickDeselect) {
      cv.setPointerCapture(e.pointerId);
      S.drag = {
        kind: 'pan', x0: p.x, y0: p.y,
        ox0: S.leftView.ox, oy0: S.leftView.oy,
        moved: false, clickDeselect: !!clickDeselect
      };
      cv.style.cursor = 'grabbing';
    }

    function movePan(e, cv) {
      var d = S.drag, p = localXY(e, cv);
      var dx = p.x - d.x0, dy = p.y - d.y0;
      /* 3px 以内算「点了一下」：空白处点击本来是取消选中，不能因为手抖就变成平移 */
      if (!d.moved && dx * dx + dy * dy >= 9) d.moved = true;
      if (!d.moved) return;
      S.leftView.ox = d.ox0 + dx;
      S.leftView.oy = d.oy0 + dy;
      leftViewClamp();
      requestDraw();
    }

    function updateLeftCursor(e) {
      var cv = $('mdPbLeft');
      if (!cv) return;
      var cur = 'default';
      var fit = leftFit();
      if (e && fit) {
        var p = localXY(e, cv);
        if (S.sel >= 0) {
          var isl = islandById(S.sel), bind = isl && S.binds[isl.id];
          if (bind) {
            var hd = handleAt(isl, bind, fit, p);
            if (hd) cur = hd.cur;
          }
        }
        /* 压在一个已绑定的框上 → move 箭头（左键拖动是挪位置，不是平移画布）。
         * 只比包围盒，不跑 isPointInPath：这里每次 pointermove 都会来一次。 */
        if (cur === 'default') {
          for (var i = 0; i < S.islands.length; i++) {
            var bd = S.binds[S.islands[i].id];
            if (!layerOn(bd)) continue;
            var rb = camBoxIn(S.islands[i], bd, fit);
            if (rb && p.x >= rb.x && p.x <= rb.x + rb.w && p.y >= rb.y && p.y <= rb.y + rb.h) { cur = 'move'; break; }
          }
        }
      }
      if (cur === 'default' && S.leftView.z > 1.005) cur = 'grab';
      if (cv.style.cursor !== cur) cv.style.cursor = cur;
    }

    /* ---------------- 交互 ---------------- */
    function bindEvents() {
      var win = pbWin();
      if (!win) return;

      win.addEventListener('click', function (e) {
        var t = e.target;
        /* 图层行：眼睛 / 删除 必须先判，否则会被下面的「选中这一行」吃掉 */
        var lyAct = t.closest ? t.closest('[data-lyact]') : null;
        if (lyAct) {
          var row0 = lyAct.closest('.md-pb-ly');
          var key0 = row0 && row0.getAttribute('data-ly');
          if (key0 != null) {
            if (lyAct.dataset.lyact === 'eye') toggleLayerVis(key0);
            else if (lyAct.dataset.lyact === 'del') removeLayer(key0);
          }
          return;
        }
        var lyRow = t.closest ? t.closest('.md-pb-ly') : null;
        if (lyRow) {
          var k1 = lyRow.getAttribute('data-ly');
          if (k1 != null) selectLayer(k1);
          return;
        }

        var b = t.closest ? t.closest('[data-pbact]') : null;
        if (!b) return;
        var act = b.dataset.pbact;
        if (act === 'close') close();
        else if (act === 'lyToggle') toggleLayerPanel();
        else if (act === 'recapture') { S.camDirty = true; refreshAll(true); toast('已按当前摄像机重抓'); }
        else if (act === 'fit') { S.camDirty = true; refreshAll(true); }
        else if (act === 'srcPick') pickSrc();
        else if (act === 'srcView') toggleSrcView();
        else if (act === 'srcClear') clearSrc();
        else if (act === 'bake') bake();
        else if (act === 'flatten') flattenSlot();
        else if (act === 'clearBinds') {
          S.binds = Object.create(null);
          S.layerOrder = [];
          selSet([]); S.lySel = null;
          syncInfo(); renderLayers(); requestDraw();
          toast('已清除全部绑定（图层也一起清空）');
        }
        else if (act === 'rebuildUV') rebuildUV();
      });

      /* 不透明度滑块：改的是当前选中层，拖的时候只重画不重建面板
       * （重建会把滑块换成新节点，正在拖的指针会掉） */
      var lyOp = $('mdPbLyOp');
      if (lyOp) {
        lyOp.addEventListener('input', function () {
          var b = S.lySel == null ? null : layerByKey(S.lySel);
          if (!b) return;
          b.op = Math.max(0, Math.min(1, Number(lyOp.value) / 100));
          var lab = $('mdPbLyOpVal');
          if (lab) lab.textContent = Math.round(b.op * 100) + '%';
          requestDraw();
        });
        /* 松手再重建：让行尾显示百分比、也顺手刷缩略图 */
        lyOp.addEventListener('change', function () { renderLayers(); });
      }

      var fileInput = $('mdPbFile');
      if (fileInput) {
        fileInput.addEventListener('change', function () {
          loadSrcFile(fileInput.files && fileInput.files[0]);
          fileInput.value = '';   /* 清空：连选两次同一张图也要能触发 change */
        });
      }

      /* label[for] 用键盘敲不开（它本身不是控件），补一条 Enter/Space */
      var srcLbl = $('mdPbSrcPick');
      if (srcLbl) {
        srcLbl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            pickSrc();
          }
        });
      }

      /* 「只烘焙选中岛」必须落到模块状态：以前只在 bake() 里读 S.onlySel，
       * 从没绑过 input，勾了等于没勾。 */
      var onlySel = $('mdPbOnlySel');
      if (onlySel) {
        onlySel.checked = !!S.onlySel;
        onlySel.addEventListener('change', function () { S.onlySel = !!onlySel.checked; });
      }

      /* 拖动标题栏 / 右下角改窗口尺寸：自己算，别依赖 UV 窗口那套 */
      win.addEventListener('pointerdown', function (e) {
        /* 图层行：按住行体拖动 = 排序（眼睛/删除是按钮，不参与） */
        var lyRow0 = e.target.closest ? e.target.closest('.md-pb-ly') : null;
        if (lyRow0 && e.button === 0 && !(e.target.closest && e.target.closest('[data-lyact]'))) {
          if (layerDragStart(e, lyRow0)) return;
        }
        var hd = e.target.closest && e.target.closest('[data-pbdrag="win"]');
        if (hd && !e.target.closest('button')) {
          var r = win.getBoundingClientRect();
          var host = win.parentNode.getBoundingClientRect();
          var off = { x: e.clientX - r.left, y: e.clientY - r.top };
          win.setPointerCapture(e.pointerId);
          function mv(ev) {
            win.style.left = Math.max(0, ev.clientX - host.left - off.x) + 'px';
            win.style.top = Math.max(0, ev.clientY - host.top - off.y) + 'px';
            win.style.right = 'auto';
            win.style.bottom = 'auto';
          }
          function up() {
            win.removeEventListener('pointermove', mv);
            win.removeEventListener('pointerup', up);
          }
          win.addEventListener('pointermove', mv);
          win.addEventListener('pointerup', up);
        }
        var rs = e.target.closest && e.target.closest('[data-pbresize]');
        if (rs) {
          var r0 = win.getBoundingClientRect();
          var sx = e.clientX, sy = e.clientY, w0 = r0.width, h0 = r0.height;
          win.setPointerCapture(e.pointerId);
          function mv2(ev) {
            win.style.width = Math.max(620, w0 + (ev.clientX - sx)) + 'px';
            win.style.height = Math.max(420, h0 + (ev.clientY - sy)) + 'px';
            win.style.right = 'auto';
            win.style.bottom = 'auto';
            requestDraw();
          }
          function up2() {
            win.removeEventListener('pointermove', mv2);
            win.removeEventListener('pointerup', up2);
            requestDraw();
          }
          win.addEventListener('pointermove', mv2);
          win.addEventListener('pointerup', up2);
        }
        var sp = e.target.closest && e.target.closest('#mdPbSplit');
        if (sp) {
          var body = win.querySelector('.md-pb-body');
          var b0 = body.getBoundingClientRect();
          var panes = win.querySelectorAll('.md-pb-pane');
          win.setPointerCapture(e.pointerId);
          function mv3(ev) {
            var f = Math.max(20, Math.min(80, (ev.clientX - b0.left) / b0.width * 100));
            panes[0].style.flexBasis = f + '%';
            panes[1].style.flexBasis = (100 - f) + '%';
            requestDraw();
          }
          function up3() {
            win.removeEventListener('pointermove', mv3);
            win.removeEventListener('pointerup', up3);
            requestDraw();
          }
          win.addEventListener('pointermove', mv3);
          win.addEventListener('pointerup', up3);
        }
      });

      var rightCv = $('mdPbRight');
      var leftCv = $('mdPbLeft');

      if (rightCv) {
        rightCv.addEventListener('pointerdown', function (e) {
          if (e.button !== 0) return;
          var p = localXY(e, rightCv);
          var isl = islandAtCanvas(p.x, p.y);
          if (!isl) {
            /* Shift+点空白不清空连选（PS 同款）：手一抖不该把挑好的都丢掉 */
            if (!e.shiftKey) { selSet([]); requestDraw(); }
            return;
          }
          /* Shift+点：**不在按下时切换**，只记「待定」。
           * 要是按下就切，用户 Shift 按着一个岛直接拖，会先把它从组里踢出去。 */
          var wasIn = selHas(isl.id);
          var group;
          if (e.shiftKey) {
            group = wasIn ? selGroup(isl.id) : S.multi.concat([isl.id]);
          } else {
            if (!wasIn) selSet([isl.id]);   /* 点到组外 = 换单选 */
            else S.sel = isl.id;            /* 点到组内 = 保持整组，主选切过去 */
            group = selGroup(isl.id);
          }
          rightCv.setPointerCapture(e.pointerId);
          var bind = S.binds[isl.id];
          /* 已绑定的岛再拖：默认**保留你调过的大小**（挪位置不该改大小）。
           * 但旧存档里有「22% 老口径」烘糊的落点（比岛能装的像素大好几倍），
           * 那种大小留着就是继续糊 —— 明显超采样（>1:1 上限 1.6 倍）时收回到 1:1。
           * 只收不放：任何情况下都不会把用户调小的落点变大。 */
          var s0 = bind ? bind.s : 0;
          if (bind && S.srcImg) {
            var capS = defaultBindSize(isl, group).s;
            if (capS > 0 && s0 > capS * 1.6) s0 = capS;
          }
          S.drag = {
            kind: 'pull', islandId: isl.id, group: group,
            shift: !!e.shiftKey, shiftWasIn: wasIn,
            /* 记下按下点：松手时要分清「点一下选中」和「真拖了一段」，
             * 只有后者才该弹提示，否则单击选岛会一直冒黄条。 */
            x0: e.clientX, y0: e.clientY, moved: false, warned: false,
            /* 已绑定：从框里拎起来 = 拖走它；未绑定：给一个以指针为中心的落点 */
            pend: bind ? { cx: bind.cx, cy: bind.cy, s: s0 } : null,
            /* s0 是「滚轮之前的基准比例」。已绑定时要记下来，
             * 否则 pend.s = (s0 || pend.s) * sizeMul 会拿**上一帧已经乘过**的值再乘，
             * 滚两下就飞出天际（这个累积错误以前就有，只是没人拖已绑定的岛去滚轮）。 */
            s0: s0
          };
          syncInfo();
          markEmptyAttn(false);
          requestDraw();
        });

        rightCv.addEventListener('pointermove', function (e) {
          var p = localXY(e, rightCv);
          if (!S.drag) {
            var isl = islandAtCanvas(p.x, p.y);
            var id = isl ? isl.id : -1;
            if (id !== S.hover) {
              S.hover = id;
              /* 指针形状是「哪里能按」最直接的提示：空白处是普通箭头，
               * 压到岛上才变成抓手。CSS 里 #mdPbRight 默认就是 grab，
               * 这里用空串退回样式表，不要写死 'grab'。 */
              rightCv.style.cursor = id >= 0 ? '' : 'default';
              requestDraw();
            }
            return;
          }
          if (S.drag.kind !== 'pull') return;
          updatePull(e);
        });

        rightCv.addEventListener('pointerup', function (e) {
          if (S.drag && S.drag.kind === 'pull') endPull(e);
        });
        rightCv.addEventListener('pointercancel', function () { S.drag = null; requestDraw(); });
        rightCv.addEventListener('wheel', function (e) {
          /* 右栏是相机画面，固定 contain 显示，不做缩放；
           * 只有拖动中的滚轮有意义：调落点大小（最常改的一维） */
          if (S.drag && S.drag.kind === 'pull') {
            e.preventDefault();
            var k = wheelFactor(e);
            S.drag.sizeMul = Math.max(0.05, Math.min(20, (S.drag.sizeMul || 1) * k));
            updatePull(e);
          }
        }, { passive: false });
      }

      if (leftCv) {
        leftCv.addEventListener('pointerdown', function (e) {
          if (S.drag) return;
          var fit = leftFit();
          if (!fit || !S.srcImg) return;
          var p = localXY(e, leftCv);

          /* ① 选中框的把手优先：把手必然压在形状边上，
           * 不先判它就会被下面的「移动」抢走 —— 表现是「角点能看见、但拖不动」。 */
          if (e.button === 0 && !e.altKey && S.sel >= 0) {
            var sIsl = islandById(S.sel), sBind = sIsl && S.binds[sIsl.id];
            if (sBind) {
              var hd = handleAt(sIsl, sBind, fit, p);
              if (hd) {
                var sd = startScale(sIsl, sBind, fit, hd, p);
                if (sd) {
                  leftCv.setPointerCapture(e.pointerId);
                  S.drag = sd;
                  leftCv.style.cursor = hd.cur;
                  requestDraw();
                  return;
                }
              }
            }
          }

          /* ② 中键 / Alt+左键 = 平移画布（放大后看细节的主要入口） */
          if (e.button === 1 || (e.button === 0 && e.altKey)) {
            /* 中键在部分浏览器会触发「自动滚动」手势，先掐掉 */
            if (e.button === 1) e.preventDefault();
            startPan(e, leftCv, p, false);
            return;
          }

          var px = (p.x - fit.x) / fit.s, py = (p.y - fit.y) / fit.s;
          var hitId = null;
          for (var i = 0; i < S.islands.length; i++) {
            var isl = S.islands[i];
            var bind = S.binds[isl.id];
            if (!layerOn(bind)) continue;   /* 隐藏的层在画布上不占位置（框也没画） */
            /* 命中用「当前视角形状」的包围盒：UV 包围盒与屏幕上的位置无关，不能用于这里。
             * ⚠ camBoxIn 返回的是**画布 CSS 坐标**（已经含 fit.x/fit.s），
             * 所以这里必须跟 p.x/p.y 比，不能跟上面的 px/py（原图像素）比 —— 两套坐标系。 */
            var cb = camBoxIn(isl, bind, fit);
            if (!cb) continue;
            if (p.x >= cb.x && p.x <= cb.x + cb.w && p.y >= cb.y && p.y <= cb.y + cb.h) {
              /* 再用形状本身收一次：包围盒的四个角通常是空的（斜着的手臂），
               * 点空白角落不该选中它 */
              var q = camPathIn(isl, bind, fit);
              var c2l = leftCv.getContext('2d');
              if (q && c2l && !c2l.isPointInPath(q, p.x * (S.left.dpr || 1), p.y * (S.left.dpr || 1))) continue;
              hitId = isl.id; break;
            }
          }
          if (hitId == null) {
            /* 放大之后空白处就是「拖动画布」的手柄；没拖动则退回原来的「点空白取消选中」 */
            if (e.button === 0 && S.leftView.z > 1.005) startPan(e, leftCv, p, true);
            else { selSet([]); S.lySel = null; renderLayers(); requestDraw(); }
            return;
          }
          /* Shift+点已绑定的岛 = 加入 / 移出连选（左栏也要能连选：
           * 落地之后想整组挪位置，光靠右栏选一遍再回来太绕） */
          if (e.shiftKey && S.srcImg) {
            selToggle(hitId);
            syncInfo();
            renderLayers();
            requestDraw();
            return;
          }
          /* 点到组里 = 保持整组，主选切过去；点到组外 = 换单选 */
          if (!selHas(hitId)) selSet([hitId]);
          else S.sel = hitId;
          if (e.button === 2 || e.ctrlKey) {
            /* 右键 / Ctrl+点 = 解除这个岛的绑定（组里就整组删，右键语义就是「删掉这一层」，
             * 连着选时用户显然想一次清掉这一批） */
            var grpDel = selGroup(hitId);
            for (var di = 0; di < grpDel.length; di++) {
              var did = grpDel[di];
              delete S.binds[did];
              var oi = S.layerOrder.indexOf(did);
              if (oi >= 0) S.layerOrder.splice(oi, 1);
              if (S.lySel === String(did)) S.lySel = null;
            }
            var nDel = grpDel.length;
            selSet([]);
            syncInfo();
            renderLayers();
            requestDraw();
            toast(nDel > 1 ? ('已删除 ' + nDel + ' 层') : '已删除这一层');
            return;
          }
          leftCv.setPointerCapture(e.pointerId);
          var bind0 = S.binds[hitId];
          var grp = selGroup(hitId);
          /* 组内每个成员的起始位置都记下来：平移量按「基准岛」算，其余加同一个位移，
           * 这样相对位置不会被浮点误差一点点磨歪 */
          var orig = [];
          for (var gj = 0; gj < grp.length; gj++) {
            var ob = S.binds[grp[gj]];
            if (ob) orig.push({ id: grp[gj], cx: ob.cx, cy: ob.cy });
          }
          S.drag = {
            kind: 'move', islandId: hitId, group: grp, orig: orig,
            offX: px - bind0.cx, offY: py - bind0.cy,
            base0: { cx: bind0.cx, cy: bind0.cy }
          };
          requestDraw();
        });

        leftCv.addEventListener('pointermove', function (e) {
          if (!S.drag) { updateLeftCursor(e); return; }
          if (S.drag.kind === 'pull') { updatePull(e); return; }
          if (S.drag.kind === 'scale') { moveScale(e); return; }
          if (S.drag.kind === 'pan') { movePan(e, leftCv); return; }
          if (S.drag.kind !== 'move') return;
          var fit = leftFit();
          if (!fit) return;
          var p = localXY(e, leftCv);
          var bind = S.binds[S.drag.islandId];
          if (!bind) return;
          var ncx = (p.x - fit.x) / fit.s - S.drag.offX;
          var ncy = (p.y - fit.y) / fit.s - S.drag.offY;
          if (S.drag.group && S.drag.group.length > 1 && S.drag.orig) {
            var dx = ncx - S.drag.base0.cx, dy = ncy - S.drag.base0.cy;
            for (var gi2 = 0; gi2 < S.drag.orig.length; gi2++) {
              var o2 = S.drag.orig[gi2], b2 = S.binds[o2.id];
              if (!b2) continue;
              b2.cx = o2.cx + dx;
              b2.cy = o2.cy + dy;
            }
          } else {
            bind.cx = ncx;
            bind.cy = ncy;
          }
          requestDraw();
        });

        leftCv.addEventListener('pointerup', function () {
          if (!S.drag) return;
          var d = S.drag;
          if (d.kind === 'pan') {
            /* 只是点了一下空白（没拖动）：按原来的语义取消选中 */
            if (!d.moved && d.clickDeselect) { selSet([]); S.lySel = null; renderLayers(); }
            S.drag = null;
            updateLeftCursor(null);
            requestDraw();
            return;
          }
          if (d.kind === 'move' || d.kind === 'scale') { S.drag = null; requestDraw(); }
        });
        leftCv.addEventListener('pointercancel', function () { S.drag = null; requestDraw(); });
        /* 双击空白/画面 = 视图复位。放大到 800% 之后，找回复位比记快捷键容易 */
        leftCv.addEventListener('dblclick', function () {
          if (S.leftView.z > 1.005) { leftResetView(); toast('画布已复位'); }
        });
        leftCv.addEventListener('wheel', function (e) {
          if (!S.srcImg) return;
          e.preventDefault();
          var f = wheelFactor(e);
          /* 从右栏拖岛过来的过程中，滚轮仍然是「调落点大小」：
           * 这时用户在做落位，不是在看图 */
          if (S.drag && S.drag.kind === 'pull') {
            S.drag.sizeMul = Math.max(0.05, Math.min(20, (S.drag.sizeMul || 1) * f));
            updatePull(e);
            return;
          }
          leftZoomAt(localXY(e, leftCv), f);
        }, { passive: false });
        /* 右键菜单要挡掉，否则解除绑定的右键会弹出浏览器菜单 */
        leftCv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      }

      document.addEventListener('keydown', onKey, true);
    }

    /* 左栏空态（「还没有原画」）闪一下：没原画时拖岛是唯一「看得见有反应」的地方 */
    function markEmptyAttn(on) {
      var el = $('mdPbLeftEmpty');
      if (el) el.classList.toggle('attn', !!on);
    }

    /* 拖动中：指针在左栏就用指针位置当落点；在别处就沿用上一次的落点 */
    function updatePull(e) {
      var leftCv = $('mdPbLeft');
      var isl = islandById(S.drag.islandId);
      if (!isl || !leftCv) return;
      if (!S.drag.moved) {
        var dx = e.clientX - S.drag.x0, dy = e.clientY - S.drag.y0;
        if (dx * dx + dy * dy >= 16) S.drag.moved = true;
      }
      var fit = leftFit();
      var r = leftCv.getBoundingClientRect();
      var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      var geo = islandCamGeo(isl);
      if (!S.drag.pend) {
        var def = defaultBindSize(isl, S.drag.group);
        S.drag.sizeMul = S.drag.sizeMul || 1;
        S.drag.s0 = def.s;
        S.drag.pend = { cx: def.imgW / 2, cy: def.imgH / 2, s: def.s };
      }
      S.drag.pend.s = (S.drag.s0 || S.drag.pend.s) * (S.drag.sizeMul || 1);
      if (inside && fit && S.srcImg) {
        var p = localXY(e, leftCv);
        var cx = (p.x - fit.x) / fit.s;
        var cy = (p.y - fit.y) / fit.s;
        S.drag.pend.cx = Math.max(0, Math.min(S.srcImg.naturalWidth, cx));
        S.drag.pend.cy = Math.max(0, Math.min(S.srcImg.naturalHeight, cy));
        S.drag.overLeft = true;
      } else {
        S.drag.overLeft = false;
      }
      /* 没有原画时整条落位链路是空转的（fit 为 null → 落点框不画 → overLeft 恒 false）。
       * 以前这里一个字都不提示，用户拖半天没反应，只会认为「拖不动」。
       * 只在「真拖了一段」之后提示一次，别把单击选岛也变成弹黄条。 */
      if (S.drag.moved && !S.srcImg && !S.drag.warned) {
        S.drag.warned = true;
        markEmptyAttn(true);
        toast('还没有原画，岛没地方落 —— 先点左栏「上传原画」', true);
      }
      /* 整组落点：每帧重算（基准岛 = pend，其余按组内相对位置跟着它）。
       * 放在 requestDraw 之前，绘制与松手都只读这一份。 */
      S.drag.pendList = planGroup(S.drag.group || [S.drag.islandId], S.drag.islandId, S.drag.pend);
      requestDraw();
    }

    function endPull(e) {
      var d = S.drag;
      S.drag = null;
      markEmptyAttn(false);
      if (!d) { requestDraw(); return; }
      /* Shift 点了一下（没拖动）= 加选 / 取消加选。放在 moved 判断之前：
       * 这是「连选」唯一的入口，不能等到拖完才处理。 */
      if (d.shift && !d.moved) {
        selToggle(d.islandId);
        syncInfo();
        renderLayers();
        requestDraw();
        return;
      }
      /* 按下没移动 = 只是选中一个岛，什么都不该发生（也别弹提示） */
      if (!d.moved) { requestDraw(); return; }
      if (!S.srcImg) {
        toast('还没有原画 —— 先点左栏「上传原画」选一张，再拖岛落位', true);
        requestDraw();
        return;
      }
      if (!d.pend || !d.overLeft) {
        toast('把岛一直拖到左边原画上再松手', true);
        requestDraw();
        return;
      }
      /* 整组落地：每个成员各自一层（层内容还是「该岛形状内的原画」），
       * 相对位置由 planGroup 保住 —— 连选拖过去就是「拼在一起」。 */
      var list = (d.pendList && d.pendList.length)
        ? d.pendList
        : [{ id: d.islandId, cx: d.pend.cx, cy: d.pend.cy, s: d.pend.s }];
      var made = 0, movedN = 0, gi, it, bb;
      for (gi = 0; gi < list.length; gi++) {
        it = list[gi];
        if (!it || !(it.s > 0)) continue;
        bb = S.binds[it.id];
        if (bb) { bb.cx = it.cx; bb.cy = it.cy; bb.s = it.s; movedN++; }
        else { S.binds[it.id] = { cx: it.cx, cy: it.cy, s: it.s, on: true, op: 1 }; made++; }
      }
      if (made) {
        /* layerSync 会把新绑定补到 order 末尾 = 最上层（PS 里新图层也在顶上） */
        layerSync();
      }
      /* 连选保留下来：接着还能整组挪、整组删。主选回到按下的那个。 */
      if (list.length > 1) {
        selSet(list.map(function (x) { return x.id; }));
        S.sel = d.islandId;
      }
      S.lySel = String(d.islandId);
      /* 第一个岛落地 = 开始合成了：这时该看的是「烘出来长什么样」，
       * 继续盯着原画全图反而看不到刚放的这块压在哪 */
      S.viewSrc = false;
      syncInfo();
      renderLayers();
      requestDraw();
      var nL = made + movedN;
      if (list.length > 1) {
        toast('连选 ' + nL + ' 个岛一起落位（新增 ' + made + ' 层，移动 ' + movedN + ' 层）');
      } else {
        toast(bb ? '已移动这一层' : '新图层：岛 ' + d.islandId + '（滚轮改大小，右键删除）');
      }
      /* 默认原画就是模型贴图本身（autoLoadMap）：这时新层内容和底图一样，
       * 看上去「拖了没反应」。这不是 bug，是数据相同 —— 点名一次，别让用户瞎猜。 */
      if (S.srcName === '模型贴图') {
        setStatus('投射烘焙：当前原画就是模型贴图本身，图层差别看不出来 —— 点「上传原画」换成真原图');
      } else if (list.length > 1) {
        setStatus('投射烘焙：连选 ' + nL + ' 个岛一起落位，点烘焙生效');
      } else {
        setStatus('投射烘焙：已把「' + slotName(S.slot) + '」的一个岛绑到原画 ('
          + Math.round(d.pend.cx) + ',' + Math.round(d.pend.cy) + ')，点烘焙生效');
      }
    }

    function onKey(e) {
      if (!S.open) return;
      if (e.key === 'Escape') {
        if (S.drag) { S.drag = null; requestDraw(); }
        else close();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === 'f' || e.key === 'F') {
        /* 窗口开着时外壳的 F 会被顶层窗口守卫挡掉，必须在这里自己处理：
         * F = 框显对象 + 重抓（保持用户已经摆好的视角方向）。
         * 提示条让用户「按 F 框显」，按下去必须有反应，否则那行字就是骗人的。 */
        if (focusActive()) {
          S.camDirty = true;
          refreshAll(true);
          toast('已框显当前对象（视角方向不变）');
        } else {
          S.camDirty = true;
          refreshAll(true);
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter')) { bake(); e.preventDefault(); e.stopImmediatePropagation(); }
    }

    /* ---------------- 打开 / 关闭 ---------------- */
    function open() {
      if (!st.doc || !st.mesh) { setStatus('投射烘焙：先新建或打开一个模型', true); return false; }
      if (ctx.nodeModsActive && ctx.nodeModsActive(st.node)) {
        setStatus('投射烘焙：该对象有修改器，先「应用修改器」或删掉修改器', true);
        return false;
      }
      if (S.open) {
        var w0 = pbWin();
        if (w0) { w0.classList.add('pulse'); setTimeout(function () { w0.classList.remove('pulse'); }, 260); }
        setStatus('投射烘焙编辑器已经打开');
        return true;
      }
      var app = st.host && st.host.querySelector('.md-app');
      if (!app) return false;
      meshReady();
      var box = document.createElement('div');
      box.className = 'md-pbwin';
      box.id = 'mdPbWin';
      box.tabIndex = -1;
      box.innerHTML = winHtml();
      app.appendChild(box);
      S.win = box;
      S.open = true;
      S.hover = -1; selSet([]); S.drag = null;
      S.lySel = null;
      /* 每次打开都从「合成视图」进：默认铺的模型贴图和底图同图，
       * 直接显示原画反而和上次关窗前的状态对不上。 */
      S.viewSrc = false;
      /* 视图每次打开都回到 contain：上次放大到 800% 停在某个角落，
       * 重开时用户会以为「原画没载入」 */
      S.leftView = { z: 1, ox: 0, oy: 0 };
      S.camDirty = true;
      S.bakeCv = null; S.bakeSlot = -1; S.bakeDoc = null; S.bakeUrl = null;
      /* 槽号先夹到合法范围再铺下拉框，否则 select.value 会落在一个不存在的项上 */
      var names0 = (st.doc.materials && st.doc.materials.slotNames) || [''];
      S.slot = Math.max(0, Math.min(S.slot || 0, names0.length - 1));
      fillSlotSelect();
      /* 先把「只在材质上」的底座领养进文档，再铺底图 —— 顺序反了的话，
       * 撤销 / 重建材质会把这张图丢掉（见 adoptLiveBase 的说明）。 */
      var adopted = adoptLiveBase();
      bindEvents();
      /* winHtml 里的面板不带 hidden，展开状态要在这里对齐一次 */
      toggleLayerPanel(S.lyOpen);
      bindCamWatch();
      box.focus();
      S.baseUrl = '';
      loadBaseMap();
      autoLoadMap();
      global.requestAnimationFrame(function () {
        if (!S.open) return;
        S.left.w = 0; S.left.h = 0; S.rightV.w = 0; S.rightV.h = 0;
        refreshAll(true);
      });
      setStatus('投射烘焙：右栏按住 UV 岛拖到左栏 —— 每落一个岛就是一层，点「烘焙」写回贴图（Ctrl+Z 可撤销）');
      return true;
    }

    function fillSlotSelect() {
      var sel = $('mdPbSlot');
      if (!sel) return;
      var names = (st.doc && st.doc.materials && st.doc.materials.slotNames) || [];
      if (!names.length) names = ['插槽 1'];
      sel.innerHTML = names.map(function (n, i) {
        return '<option value="' + i + '">' + esc(n || ('插槽 ' + (i + 1))) + '</option>';
      }).join('');
      sel.value = String(S.slot);
      sel.onchange = function () {
        S.slot = Number(sel.value) || 0;
        S.bakeCv = null; S.bakeSlot = -1;
        S.baseUrl = '';           /* 换槽 = 换底图，强制重载 */
        loadBaseMap();
        autoLoadMap();
        requestDraw();
        syncInfo();
      };
    }

    /* 窗口开着时转视角，右栏必须跟着变 —— 否则用户转了相机看右边没反应，
     * 会以为按钮坏了。用防抖：OrbitControls 开阻尼时每帧都 change，停手 700ms 才重算。 */
    var camTimer = 0;
    function onCamMove() {
      if (!S.open) return;
      S.camDirty = true;
      clearTimeout(camTimer);
      camTimer = global.setTimeout(function () {
        if (!S.open || S.drag) return;
        refreshAll(true);
      }, 700);
    }
    function bindCamWatch() {
      if (S.camHooked || !st.controls || !st.controls.addEventListener) return;
      st.controls.addEventListener('change', onCamMove);
      S.camHooked = true;
    }
    function unbindCamWatch() {
      clearTimeout(camTimer);
      if (S.camHooked && st.controls && st.controls.removeEventListener) {
        try { st.controls.removeEventListener('change', onCamMove); } catch (e) {}
      }
      S.camHooked = false;
    }

    function close() {
      if (!S.open) return false;
      unbindCamWatch();
      document.removeEventListener('keydown', onKey, true);
      S.drag = null;
      S.hover = -1;
      if (S.win && S.win.parentNode) S.win.parentNode.removeChild(S.win);
      S.win = null;
      S.open = false;
      S.binds = Object.create(null);
      S.layerOrder = [];
      S.base = { on: true, op: 1 };
      S.baseImg = null; S.baseUrl = ''; S.baseKey = ''; S.baseFrom = ''; S.bakeFrom = '';
      S.lySel = null;
      S.leftView = { z: 1, ox: 0, oy: 0 };
      S.bakeCv = null; S.bakeCtx = null; S.bakeSlot = -1; S.bakeDoc = null; S.bakeBefore = null;
      setStatus('投射烘焙编辑器已关闭');
      return true;
    }

    return {
      open: open,
      close: close,
      refresh: function () { if (S.open) refreshAll(true); },
      bake: bake,
      toast: toast,
      /* 测试钩（tools/probe-projbake.js 用）：只读状态 + 直接建绑定。
       * 拖拽路径要靠真实指针事件测，这个只用来跳过「拖」这步单独验采样。 */
      __debug: function () {
        var nb = 0, k;
        for (k in S.binds) nb++;
        return {
          open: S.open,
          islands: S.islands.length,
          islandBounds: S.islands.length ? S.islands[0].bounds : null,
          bound: nb, binds: JSON.parse(JSON.stringify(S.binds)),
          layers: layerSnap(),
          src: S.srcImg ? { w: S.srcImg.naturalWidth, h: S.srcImg.naturalHeight, name: S.srcName } : null,
          srcView: { on: !!S.viewSrc, hasImg: !!S.srcImg },
          baseMap: S.baseImg ? { w: S.baseImg.naturalWidth || S.baseImg.width, h: S.baseImg.naturalHeight || S.baseImg.height, from: S.baseFrom || S.bakeFrom || '' } : null,
          cam: S.camView ? { w: S.camView.width, h: S.camView.height } : null,
          camInfo: S.camInfo,
          coverage: S.camCoverage, autoFit: !!S.autoFit, overlapPairs: S.overlapPairs || 0,
          idMap: S.idMap ? { w: S.idMap.w, h: S.idMap.h } : null,
          slot: S.slot,
          right: { w: S.rightV.w, h: S.rightV.h, k: (function () { var f = camFit(); return f.k; })() },
          left: { w: S.left.w, h: S.left.h, z: S.leftView.z, ox: S.leftView.ox, oy: S.leftView.oy,
                  s: (function () { var f = leftFit(); return f ? f.s : 0; })() },
          sel: S.sel, hover: S.hover, multi: S.multi.slice()
        };
      },
      /* 选中岛的 8 个把手在画布上的 CSS 坐标（测试直接用，省得在测试里复算拟合） */
      __handles: function (islandId) {
        var isl = islandById(islandId);
        var bind = isl && S.binds[isl.id];
        var fit = leftFit();
        if (!isl || !bind || !fit) return null;
        var r = camBoxIn(isl, bind, fit);
        if (!r) return null;
        var out = [];
        var hs = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
        for (var i = 0; i < hs.length; i++) {
          out.push({ sx: hs[i][0], sy: hs[i][1],
            x: r.x + (hs[i][0] + 1) / 2 * r.w,
            y: r.y + (hs[i][1] + 1) / 2 * r.h });
        }
        return { rect: r, handles: out, fit: fit };
      },
      __bind: function (islandId, cx, cy, s) {
        S.binds[islandId] = { cx: cx, cy: cy, s: s, on: true, op: 1 };
        layerSync();
        renderLayers();
        requestDraw();
        return true;
      },
      /* 落点默认值（拖过去松手时用的那个 s）。探针必须读**实现算出来的**这个数，
       * 自己再复算一遍公式等于测了个副本 —— 上一版「变白」就是公式本身错了。 */
      __defaultBind: function (islandId) {
        var isl = islandById(islandId);
        if (!isl || !S.srcImg) return null;
        var d = defaultBindSize(isl, [islandId]);
        return { s: d.s, sample: d.sample, box: d.box, texel: d.texel };
      },
      /* 图层测试钩：可见性 / 不透明度。真实入口是图层面板里的眼睛和滑块，
       * 那两个走指针，探针里点得到；这里是给「只想验合成结果」的场景用的。 */
      __layers: function () { return layerSnap(); },
      __setLayer: function (key, patch) {
        var b = layerByKey(String(key));
        if (!b) return null;
        if (patch && patch.on != null) b.on = !!patch.on;
        if (patch && patch.op != null) b.op = Math.max(0, Math.min(1, patch.op));
        syncInfo(); renderLayers(); requestDraw();
        return { on: b.on !== false, op: b.op == null ? 1 : b.op };
      },
      __lyRow: function (key) { return lyRowRect(String(key)); },
      __islandPoint: function (islandId) {
        var isl = islandById(islandId);
        if (!isl) return null;
        return islandCanvasPoint(isl);
      },
      __islandIds: function () { return S.islands.map(function (x) { return x.id; }); },
      /* 连选的三件套：探针要能直接问「现在选了谁 / 整组落点算成什么」，
       * 光看画面分辨不出「三个岛刚好挨在一起」和「真的连选了三个」。 */
      __selIds: function () { return S.multi.slice(); },
      __selSet: function (ids) { selSet(ids || []); syncInfo(); renderLayers(); requestDraw(); return S.multi.slice(); },
      __plan: function (group, baseId, pend) { return planGroup(group || S.multi, baseId == null ? S.sel : baseId, pend); },
      /* 单个岛在当前视角下的投影包围盒（相机像素）：连选的相对位置全靠它算，
       * 探针要能独立复算一遍，而不是「相信实现」。 */
      __boxOf: function (id) {
        var isl = islandById(id), g = isl && islandCamGeo(isl);
        return (g && g.box) ? { x0: g.box.x0, y0: g.box.y0, x1: g.box.x1, y1: g.box.y1,
          w: g.box.w, h: g.box.h, cx: g.box.cx, cy: g.box.cy } : null;
      },
      __groupBox: function (ids) { return groupCamBox(ids || S.multi); },
      /* 相机像素 → 画布 CSS 的唯一映射（{x,y,k}）。探针要把 __boxOf 的相机坐标
       * 换算成能点/能查的右栏坐标，只能问实现要，自己复算等于测副本。 */
      __camFit: function () { var f = camFit(); return { x: f.x, y: f.y, k: f.k, iw: f.iw, ih: f.ih }; },
      /* 遮挡剔除开关（诊断/A-B 量具用）：返回当前状态。 */
      __occCull: function (on) {
        OCC_ON = on !== false;
        for (var i = 0; i < S.islands.length; i++) {
          S.islands[i]._cgKey = null;
          S.islands[i]._cg = null;
          S.islands[i]._cgPath = null;
          S.islands[i]._cgRKey = null;
        }
        requestDraw();
        return OCC_ON;
      },
      /* 遮挡剔除的量具：探针要能直接问「这个岛被砍掉了几个三角 / 还有几个在形状里」，
       * 光看画面分辨不出「岛本来就小」和「被挡掉了大半」。 */
      __vis: function (islandId) {
        var isl = islandById(islandId), g = isl && islandCamGeo(isl);
        if (!g) return null;
        return { total: g.visTotal | 0, on: g.visN | 0, culled: (g.visTotal | 0) - (g.visN | 0),
          byOther: g.visOther | 0,
          flag: !!g.vis, idMap: !!S.idMap, sb: g.sb ? g.sb.length : 0 };
      },
      /* 全模型扫一遍：每个岛砍了多少、其中多少是被**别的岛**挡的。
       * 找「鼻子挡住半张脸」的样本只能靠它 —— 挑面积最大的岛往往挑到
       * 「被自己挡住」的那种，并集不变，量不出面积差。 */
      __visAll: function () {
        var out = [];
        for (var i = 0; i < S.islands.length; i++) {
          var isl = S.islands[i], g = islandCamGeo(isl);
          if (!g || !g.visTotal) continue;
          out.push({ id: isl.id, total: g.visTotal | 0, on: g.visN | 0,
            culled: (g.visTotal | 0) - (g.visN | 0), byOther: g.visOther | 0 });
        }
        return out;
      },
      /* 「每个岛真正露在外面有多少像素」—— 直接数 id 位图，和剔除逻辑无关。
       * 这是量具的地面真值：形状面积应当 ≈ 这个数。 */
      __visAreas: function () {
        var M = S.idMap;
        if (!M || !ensureIdData(M)) return null;
        var d = M.data, cnt = Object.create(null), i, id, k;
        for (i = 0; i < d.length; i += 4) {
          if (d[i] < 120) continue;
          id = d[i + 1] | (d[i + 2] << 8);
          cnt[id] = (cnt[id] || 0) + 1;
        }
        var out = [];
        for (k in cnt) out.push({ id: Number(k) - 1, px: cnt[k] });
        out.sort(function (a, b) { return b.px - a.px; });
        return out;
      },
      /* 形状（三角并集）在相机像素空间盖住多少像素，顺便报出「本岛露着的像素数」。
       * 两者接近 = 形状就是所见那块；远大于 = 还是完整一块岛没被剔。 */
      __shapeArea: function (islandId) {
        var isl = islandById(islandId), M = S.idMap;
        if (!isl || !M) return null;
        var p = islandCamPath(isl);
        if (!p) return null;
        var cv = document.createElement('canvas');
        cv.width = M.w; cv.height = M.h;
        var x = cv.getContext('2d', { willReadFrequently: true });
        if (!x) return null;
        x.setTransform(M.kx, 0, 0, M.ky, 0, 0);
        x.fillStyle = '#fff';
        x.fill(p, 'nonzero');
        var d = x.getImageData(0, 0, M.w, M.h).data, n = 0, i;
        for (i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
        if (!ensureIdData(M)) return { shape: n, visPx: 0, ratio: 0 };
        var vp = 0, want = isl.id + 1, md = M.data;
        for (i = 0; i < md.length; i += 4) {
          if (md[i] >= 120 && (md[i + 1] | (md[i + 2] << 8)) === want) vp++;
        }
        return { shape: n, visPx: vp, ratio: vp ? +(n / vp).toFixed(3) : 0 };
      },
      /* **所有岛**的形状面积一次量完：每个岛用自己 id 的颜色把「剔除后的形状」
       * 栅格化到一张图上再数像素。和 __visAreas 并排看，就是全模型一张
       * 「形状 vs 真正露着的面积」对照表 —— 单量一个岛很容易挑到「被自己挡」
       * （并集不变），看不出跨岛遮挡到底有没有生效。 */
      __shapeAreas: function () {
        var M = S.idMap;
        if (!M) return null;
        var cv = document.createElement('canvas');
        cv.width = M.w; cv.height = M.h;
        var x = cv.getContext('2d', { willReadFrequently: true });
        if (!x) return null;
        x.setTransform(M.kx, 0, 0, M.ky, 0, 0);
        for (var i = 0; i < S.islands.length; i++) {
          var p = islandCamPath(S.islands[i]);
          if (!p) continue;
          x.fillStyle = idColor(S.islands[i].id + 1, 255);
          x.fill(p, 'nonzero');
        }
        var d = x.getImageData(0, 0, M.w, M.h).data, cnt = Object.create(null), j, key;
        for (j = 0; j < d.length; j += 4) {
          if (d[j] < 120) continue;
          key = d[j + 1] | (d[j + 2] << 8);
          cnt[key] = (cnt[key] || 0) + 1;
        }
        var out = [];
        for (var k in cnt) out.push({ id: Number(k) - 1, shape: cnt[k] });
        return out;
      },
      /* 左栏画面上「落点框内到底有多少像素被挖亮」：遮挡生效后这个数必须变小。
       * 只数**落点框内**的差值，避免整幅画布的压缩噪声干扰。 */
      __punchArea: function (islandId) {
        var isl = islandById(islandId), cv = $('mdPbLeft');
        var bind = isl && S.binds[isl.id], fit = leftFit();
        if (!isl || !bind || !fit || !cv) return null;
        var r = camBoxIn(isl, bind, fit);
        if (!r) return null;
        var x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
        var x1 = Math.min(cv.width, Math.ceil(r.x + r.w)), y1 = Math.min(cv.height, Math.ceil(r.y + r.h));
        if (x1 <= x0 || y1 <= y0) return null;
        var d = cv.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
        var lum = 0;
        for (var i = 0; i < d.length; i += 4) lum += d[i] + d[i + 1] + d[i + 2];
        /* 框的坐标也还回去：A/B 对比图要把这一块放大裁出来，
         * 探针自己拿 camBoxIn 复算等于测副本（踩过一次，别再来）。 */
        return { lum: lum, w: x1 - x0, h: y1 - y0, x0: x0, y0: y0, x1: x1, y1: y1 };
      },
      __pick: function (x, y) { var i = islandAtCanvas(x, y); return i ? i.id : -1; },
      /* 左栏「点在哪、命中了谁」的中间量。左栏命中是「投影包围盒初筛 + isPointInPath 精判」，
       * 两处各有坐标系陷阱（CSS / 原图像素 / device），出问题时只有把中间量摊开才看得见。 */
      __hit: function (x, y) {
        var fit = leftFit(), cv = $('mdPbLeft');
        if (!fit || !cv) return { err: 'no fit' };
        var dpr = S.left.dpr || 1, c2 = cv.getContext('2d'), hits = [];
        for (var i = 0; i < S.islands.length; i++) {
          var isl = S.islands[i], b = S.binds[isl.id];
          if (!b) continue;
          var cb = camBoxIn(isl, b, fit);
          var q = camPathIn(isl, b, fit);
          var inBox = !!(cb && x >= cb.x && x <= cb.x + cb.w && y >= cb.y && y <= cb.y + cb.h);
          var inPath = (q && c2) ? c2.isPointInPath(q, x * dpr, y * dpr) : null;
          hits.push({ id: isl.id, cb: cb, inBox: inBox, inPath: inPath });
        }
        return { fit: fit, dpr: dpr, left: { w: S.left.w, h: S.left.h }, hits: hits };
      },
      __setSrc: function (img) { S.srcImg = img; S.srcName = '测试原画'; syncInfo(); requestDraw(); },
      __camUrl: function () { try { return S.camView ? S.camView.toDataURL('image/png') : ''; } catch (e) { return ''; } },
      __rightUrl: function () { try { var c = $('mdPbRight'); return c ? c.toDataURL('image/png') : ''; } catch (e) { return ''; } },
      __bake: bake
    };
  }

  global.MDProjBake = { create: create };
})(window);
