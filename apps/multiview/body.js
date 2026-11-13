/* 视图工坊（多视图）的窗口 DOM —— 桌面 App 与独立页 multiview.html **共用这一份**。
 *
 * 为什么单独放一个文件：这个 App 是唯一同时有独立页的（multiview.html，双击就能用、
 * 不需要桌面）。以前 index.html 和 multiview.html 里各抄了一份 .mv-wrap（209 / 220 行、
 * 96 个 id），改一个控件要改两处，漏一处就是「桌面能用、独立页少个按钮」。
 * 现在两边都从这里取，**只有一份**。
 *
 * ⚠ 两份原来只差空态的两句文案（独立页写「点左上「＋ 文件」」，但那个按钮其实在左侧栏里，
 *   文案是错的）。统一成桌面版的说法：左边选一个 -> ＋ 文件 -> 拖进来，三种入口都覆盖到。
 *
 * ⚠ 桌面侧由 apps/multiview/app.js 的 registerApp() 取用（tools/app-scan.js 会把本文件
 *   先内联进 manifest）；独立页自己 <script src="apps/multiview/body.js"> 再赋给宿主。
 *   所以这里**只定义常量，不调 registerApp** —— 独立页没有那个函数。
 *
 * 全篇没有反引号 / ${ / 反斜杠（生成时校验过），所以能直接放进模板字符串。
 */
window.MV_BODY = `
<div class="mv-wrap">

          <aside class="mv-side">
            <div class="mv-side-head">
              <span class="mv-side-t">模型</span>
              <button type="button" class="mv-mini" id="mvOpenFile" title="打开本机的 glb / gltf / obj">＋ 文件</button>
            </div>
            <div class="mv-list" id="mvList"></div>
            <div class="mv-side-foot">
              <button type="button" class="mv-mini wide" id="mvOpenLib">打开模型库</button>
            </div>
            <input type="file" id="mvFile" class="hidden" accept=".glb,.gltf,.obj">
          </aside>

          <section class="mv-main">
            <div class="mv-ctl">
              <div class="mv-row">
                <span class="mv-lab">视图</span>
                <div class="mv-chips" id="mvPresets"></div>
                <div class="mv-chips" id="mvViews"></div>
              </div>
              <div class="mv-row">
                <span class="mv-lab">模式</span>
                <div class="mv-seg" id="mvModes"></div>
                <span class="mv-lab">相机</span>
                <div class="mv-seg" id="mvCams"></div>
                <span class="mv-lab">画布</span>
                <div class="mv-seg" id="mvSizes"></div>
              </div>
            </div>

            <details class="mv-more" id="mvMore">
              <summary title="画布级参数：列数、间距、留白、线宽——它们不属于任何一层">画布</summary>
              <div class="mv-more-body">
                <div class="mv-field"><span>列数</span><div class="mv-seg" id="mvCols"></div></div>
                <div class="mv-field"><span>铺满</span><div class="mv-seg" id="mvCompacts"></div></div>
                <div class="mv-field"><span>间距</span><input type="range" id="mvGap" min="0" max="48" step="2"><b id="mvGapV">0</b></div>
                <div class="mv-field"><span>留白</span><input type="range" id="mvMargin" min="100" max="160" step="2"><b id="mvMarginV">108</b></div>
                <div class="mv-field"><span>线宽</span><input type="range" id="mvLineW" min="4" max="60" step="2"><b id="mvLineWV">14</b></div>
                <button type="button" class="mv-mini" id="mvReset" title="把画布与各层参数恢复默认（不动已载入的模型）">恢复默认参数</button>
              </div>
            </details>

            <div class="mv-stage-wrap" id="mvStageHost">
              <div class="mv-stage" id="mvStage">
                <div class="mv-stage-hud" id="mvStageHud">
                  <b id="mvHudName">未载入</b>
                  <i id="mvHudMeta">等待模型</i>
                </div>
                <div class="mv-empty" id="mvEmpty">
                  <div class="mv-empty-t">左边选一个模型，或拖一个 glb / obj 进来</div>
                  <div class="mv-empty-s">OBJ 的四边形面按原始拓扑画线框，不会出现三角化的对角线。</div>
                </div>
                <img id="mvOut" alt="多视图结果" draggable="false" class="hidden">
                <div class="mv-pick hidden" id="mvPick"></div>
              </div>
            </div>

            <div class="mv-bar">
              <span class="mv-info" id="mvInfo"></span>
              <button type="button" class="btn sm" id="mvPreview">3D 预览</button>
              <button type="button" class="btn sm" id="mvSplit" disabled>AI 拆件</button>
              <button type="button" class="btn sm" id="mvSaveLib">存入图库</button>
              <button type="button" class="btn sm" id="mvDlCell" disabled>下载这格</button>
              <button type="button" class="btn sm" id="mvDlAll" disabled>下载整图</button>
              <button type="button" class="btn sm primary" id="mvRender">重新渲染</button>
            </div>
          </section>

          <!-- 右：图层 / 导出 / 投射 三个工作面板。做成互斥页签，
               一列堆三块面板时导出按钮会被挤到滚动区外，专业工具不该这样。 -->
      <aside class="mv-right">
        <div class="mv-right-tabs" id="mvRightTabs" role="tablist">
          <button type="button" class="mv-rtab is-on" data-mv-tab="layers" role="tab" aria-selected="true">图层</button>
          <button type="button" class="mv-rtab" data-mv-tab="export" role="tab" aria-selected="false">导出</button>
          <button type="button" class="mv-rtab" data-mv-tab="proj" role="tab" aria-selected="false">投射</button>
        </div>
        <div class="mv-right-panes">

          <!-- ① 图层：上层盖下层的心理模型，与 PS 一致 -->
          <div class="mv-right-pane is-on" data-pane="layers">
            <div class="mv-layers">
              <div class="mv-ly-head">图层<span class="mv-ly-hint" title="点一行展开它自己的属性面板；拖动可以任意换序，3D 和 2D 之间也能互换">点行调属性 · 随便拖</span></div>
              <div class="mv-ly-list" id="mvLayerList"></div>
            </div>
            <!-- 图层的眼睛驱动这些 input；留在这里是为了「state 只有一条写入口」 -->
            <div class="mv-hidden-checks">
      <input type="checkbox" id="mvWire">
      <input type="checkbox" id="mvAngleWire">
      <input type="checkbox" id="mvUvEdge">
      <input type="checkbox" id="mvUvIsland">
      <input type="checkbox" id="mvOutline">
      <input type="checkbox" id="mvDepthEdge">
      <input type="checkbox" id="mvDepthGray">
      <input type="checkbox" id="mvLabels">
      <input type="checkbox" id="mvBg">
      <input type="checkbox" id="mvGrade">
            </div>
            <!-- 层参数的控件都住在这里，被选中/展开的那一层才搬进它自己的面板。
                 不另建一套 input：id 仍是 FIELDS 认的那一个，写入口只有一条。 -->
            <div class="mv-prop-pool" id="mvPropPool">
          <div class="mv-field"><span>背景色</span><input type="color" id="mvBgColor" value="#ffffff"></div>
          <div class="mv-field"><span>折角</span><input type="range" id="mvWireAngle" min="0" max="90" step="1"><b id="mvWireAngleV">30°</b></div>
          <div class="mv-field" title="角度线框的整体粗细（相对「线宽」的倍率）。只想让结构线更醒目、又不想把普通线框一起加粗时用它"><span>角度粗细</span><input type="range" id="mvCreaseWidth" min="20" max="300" step="10"><b id="mvCreaseWidthV">1.0×</b></div>
          <div class="mv-field" title="随折角的粗细梯度：0% 所有结构线等宽；100% 折得越狠越粗（90° 硬边最粗，刚过阈值的平缓边约 1/4 宽）"><span>随角度</span><input type="range" id="mvCreaseTaper" min="0" max="100" step="5"><b id="mvCreaseTaperV">50%</b></div>
          <div class="mv-field" title="角度线框的颜色：换个颜色才分得清「哪几条是结构线、哪几条是普通线框」"><span>角度线色</span><input type="color" id="mvCreaseColor" value="#2b2b2b"></div>
          <div class="mv-field" title="相邻像素的深度差阈值（占整个视锥深度的百分比）：往左描得更多，往右只留最强的边。分辨率变了会自动补偿，换单格尺寸不用重调"><span>深度差</span><input type="range" id="mvDepthThresh" min="0" max="100" step="1"><b id="mvDepthThreshV">1.1%</b></div>
          <div class="mv-field" title="深度灰的映射窗口：100% 用模型完整的前后跨度，调小只保留靠近相机的一段（远处压成黑）。模型前后差得小、灰图看不出一层一层时，把它调小"><span>深度范围</span><input type="range" id="mvDepthGrayRange" min="10" max="100" step="5"><b id="mvDepthGrayRangeV">100%</b></div>
          <div class="mv-field" title="「无限远」的颜色：背景（没有表面）和格间距都填它。默认黑，跟「近白远黑」接得上；改成白就得到反过来的那一版（近黑远白）"><span>远景色</span><input type="color" id="mvDepthGrayBg" value="#000000"></div>
          <div class="mv-field" title="饱和度：0 是黑白，100% 是原样，200% 是色彩更艳。后期处理层调的是最终输出图像"><span>饱和度</span><input type="range" id="mvGradeSat" min="0" max="200" step="5"><b id="mvGradeSatV">100%</b></div>
          <div class="mv-field" title="对比度：100% 是原样，往上更硬朗、往下更灰雾"><span>对比度</span><input type="range" id="mvGradeContrast" min="0" max="200" step="5"><b id="mvGradeContrastV">100%</b></div>
          <div class="mv-field" title="亮度：正值提亮、负值压暗，范围 ±100"><span>亮度</span><input type="range" id="mvGradeBright" min="-100" max="100" step="5"><b id="mvGradeBrightV">0</b></div>
            </div>
          </div>

          <!-- ② 导出：画布固定正方形 2K/4K，深度 / 遮罩供 AI 回流 -->
          <div class="mv-right-pane hidden" data-pane="export">
            <aside class="mv-export">
              <div class="mv-ex-head">导出</div>
              <div class="mv-ex-row">
                <select class="mv-sel" id="mvExSize" title="画布尺寸（正方形）· 预览与导出一致">
                  <option value="2048">2K · 2048</option>
                  <option value="4096">4K · 4096</option>
                </select>
                <select class="mv-sel" id="mvExGap" title="格间距">
                  <option value="0">无间距</option>
                  <option value="16">16 px</option>
                  <option value="32">32 px</option>
                  <option value="64">64 px</option>
                </select>
              </div>
              <div class="mv-ex-info" id="mvExInfo"></div>
              <div class="mv-ex-stats" id="mvExStats"></div>
              <!-- 导出反馈：忙碌时黄点+扫光进度，成功绿点，失败红点，结果留到下一次导出 -->
              <div class="mv-ex-status hidden" id="mvExStatus"><i></i><span id="mvExStatusTxt"></span></div>
              <button type="button" class="btn sm primary" id="mvExPreview" disabled>预览导出结果</button>
              <button type="button" class="btn sm" id="mvExColor" disabled>导出视图 PNG</button>
              <button type="button" class="btn sm" id="mvExDepth" disabled>导出深度图</button>
              <button type="button" class="btn sm" id="mvExMask" disabled>导出遮罩图</button>
            </aside>
          </div>

          <!-- ③ 投射：生图 → UV 贴图。参数常驻在这里，重新投射不必重选文件 -->
          <div class="mv-right-pane hidden" data-pane="proj">
            <aside class="mv-export mv-proj-entry">
              <div class="mv-ex-head">投射纹理</div>
              <div class="mv-ex-info">AI 生成的网格图逐格反投回模型，按 UV 岛归类采样，烘成一张贴图</div>
              <div class="mv-ex-row">
                <select class="mv-sel" id="mvProjSize" title="贴图分辨率（UV 空间）">
                  <option value="1024">1K · 1024</option>
                  <option value="2048" selected>2K · 2048</option>
                  <option value="4096">4K · 4096</option>
                </select>
                <button type="button" class="btn sm primary" id="mvProj" disabled title="选一张 AI 生成的网格图（或直接 Ctrl+V 粘贴截图）">导入生图投射</button>
                <button type="button" class="btn sm" id="mvProjReproj" disabled title="用上次导入的图按当前参数重新烘一次">重新投射上次的图</button>
              </div>
              <input type="file" id="mvProjFile" class="hidden" accept="image/*">
              <div class="mv-ex-head">投射参数</div>
              <div class="mv-proj-set">
                <div class="mv-field" title="岛的边界往内缩多少 texel：躲开 AI 重绘造成的轮廓漂移。0 = 完全贴边，边缘更容易串色"><span>边缘内缩</span><input type="range" id="mvProjInset" min="0" max="4" step="1"><b id="mvProjInsetV">1 px</b></div>
                <div class="mv-field" title="次优视图补角的触发门槛（占最佳视图暴露面积的比例）。0 = 只从最佳视图采样；调高 = 少补、边缘更硬"><span>补角阈值</span><input type="range" id="mvProjFill" min="0" max="60" step="5"><b id="mvProjFillV">15%</b></div>
                <div class="mv-field" title="把岛边缘的颜色向外扩散几个 texel，抵消实时渲染的接缝。0 = 严格保持透明边界"><span>接缝扩散</span><input type="range" id="mvProjBleed" min="0" max="8" step="1"><b id="mvProjBleedV">0 px</b></div>
                <label class="mv-check mv-proj-check" title="有些模型的 UV V 轴与导出图相反：贴图上下颠倒时勾上它"><input type="checkbox" id="mvProjFlipV"> V 轴翻转</label>
              </div>
              <div class="mv-ex-info" id="mvProjQuick">选一张与当前导出布局对齐的生图</div>
            </aside>
          </div>

        </div>
      </aside>

          <!-- AI 拆件弹层：遮住整个 .mv-wrap。里面的控件 id 与 multiview.html 必须完全一致 -->
          <div class="mv-split hidden" id="mvSplitPanel">
            <div class="mv-split-card">
              <div class="mv-split-head">
                <span class="mv-split-title">AI 拆件</span>
                <span class="mv-split-sub" id="mvSplitSub"></span>
                <button type="button" class="mv-split-x" id="mvSplitClose" aria-label="关闭">×</button>
              </div>
              <div class="mv-split-body">
                <div class="mv-split-row">
                  <span class="mv-split-lab">分成</span>
                  <input type="text" id="mvSplitParts" class="mv-split-in" placeholder="面部和脖子、头发和头饰、身体">
                  <span class="mv-split-lab">候选岛</span>
                  <input type="range" id="mvSplitMax" min="20" max="240" step="10" value="120">
                  <b id="mvSplitMaxV">120</b>
                  <button type="button" class="btn sm primary" id="mvSplitRun">开始拆件</button>
                </div>
                <div class="mv-split-note" id="mvSplitInfo"></div>
                <div class="mv-split-imgs">
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">候选 UV 岛（编号给 AI 寻址）</span>
                    <img id="mvSplitAtlas" alt="候选 UV 岛图" class="hidden">
                  </div>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">拆件结果（颜色对应部件）</span>
                    <img id="mvSplitViews" alt="拆件结果预览" class="hidden">
                  </div>
                </div>
                <div class="mv-split-list" id="mvSplitList"></div>
                <div class="mv-split-foot">
                  <button type="button" class="btn sm" id="mvSplitDlGlb" disabled>下载整件 GLB</button>
                  <button type="button" class="btn sm" id="mvSplitSaveLib" disabled>存入模型库</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 投射纹理弹层：遮住整个 .mv-wrap。里面的控件 id 与 multiview.html 必须完全一致 -->
          <div class="mv-split hidden" id="mvProjPanel">
            <div class="mv-split-card">
              <div class="mv-split-head">
                <span class="mv-split-title">投射纹理</span>
                <span class="mv-split-sub" id="mvProjSub"></span>
                <button type="button" class="mv-split-x" id="mvProjClose" aria-label="关闭">×</button>
              </div>
              <div class="mv-split-body">
                <div class="mv-proj-body">
                  <aside class="mv-proj-side">
                    <span class="mv-split-cap">生图源</span>
                    <div class="mv-proj-src" id="mvProjSrcBox">
                      <img id="mvProjSrc" alt="生图源">
                      <em id="mvProjSrcEmpty">还没有导入</em>
                    </div>
                    <div class="mv-proj-stat" id="mvProjStats"></div>
                    <div class="mv-proj-tip">参数在右侧「投射」页调整<br>改完点「重新投射」即可复烘</div>
                  </aside>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">UV 贴图（透明 = 未投射的区域）</span>
                    <img id="mvProjOut" alt="投射纹理结果" class="hidden">
                  </div>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">上色预览（材质模式 · 自动生成）</span>
                    <img id="mvProjPrev" alt="投射上色预览" class="hidden">
                  </div>
                </div>
                <div class="mv-split-note" id="mvProjInfo"></div>
                <div class="mv-ex-status hidden" id="mvProjStatus"><i></i><span id="mvProjStatusTxt"></span></div>
                <div class="mv-proj-prog hidden" id="mvProjProg">
                  <i id="mvProjProgBar"></i>
                  <span id="mvProjProgTxt">投射中…</span>
                </div>
                <div class="mv-split-foot">
                  <button type="button" class="btn sm primary" id="mvProjDl" disabled>下载贴图 PNG</button>
                  <button type="button" class="btn sm" id="mvProjGlb" disabled>下载上色 GLB</button>
                  <button type="button" class="btn sm" id="mvProjLib" disabled>存入图库</button>
                  <button type="button" class="btn sm" data-mv-proj-reproj disabled title="按右侧「投射」页的当前参数重新烘一次">重新投射</button>
                </div>
              </div>
            </div>
          </div>
          </div>
`;
