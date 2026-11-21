/* 特征提取台（apps/featlab）的窗口 DOM。
 * 只导出字符串；app-scan 会把它排在 app.js 之前内联进 manifest。
 *
 * 右栏是四个 tab（提取 / 图集 / 提示词 / 标注）：三栏宽度只有 330px，
 * 全摊开会纵向滚到看不见按钮。tab 只切 display，input 始终在 DOM 里，
 * 取值口径不变（唯一真源仍是 S.opt / S.pmt）。 */
window.FEATLAB_BODY = `
<div class="featlab-shell">
  <header class="featlab-top">
    <div class="featlab-brand">
      <span class="featlab-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="3"/>
          <path d="M9.1 3.4v17.2M14.9 3.4v17.2M3.4 9.1h17.2M3.4 14.9h17.2"/>
          <rect x="9.9" y="9.9" width="9.4" height="9.4" rx="1.6" fill="currentColor" fill-opacity=".18" stroke="none"/>
        </svg>
      </span>
      <div class="featlab-brand-t"><b>特征提取台</b><i>人工框选 · AI 定位复核 · 九宫格图集标注</i></div>
    </div>
    <div class="featlab-tools">
      <div class="featlab-toolgrp" role="group" aria-label="画布工具">
        <button type="button" class="featlab-tool on" data-tool="select" title="选择 / 移动 / 缩放（V）">选择</button>
        <button type="button" class="featlab-tool" data-tool="add" title="拖拽框选新特征（R）">框选</button>
        <button type="button" class="featlab-tool" data-tool="pan" title="平移画布（H，或按住空格）">平移</button>
      </div>
      <span class="featlab-sep"></span>
      <button type="button" class="featlab-btn" data-act="undo" title="撤销（Ctrl+Z）">撤销</button>
      <button type="button" class="featlab-btn" data-act="redo" title="重做（Ctrl+Y）">重做</button>
      <span class="featlab-sep"></span>
      <button type="button" class="featlab-btn sq" data-act="zoom-out" title="缩小">−</button>
      <span class="featlab-zoom" id="featlabZoom">100%</span>
      <button type="button" class="featlab-btn sq" data-act="zoom-in" title="放大">＋</button>
      <button type="button" class="featlab-btn" data-act="fit" title="适应窗口（F）">适应</button>
      <span class="featlab-sep"></span>
      <button type="button" class="featlab-btn primary" data-act="import">导入图片</button>
      <input type="file" id="featlabFile" accept="image/*" multiple hidden>
    </div>
  </header>

  <div class="featlab-main">
    <aside class="featlab-rail">
      <div class="featlab-block">
        <div class="featlab-block-h"><b>源图</b><span id="featlabSrcHint">最多 3 张</span></div>
        <div class="featlab-srcs" id="featlabSrcs"></div>
      </div>
      <div class="featlab-block grow">
        <div class="featlab-block-h"><b>特征区域</b><span id="featlabCount">0 / 9</span></div>
        <div class="featlab-list" id="featlabList"></div>
        <div class="featlab-listfoot">
          <button type="button" class="featlab-btn sm" data-act="add-region">＋ 新增区域</button>
          <button type="button" class="featlab-btn sm ghost" data-act="clear-regions">清空</button>
        </div>
      </div>
    </aside>

    <section class="featlab-center">
      <div class="featlab-viewwrap" id="featlabViewport">
        <canvas id="featlabCanvas"></canvas>
        <div class="featlab-empty" id="featlabEmpty">
          <div class="featlab-empty-card">
            <b>把图片拖进来</b>
            <span>支持 PNG / JPEG / WebP，最多 3 张；也可以 Ctrl+V 直接粘贴</span>
            <button type="button" class="featlab-btn primary" data-act="import">选择图片</button>
          </div>
        </div>
        <div class="featlab-hud">
          <span id="featlabHudPos">—</span>
          <span id="featlabHudInfo"></span>
        </div>
        <div class="featlab-busy" id="featlabBusy" hidden>
          <div class="featlab-busy-card">
            <span class="featlab-spin"></span>
            <b id="featlabBusyText">处理中…</b>
            <span id="featlabBusySub"></span>
            <button type="button" class="featlab-btn sm" data-act="cancel-ai">停止</button>
          </div>
        </div>
      </div>
      <div class="featlab-inspect" id="featlabInspect"></div>
    </section>

    <aside class="featlab-panel">
      <div class="featlab-tabs" role="tablist" aria-label="右侧面板">
        <button type="button" class="featlab-tab on" data-ftab="ext" role="tab">提取</button>
        <button type="button" class="featlab-tab" data-ftab="atlas" role="tab">图集</button>
        <button type="button" class="featlab-tab" data-ftab="prompt" role="tab">提示词</button>
        <button type="button" class="featlab-tab" data-ftab="ann" role="tab">标注</button>
      </div>

      <div class="featlab-tabwrap">
        <div class="featlab-tabpage on" data-tab="ext">
          <section class="featlab-sec">
            <div class="featlab-sec-h"><b>AI 提取</b><span>开放工作要求</span></div>
            <label class="featlab-field"><span>工作要求</span>
              <textarea id="featlabReq" rows="3" spellcheck="false" placeholder="例：定位人物的头部位（发髻 / 眼睛 / 眉毛 / 耳朵）与身体部位（衣领 / 胸部 / 手部 / 腰带 / 鞋部），每个部位一个区域。留空则由 AI 挑最值得关注的 9 个细节区域"></textarea>
            </label>
            <div class="featlab-row2">
              <label class="featlab-field"><span>主体</span><input id="featlabSubject" type="text" value="人物" spellcheck="false"></label>
              <label class="featlab-field"><span>范围</span>
                <select id="featlabScope"><option value="all">全部源图</option><option value="active">当前源图</option></select>
              </label>
            </div>
            <div class="featlab-actions">
              <button type="button" class="featlab-btn primary" data-act="ai-extract">AI 提取特征</button>
              <button type="button" class="featlab-btn" data-act="ai-name" title="给手工框选或未命名区域自动命名">AI 命名</button>
              <button type="button" class="featlab-btn" data-act="ai-verify" title="让模型逐格判断是否确实是对应部位">AI 复核</button>
            </div>
            <label class="featlab-check"><input type="checkbox" id="featlabVerify" checked> 提取后自动逐格复核（多一次调用）</label>
          </section>
          <section class="featlab-sec">
            <div class="featlab-sec-h"><b>右键即复制</b><span>画布 / 缩略图 / 预览</span></div>
            <p class="featlab-note">在画布上右键，可复制该区域小图、整张源图或九宫格图集；在源图缩略图与图集预览上右键同样可复制。图片直接进系统剪切板，粘贴到任何地方都不用先存盘。</p>
          </section>
        </div>

        <div class="featlab-tabpage" data-tab="atlas">
          <section class="featlab-sec">
            <div class="featlab-sec-h"><b>图集</b><span id="featlabAtlasInfo">3×3</span></div>
            <div class="featlab-grid3">
              <label class="featlab-field"><span>单元尺寸</span>
                <select id="featlabCell"><option value="256">256</option><option value="384">384</option><option value="512" selected>512</option></select>
              </label>
              <label class="featlab-field"><span>外扩边距</span><input id="featlabMargin" type="number" min="0" max="100" step="5" value="30"></label>
              <label class="featlab-field"><span>格间距</span>
                <select id="featlabGap"><option value="0">0</option><option value="6">6</option><option value="12">12</option></select>
              </label>
            </div>
            <div class="featlab-row2">
              <label class="featlab-field"><span>底色</span><input id="featlabBg" type="color" value="#15181d"></label>
              <label class="featlab-check"><input type="checkbox" id="featlabBadge" checked> 格内序号</label>
            </div>
            <label class="featlab-check"><input type="checkbox" id="featlabLabels"> 格内名称</label>
            <div class="featlab-preview" id="featlabPreviewWrap"><canvas id="featlabPreview"></canvas><span id="featlabPreviewHint">还没有可拼的区域</span></div>
            <div class="featlab-actions">
              <button type="button" class="featlab-btn primary" data-act="build">拼图集</button>
              <button type="button" class="featlab-btn" data-act="copy-atlas">复制图集</button>
              <button type="button" class="featlab-btn" data-act="export-png">导出 PNG</button>
              <button type="button" class="featlab-btn" data-act="export-json">导出 JSON</button>
            </div>
          </section>
        </div>

        <div class="featlab-tabpage" data-tab="prompt">
          <section class="featlab-sec">
            <div class="featlab-sec-h"><b>提示词表单</b><span>填空即出词</span></div>
            <div class="featlab-row2">
              <label class="featlab-field"><span>主体</span>
                <input id="featlabPmSubject" type="text" list="featlabPmSubjectList" spellcheck="false" placeholder="人物 / 少女 / 手办">
                <datalist id="featlabPmSubjectList">
                  <option value="人物"></option><option value="少女"></option><option value="男性"></option>
                  <option value="产品"></option><option value="手办"></option><option value="机械"></option>
                  <option value="建筑"></option><option value="动物"></option><option value="场景"></option>
                </datalist>
              </label>
              <label class="featlab-field"><span>用途</span>
                <select id="featlabPmUse">
                  <option value="图生图参考">图生图参考</option>
                  <option value="局部重绘">局部重绘</option>
                  <option value="三视图">三视图</option>
                  <option value="纹理参考">纹理参考</option>
                  <option value="通用生图">通用生图</option>
                </select>
              </label>
            </div>
            <div class="featlab-row2">
              <label class="featlab-field"><span>风格</span>
                <select id="featlabPmStyle">
                  <option value="">（不限定）</option>
                  <option>写实摄影</option><option>电影感</option><option>二次元插画</option>
                  <option>3D 渲染</option><option>国风水墨</option><option>厚涂</option>
                  <option>线稿</option><option>像素</option><option>手办模型</option><option>赛博朋克</option>
                </select>
              </label>
              <label class="featlab-field"><span>视角 / 构图</span>
                <input id="featlabPmAngle" type="text" list="featlabPmAngleList" spellcheck="false" placeholder="四分之三侧">
                <datalist id="featlabPmAngleList">
                  <option value="正面"></option><option value="四分之三侧"></option><option value="侧面"></option>
                  <option value="俯视"></option><option value="仰视"></option><option value="特写"></option><option value="全身"></option>
                </datalist>
              </label>
            </div>
            <div class="featlab-row2">
              <label class="featlab-field"><span>材质 / 媒介</span>
                <input id="featlabPmMaterial" type="text" list="featlabPmMaterialList" spellcheck="false" placeholder="树脂 / 布料">
                <datalist id="featlabPmMaterialList">
                  <option value="树脂"></option><option value="黏土"></option><option value="金属"></option>
                  <option value="布料"></option><option value="陶瓷"></option><option value="次表面散射皮肤"></option><option value="塑料"></option>
                </datalist>
              </label>
              <label class="featlab-field"><span>色彩</span>
                <input id="featlabPmPalette" type="text" list="featlabPmPaletteList" spellcheck="false" placeholder="低饱和">
                <datalist id="featlabPmPaletteList">
                  <option value="低饱和"></option><option value="高对比"></option><option value="莫兰迪"></option>
                  <option value="冷暖对比"></option><option value="单色"></option><option value="金属灰"></option>
                </datalist>
              </label>
            </div>
            <div class="featlab-row2">
              <label class="featlab-field"><span>光照</span>
                <input id="featlabPmLight" type="text" list="featlabPmLightList" spellcheck="false" placeholder="柔和侧光">
                <datalist id="featlabPmLightList">
                  <option value="柔和侧光"></option><option value="顶光"></option><option value="伦勃朗光"></option>
                  <option value="边缘光"></option><option value="环境光"></option><option value="棚拍柔光"></option>
                </datalist>
              </label>
              <label class="featlab-field"><span>背景</span>
                <input id="featlabPmBg" type="text" list="featlabPmBgList" spellcheck="false" placeholder="纯白背景">
                <datalist id="featlabPmBgList">
                  <option value="纯白背景"></option><option value="浅灰渐变"></option><option value="透明背景"></option>
                  <option value="影棚背景"></option><option value="虚化景深"></option><option value="纯黑背景"></option>
                </datalist>
              </label>
            </div>
            <label class="featlab-field"><span>细节（特征）</span>
              <textarea id="featlabPmDetails" rows="2" spellcheck="false" placeholder="发髻、衣领、腰带…（点「填入特征」自动取当前区域名）"></textarea>
            </label>
            <label class="featlab-field"><span>备注 / 补充</span>
              <input id="featlabPmExtra" type="text" spellcheck="false" placeholder="例：站姿，双手交叠放在身前">
            </label>
            <div class="featlab-chips" id="featlabPmQuality">
              <span class="featlab-chips-lbl">质量词</span>
              <button type="button" class="featlab-chip" data-q="超清细节">超清细节</button>
              <button type="button" class="featlab-chip" data-q="高精度纹理">高精度纹理</button>
              <button type="button" class="featlab-chip" data-q="锐利边缘">锐利边缘</button>
              <button type="button" class="featlab-chip" data-q="电影级调色">电影级调色</button>
              <button type="button" class="featlab-chip" data-q="8K">8K</button>
            </div>
            <label class="featlab-field"><span>负面提示词</span>
              <textarea id="featlabPmNeg" rows="2" spellcheck="false" placeholder="模糊，低清，畸变，水印，文字"></textarea>
            </label>
          </section>

          <section class="featlab-sec">
            <div class="featlab-sec-h"><b>生成结果</b><span id="featlabPmState">中文</span></div>
            <div class="featlab-seg" role="group" aria-label="输出语言">
              <button type="button" class="featlab-seg-btn on" data-pmlang="zh">中文</button>
              <button type="button" class="featlab-seg-btn" data-pmlang="en">英文</button>
              <button type="button" class="featlab-seg-btn" data-pmlang="both">双语</button>
            </div>
            <textarea id="featlabPmOut" class="featlab-ann" rows="7" spellcheck="false" placeholder="填完表单自动生成，也可以直接改；改过就不再被覆盖。"></textarea>
            <div class="featlab-actions">
              <button type="button" class="featlab-btn primary" data-act="copy-prompt">复制提示词</button>
              <button type="button" class="featlab-btn" data-act="copy-negative">复制负面词</button>
              <button type="button" class="featlab-btn" data-act="pm-regions">填入特征</button>
              <button type="button" class="featlab-btn ghost" data-act="pm-reset">恢复自动</button>
            </div>
          </section>
        </div>

        <div class="featlab-tabpage" data-tab="ann">
          <section class="featlab-sec">
            <div class="featlab-sec-h"><b>图集标注</b><span id="featlabAnnState">自动</span></div>
            <p class="featlab-note">在左边「特征区域」每一格下面写那一句标注，这里会自动拼成整段；也可以直接改这一段，改完变「手动」。</p>
            <textarea id="featlabAnn" class="featlab-ann" rows="7" spellcheck="false" placeholder="逐格写完自动生成；也可以直接改，改完不再自动覆盖。"></textarea>
            <div class="featlab-actions">
              <button type="button" class="featlab-btn primary" data-act="copy-ann">复制标注</button>
              <button type="button" class="featlab-btn ghost" data-act="auto-ann">恢复自动</button>
            </div>
          </section>
        </div>
      </div>

      <section class="featlab-sec featlab-logsec">
        <div class="featlab-sec-h"><b>运行日志</b><span>最近 6 条</span></div>
        <div class="featlab-log" id="featlabLog"></div>
      </section>
    </aside>
  </div>

  <footer class="featlab-foot">
    <span class="featlab-status" id="featlabStatus">就绪</span>
    <span class="featlab-tip">V 选择 · R 框选 · 方向键微调 · Alt+方向键调边 · 右键复制 · Ctrl+Z 撤销</span>
  </footer>

  <div class="featlab-ctx" id="featlabCtx" hidden role="menu"></div>
</div>`;
