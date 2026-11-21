/* 流明 3D 数字人的窗口 DOM（app-scan 会把它排在 app.js 之前内联）。
 *
 * 参考脸来自 LumenAct 的公开演示资源，几何、形态键与表演曲线都打包在 model/ 下，
 * file:// 断网也能渲染；canvas 由 app.js 用仓库自带的 three.js 建出来。
 *
 * 版式：左侧展示区常驻三维预览，右侧检查器常驻（对话 / 捏脸 / 纹理），
 * 编辑面板不再以浮层盖住脸，画布宽度由 flex 自动让出。 */
window.LUMEN3D_BODY = `
<div class="l3-app" id="l3App">
  <div class="l3-shell">
  <section class="l3-stage" id="l3Stage">
    <div class="l3-canvas" id="l3Canvas"></div>

    <div class="l3-stagebar">
      <div class="l3-modebar" id="l3Modes" role="group" aria-label="编辑模式">
        <button type="button" id="l3LookBtn" data-mode="shape">捏脸</button>
        <button type="button" data-mode="texture">纹理</button>
        <button type="button" data-mode="chat" class="on">对话</button>
      </div>
      <div class="l3-views" id="l3Views">
        <button type="button" data-view="front" class="on">正面</button>
        <button type="button" data-view="left">左侧</button>
        <button type="button" data-view="right">右侧</button>
        <button type="button" data-view="top">俯视</button>
      </div>
    </div>

    <div class="l3-hud">
      <span class="l3-chip" id="l3State">正在加载脸模…</span>
      <span class="l3-chip l3-chip-soft" id="l3Expr">自然放松</span>
    </div>

    <div class="l3-hint">拖动旋转 · 滚轮缩放</div>

    <div class="l3-loading" id="l3Loading">
      <div class="l3-spin"></div>
      <div class="l3-loading-text">正在解析脸模与表演曲线…</div>
    </div>
  </section>

  <aside class="l3-inspector" id="l3Drawer" data-tab="chat" aria-label="检查器">
    <header class="l3-head">
      <div class="l3-title-wrap">
        <div class="l3-title">流明 · 3D 数字人</div>
        <div class="l3-sub">参考脸演示 · 非商用</div>
      </div>
      <button type="button" class="l3-toggle" id="l3VoiceBtn" aria-pressed="true">朗读 开</button>
    </header>

    <div class="l3-insp-tabs" role="tablist" aria-label="检查器页签">
      <button type="button" data-tab="chat" class="on">对话</button>
      <button type="button" data-tab="shape">捏脸</button>
      <button type="button" data-tab="texture">纹理</button>
    </div>

    <div class="l3-drawer-body">
      <div class="l3-pane l3-pane-chat" data-pane="chat">
        <div class="l3-msgs" id="l3Msgs" aria-live="polite"></div>

        <div class="l3-quick" id="l3Quick"></div>

        <form class="l3-form" id="l3Form">
          <textarea id="l3Input" rows="1" spellcheck="false" placeholder="和流明说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button type="submit" class="l3-send" id="l3Send">发送</button>
        </form>

        <div class="l3-tools">
          <label class="l3-field">
            <span>表情</span>
            <select id="l3Style"></select>
          </label>
          <button type="button" class="l3-btn" id="l3Play">播放</button>
          <button type="button" class="l3-btn" id="l3Neutral">自然</button>
        </div>

        <div class="l3-tools l3-tools-voice">
          <label class="l3-field l3-field-wide">
            <span>音色</span>
            <select id="l3Voice"></select>
          </label>
          <button type="button" class="l3-btn" id="l3Test">试听</button>
          <span class="l3-engine" id="l3Engine">系统语音</span>
        </div>
      </div>

      <div class="l3-pane l3-pane-shape" data-pane="shape" hidden>
        <div class="l3-preset-bar">
          <span class="l3-preset-label">预设</span>
          <div class="l3-preset-list" id="l3ShapePresets"></div>
        </div>
        <div class="l3-shape-actions">
          <button type="button" class="l3-btn" id="l3ShapeRandom">随机捏脸</button>
          <button type="button" class="l3-btn" id="l3ShapeUndo">撤销</button>
          <button type="button" class="l3-btn" id="l3ShapeRedo">重做</button>
          <button type="button" class="l3-btn" id="l3ShapeSave">存为预设</button>
          <button type="button" class="l3-btn" id="l3ShapeReset">复原</button>
        </div>
        <div class="l3-shape-save" id="l3ShapeSaveRow" hidden>
          <input type="text" id="l3ShapeSaveName" maxlength="12" placeholder="预设名称（12 字以内）">
          <button type="button" class="l3-btn l3-btn-primary" id="l3ShapeSaveOk">保存</button>
          <button type="button" class="l3-btn" id="l3ShapeSaveCancel">取消</button>
        </div>
        <div class="l3-sculpt">
          <div class="l3-sculpt-head">
            <span class="l3-sculpt-title">三维直接操控</span>
            <label class="l3-sculpt-switch">
              <input type="checkbox" id="l3GizmoOn" checked>
              <span>在脸上拖动</span>
            </label>
          </div>
          <div class="l3-sculpt-groups" id="l3GizmoGroups" role="group" aria-label="操控点分组">
            <button type="button" data-gizmo-group="轮廓" class="on">轮廓</button>
            <button type="button" data-gizmo-group="眼睛">眼睛</button>
            <button type="button" data-gizmo-group="鼻子">鼻子</button>
            <button type="button" data-gizmo-group="嘴部">嘴部</button>
          </div>
          <div class="l3-coil-bar">
            <label class="l3-sculpt-switch">
              <input type="checkbox" id="l3CoilOn" checked>
              <span>面高亮</span>
            </label>
            <label class="l3-sculpt-switch">
              <input type="checkbox" id="l3OutlineOn" checked>
              <span>轮廓线</span>
            </label>
            <button type="button" class="l3-btn l3-btn-mini" id="l3CoilReset">重置选区</button>
          </div>
          <p class="l3-sculpt-hint" id="l3SculptHint">按住脸上的圆点往外拉就变大、往里推就收窄；模型表面亮起来的覆层，就是这个参数真正会影响到的范围，拖选区上的小圆点可以改范围。</p>
          <div class="l3-curve">
            <div class="l3-curve-head">
              <span>轮廓曲线</span>
              <span class="l3-curve-tip">也可直接拖画布上的轮廓点</span>
            </div>
            <svg id="l3CurveSvg" viewBox="0 0 240 132" role="img" aria-label="脸型轮廓曲线"></svg>
          </div>
        </div>
        <div class="l3-shape-subtitle">精细参数</div>
        <div class="l3-shape-list" id="l3ShapeList"></div>
        <p class="l3-pane-tip">拖动滑杆或直接输入数值；双击名称 / 数值可单项复位，参数会自动保存。</p>
      </div>

      <div class="l3-pane l3-pane-tex" data-pane="texture" hidden>
        <div class="l3-texbar">
          <div class="l3-toolgroup">
            <button type="button" data-tool="brush" class="on">画笔</button>
            <button type="button" data-tool="eraser">橡皮</button>
            <button type="button" data-tool="bucket">填充</button>
            <button type="button" data-tool="pick">吸管</button>
          </div>
          <label class="l3-mini">粗细
            <input type="range" id="l3TexSize" min="2" max="160" value="36">
            <span id="l3TexSizeVal">36</span>
          </label>
          <label class="l3-mini">颜色 <input type="color" id="l3TexColor" value="#e05a5a"></label>
          <label class="l3-mini">容差
            <input type="range" id="l3TexTol" min="0" max="120" value="36">
            <span id="l3TexTolVal">36</span>
          </label>
        </div>
        <div class="l3-regionbar">
          <span class="l3-regionlabel">绘制区域</span>
          <div class="l3-regionlist" id="l3TexRegions" role="group" aria-label="纹理绘制区域"></div>
        </div>
        <p class="l3-regionhint" id="l3TexRegionHint">按区域独立绘制：只改选中部位对应的 UV，左侧三维预览实时同步。</p>
        <div class="l3-texview" id="l3TexView">
          <div class="l3-texpad">
            <div class="l3-texstack">
              <canvas id="l3TexCanvas" width="2048" height="2048"></canvas>
              <canvas id="l3TexVeil" width="2048" height="2048" aria-hidden="true"></canvas>
            </div>
          </div>
        </div>
        <div class="l3-texfoot">
          <div class="l3-adjrow">
            <label class="l3-mini">亮度 <input type="range" id="l3AdjBright" min="-100" max="100" value="0"></label>
            <label class="l3-mini">对比 <input type="range" id="l3AdjContrast" min="-100" max="100" value="0"></label>
            <label class="l3-mini">饱和 <input type="range" id="l3AdjSat" min="-100" max="100" value="0"></label>
            <button type="button" class="l3-btn" id="l3AdjApply">应用调整</button>
          </div>
          <div class="l3-adjrow">
            <label class="l3-mini">源色 <input type="color" id="l3RepFrom" value="#f4c9c9"></label>
            <label class="l3-mini">目标 <input type="color" id="l3RepTo" value="#d8e8ff"></label>
            <button type="button" class="l3-btn" id="l3RepRun">相似色替换</button>
          </div>
          <div class="l3-texrow">
            <button type="button" class="l3-btn" id="l3TexUndo">撤销</button>
            <button type="button" class="l3-btn" id="l3TexRedo">重做</button>
            <button type="button" class="l3-btn" id="l3TexReset">重置</button>
            <button type="button" class="l3-btn" id="l3TexExport">导出 PNG</button>
            <button type="button" class="l3-btn l3-btn-primary" id="l3TexApply">应用到模型</button>
          </div>
        </div>
      </div>
    </div>
  </aside>
  </div>
</div>
`;
