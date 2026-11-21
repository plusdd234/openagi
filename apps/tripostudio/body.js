/* Tripo 工坊 —— 窗口 DOM 骨架。
 *
 * 只放静态结构，所有行为在 app.js。body.js 由 app-scan 自动排在 app.js 之前内联，
 * 所以 app.js 里可以直接 `body: window.TPS_BODY`。
 */
window.TPS_BODY = `
<div class="tps-app" data-panel="image" data-stage="empty">
  <header class="tps-bar">
    <div class="tps-brand">
      <span class="tps-brand-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3.1 20 7.5v9L12 20.9 4 16.5v-9l8-4.4Z"/>
          <path d="m4 7.5 8 4.4 8-4.4M12 11.9v9"/>
          <path d="M8.1 5.3 16 9.6"/>
        </svg>
      </span>
      <span class="tps-brand-text">
        <b>Tripo 工坊</b>
        <small>IMAGE · MODEL · TEXTURE</small>
      </span>
    </div>

    <nav class="tps-menus" data-role="menus" aria-label="主菜单">
      <div class="tps-menu" data-menu>
        <button class="tps-menu-btn" type="button">文件</button>
        <div class="tps-menu-pop">
          <button type="button" data-act="importImage">导入图像…<kbd>Ctrl+O</kbd></button>
          <button type="button" data-act="importModel">导入模型…</button>
          <button type="button" data-act="importTexture">导入纹理…</button>
          <hr>
          <button type="button" data-act="exportImage">导出当前图像</button>
          <button type="button" data-act="exportModel">导出当前模型 GLB</button>
          <button type="button" data-act="pinAsset">保存到本地资产</button>
          <hr>
          <button type="button" data-act="clearAll">清空项目</button>
        </div>
      </div>
      <div class="tps-menu" data-menu>
        <button class="tps-menu-btn" type="button">编辑</button>
        <div class="tps-menu-pop">
          <button type="button" data-act="copyPrompt">复制提示词</button>
          <button type="button" data-act="copyUrl">复制资源地址</button>
          <button type="button" data-act="removeAsset">删除当前资源<kbd>Del</kbd></button>
          <hr>
          <button type="button" data-act="imageToRef">当前图像 → 参考图</button>
          <button type="button" data-act="imageToTexture">当前图像 → 模型纹理</button>
        </div>
      </div>
      <div class="tps-menu" data-menu>
        <button class="tps-menu-btn" type="button">视图</button>
        <div class="tps-menu-pop">
          <button type="button" data-act="fit">适应窗口<kbd>F</kbd></button>
          <button type="button" data-act="actual">实际大小<kbd>1:1</kbd></button>
          <button type="button" data-act="toggleGrid">网格显示</button>
          <button type="button" data-act="toggleBg">切换背景</button>
          <button type="button" data-act="toggleInspect">检查器</button>
          <hr>
          <button type="button" data-act="panel" data-panel="image">生图面板<kbd>1</kbd></button>
          <button type="button" data-act="panel" data-panel="model">模型面板<kbd>2</kbd></button>
          <button type="button" data-act="panel" data-panel="texture">纹理面板<kbd>3</kbd></button>
          <button type="button" data-act="panel" data-panel="assets">资产面板<kbd>4</kbd></button>
        </div>
      </div>
      <div class="tps-menu" data-menu>
        <button class="tps-menu-btn" type="button">生成</button>
        <div class="tps-menu-pop">
          <button type="button" data-act="genImage">生成图像<kbd>Ctrl+↵</kbd></button>
          <button type="button" data-act="genModel">生成模型</button>
          <button type="button" data-act="genTexture">生成并应用纹理</button>
          <hr>
          <button type="button" data-act="pullBack">拉回生成结果…</button>
          <button type="button" data-act="pullAll">校验全部资源</button>
        </div>
      </div>
      <div class="tps-menu" data-menu>
        <button class="tps-menu-btn" type="button">帮助</button>
        <div class="tps-menu-pop">
          <button type="button" data-act="login">打开 Tripo 登录页</button>
          <button type="button" data-act="about">关于 Tripo 工坊</button>
        </div>
      </div>
    </nav>

    <div class="tps-conn" data-role="conn">
      <i class="tps-dot" data-role="connDot"></i>
      <span class="tps-conn-text" data-role="connText">检测助手…</span>
      <button class="tps-mini" type="button" data-act="connCheck">检测</button>
      <button class="tps-mini hidden" type="button" data-act="toggleEmbed" data-role="embedBtn" title="在工坊内打开 Tripo 网页">内嵌</button>
      <button class="tps-mini tps-mini-accent" type="button" data-act="login">登录</button>
    </div>
  </header>

  <div class="tps-body">
    <nav class="tps-rail" aria-label="工作区">
      <button class="tps-rail-btn is-on" type="button" data-panel="image" title="生图 (1)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4"/><circle cx="8.8" cy="9.8" r="1.5"/><path d="m4.2 16.6 4.6-4.2 3.4 2.8 3-2.4 4.2 3.8"/></svg>
        <span>生图</span>
      </button>
      <button class="tps-rail-btn" type="button" data-panel="model" title="生模型 (2)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6l8-4.4Z"/><path d="m4 7.6 8 4.4 8-4.4M12 12v8.8"/></svg>
        <span>模型</span>
      </button>
      <button class="tps-rail-btn" type="button" data-panel="texture" title="纹理 (3)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.6" y="3.6" width="7.2" height="7.2" rx="1.6"/><rect x="13.2" y="3.6" width="7.2" height="7.2" rx="1.6"/><rect x="3.6" y="13.2" width="7.2" height="7.2" rx="1.6"/><rect x="13.2" y="13.2" width="7.2" height="7.2" rx="1.6"/></svg>
        <span>纹理</span>
      </button>
      <div class="tps-rail-sp"></div>
      <button class="tps-rail-btn" type="button" data-panel="assets" title="资产 (4)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 4.4h6.6a2.6 2.6 0 0 1 2.6 2.6v8.6"/><rect x="3.4" y="7" width="13.4" height="13.4" rx="2.4"/><circle cx="7.6" cy="11.6" r="1.3"/><path d="m4.4 18.4 3-2.8a1.5 1.5 0 0 1 2.1 0l1.6 1.5 1.1-1a1.5 1.5 0 0 1 2.1 0l1.4 1.3"/></svg>
        <span>资产</span>
      </button>
    </nav>

    <aside class="tps-side" data-role="side">
      <section class="tps-pane" data-pane="image">
        <div class="tps-pane-head">
          <span class="tps-pane-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4"/><circle cx="8.8" cy="9.8" r="1.5"/><path d="m4.2 16.6 4.6-4.2 3.4 2.8 3-2.4 4.2 3.8"/></svg>
          </span>
          <div class="tps-pane-copy">
            <span class="tps-eyebrow">Generate</span>
            <h3>生图</h3>
            <p>Tripo 网页 · 文生图 / 图生图</p>
          </div>
        </div>
        <div class="tps-sec">
          <label class="tps-label" for="tpsImgPrompt">提示词 <span class="tps-muted" data-role="imgPromptCount">0 / 1200</span></label>
          <textarea class="tps-textarea" id="tpsImgPrompt" rows="5" data-form="image.prompt" maxlength="1200" placeholder="描述画面主体、风格、材质、光照与构图…"></textarea>
          <div class="tps-chips">
            <button type="button" class="tps-chip" data-chip="image.prompt" data-text="角色三视图，正面 / 侧面 / 背面，全身，纯色背景，均匀光照，高细节">角色三视图</button>
            <button type="button" class="tps-chip" data-chip="image.prompt" data-text="游戏道具，单个物体，居中构图，纯色背景，PBR 细节，高精度">游戏道具</button>
            <button type="button" class="tps-chip" data-chip="image.prompt" data-text="无缝贴图，四方连续，无接缝，顶视图平铺，均匀光照，无阴影，高细节">无缝贴图</button>
          </div>
        </div>
        <div class="tps-sec">
          <div class="tps-label">参考图（最多 3 张，可拖入）</div>
          <div class="tps-refs" data-role="imgRefs">
            <div class="tps-ref" data-ref="image:0" role="button" tabindex="0"><img alt=""><span class="tps-ref-plus">＋</span><b class="tps-ref-x" data-x="image:0" title="移除">×</b><i class="tps-ref-tag">1</i></div>
            <div class="tps-ref" data-ref="image:1" role="button" tabindex="0"><img alt=""><span class="tps-ref-plus">＋</span><b class="tps-ref-x" data-x="image:1" title="移除">×</b><i class="tps-ref-tag">2</i></div>
            <div class="tps-ref" data-ref="image:2" role="button" tabindex="0"><img alt=""><span class="tps-ref-plus">＋</span><b class="tps-ref-x" data-x="image:2" title="移除">×</b><i class="tps-ref-tag">3</i></div>
          </div>
        </div>
        <div class="tps-sec">
          <div class="tps-row">
            <label class="tps-field">模式
              <select class="tps-select" data-form="image.mode">
                <option value="auto">自动（有参考图走图生图）</option>
                <option value="text">文生图</option>
                <option value="image">图生图</option>
              </select>
            </label>
            <label class="tps-field">比例
              <select class="tps-select" data-form="image.ratio">
                <option value="1:1">1:1</option>
                <option value="16:9">16:9</option>
                <option value="9:16">9:16</option>
                <option value="4:3">4:3</option>
                <option value="3:4">3:4</option>
                <option value="auto">自动（跟随页面）</option>
              </select>
            </label>
          </div>
          <label class="tps-field">超时
            <input class="tps-input" type="number" min="10" max="900" step="10" data-form="image.timeout">
            <span class="tps-unit">秒</span>
          </label>
        </div>
        <div class="tps-sec tps-sec-actions">
          <button class="tps-primary" type="button" data-act="genImage">生成图像 <kbd>Ctrl+↵</kbd></button>
          <p class="tps-hint">走 Tripo 网页账号，不消耗 API Key；生成结果会自动载入编辑器并进入项目资源。</p>
        </div>
      </section>

      <section class="tps-pane hidden" data-pane="model">
        <div class="tps-pane-head">
          <span class="tps-pane-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6l8-4.4Z"/><path d="m4 7.6 8 4.4 8-4.4M12 12v8.8"/></svg>
          </span>
          <div class="tps-pane-copy">
            <span class="tps-eyebrow">Generate</span>
            <h3>生模型</h3>
            <p>图生 3D · 单图或多视图</p>
          </div>
        </div>
        <div class="tps-sec">
          <div class="tps-seg" data-role="modelSeg">
            <button type="button" class="is-on" data-mmode="single">单图</button>
            <button type="button" data-mmode="multi">多视图</button>
          </div>
        </div>
        <div class="tps-sec" data-role="modelSingle">
          <div class="tps-label">参考图（单张）</div>
          <div class="tps-refs tps-refs-one">
            <div class="tps-ref tps-ref-wide" data-ref="model:single" role="button" tabindex="0"><img alt=""><span class="tps-ref-plus">＋ 上传参考图</span><b class="tps-ref-x" data-x="model:single" title="移除">×</b></div>
          </div>
          <button class="tps-mini" type="button" data-act="refFromCurrent" data-target="model:single">用当前图像</button>
        </div>
        <div class="tps-sec hidden" data-role="modelMulti">
          <div class="tps-label">多视图参考（前 / 左 / 右 / 后，至少一张）</div>
          <div class="tps-refs tps-refs-views">
            <div class="tps-ref" data-ref="model:front" role="button" tabindex="0"><img alt=""><span class="tps-ref-plus">＋</span><i class="tps-ref-tag">前</i><b class="tps-ref-x" data-x="model:front" title="移除">×</b></div>
            <div class="tps-ref" data-ref="model:left" role="button" tabindex="0"><img alt=""><span class="tps-ref-plus">＋</span><i class="tps-ref-tag">左</i><b class="tps-ref-x" data-x="model:left" title="移除">×</b></div>
            <div class="tps-ref" data-ref="model:right" role="button" tabindex="0"><img alt=""><span class="tps-ref-plus">＋</span><i class="tps-ref-tag">右</i><b class="tps-ref-x" data-x="model:right" title="移除">×</b></div>
            <div class="tps-ref" data-ref="model:back" role="button" tabindex="0"><img alt=""><span class="tps-ref-plus">＋</span><i class="tps-ref-tag">后</i><b class="tps-ref-x" data-x="model:back" title="移除">×</b></div>
          </div>
          <div class="tps-minirow">
            <button class="tps-mini" type="button" data-act="refFromCurrent" data-target="model:front">当前图像 → 前视图</button>
            <button class="tps-mini" type="button" data-act="refFromModel" data-target="model:front">模型截图 → 前视图</button>
          </div>
        </div>
        <div class="tps-sec">
          <div class="tps-row">
            <label class="tps-field">模式
              <select class="tps-select" data-form="model.mode">
                <option value="smart">智能网格</option>
                <option value="hd">高精度模型</option>
                <option value="">页面默认</option>
              </select>
            </label>
            <label class="tps-field">网格版本
              <select class="tps-select" data-form="model.version">
                <option value="P2.0">P2.0</option>
                <option value="P1.0">P1.0</option>
                <option value="">页面默认</option>
              </select>
            </label>
          </div>
          <div class="tps-row">
            <label class="tps-field">拓扑
              <select class="tps-select" data-form="model.topology">
                <option value="">页面默认</option>
                <option value="quad">四边面</option>
                <option value="tri">三角面</option>
              </select>
            </label>
            <label class="tps-field">面数
              <input class="tps-input" type="number" min="0" max="25000" step="100" data-form="model.faceCount">
            </label>
          </div>
          <div class="tps-row">
            <label class="tps-field">数量
              <select class="tps-select" data-form="model.count">
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="4">4</option>
              </select>
            </label>
            <label class="tps-field">格式
              <select class="tps-select" data-form="model.format">
                <option value="">页面默认</option>
                <option value="glb">GLB</option>
                <option value="obj">OBJ</option>
                <option value="fbx">FBX</option>
                <option value="stl">STL</option>
                <option value="usdz">USDZ</option>
              </select>
            </label>
          </div>
          <label class="tps-field">超时
            <input class="tps-input" type="number" min="30" max="1800" step="30" data-form="model.timeout">
            <span class="tps-unit">秒</span>
          </label>
        </div>
        <div class="tps-sec tps-sec-actions">
          <button class="tps-primary" type="button" data-act="genModel">生成模型</button>
          <p class="tps-hint">走网页自动化，会消耗网页账号积分；生成完成后模型自动进入 3D 视口。</p>
        </div>
      </section>

      <section class="tps-pane hidden" data-pane="texture">
        <div class="tps-pane-head">
          <span class="tps-pane-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.6" y="3.6" width="7.2" height="7.2" rx="1.6"/><rect x="13.2" y="3.6" width="7.2" height="7.2" rx="1.6"/><rect x="3.6" y="13.2" width="7.2" height="7.2" rx="1.6"/><rect x="13.2" y="13.2" width="7.2" height="7.2" rx="1.6"/></svg>
          </span>
          <div class="tps-pane-copy">
            <span class="tps-eyebrow">Material</span>
            <h3>生成纹理</h3>
            <p>无缝贴图 · 直接贴到当前模型</p>
          </div>
        </div>
        <div class="tps-sec">
          <label class="tps-label" for="tpsTexPrompt">纹理描述 <span class="tps-muted" data-role="texPromptCount">0 / 800</span></label>
          <textarea class="tps-textarea" id="tpsTexPrompt" rows="4" data-form="tex.prompt" maxlength="800" placeholder="例如：深灰色做旧皮革，细密划痕，接缝处有浅色包边…"></textarea>
          <div class="tps-chips">
            <button type="button" class="tps-chip" data-chip="tex.prompt" data-text="无缝布料，细密织物纹理，轻微磨损，均匀光照，四方连续">无缝布料</button>
            <button type="button" class="tps-chip" data-chip="tex.prompt" data-text="深色木纹，清晰年轮与细裂纹，哑光，四方连续">木纹</button>
            <button type="button" class="tps-chip" data-chip="tex.prompt" data-text="拉丝金属，银灰色，细密划痕，各向异性高光">金属拉丝</button>
            <button type="button" class="tps-chip" data-chip="tex.prompt" data-text="卡通平涂，干净色块，手绘描边细节，四方连续">卡通平涂</button>
          </div>
          <label class="tps-check"><input type="checkbox" data-form="tex.fromModel"> 以当前模型视图为参考</label>
        </div>
        <div class="tps-sec">
          <div class="tps-row">
            <label class="tps-field">平铺
              <input class="tps-range" type="range" min="1" max="8" step="1" data-form="tex.tile">
              <output class="tps-out" data-role="texTileOut">2</output>
            </label>
            <label class="tps-field">粗糙度
              <input class="tps-range" type="range" min="0" max="1" step="0.01" data-form="tex.roughness">
              <output class="tps-out" data-role="texRoughOut">0.62</output>
            </label>
          </div>
          <label class="tps-field">金属度
            <input class="tps-range" type="range" min="0" max="1" step="0.01" data-form="tex.metalness">
            <output class="tps-out" data-role="texMetalOut">0.00</output>
          </label>
          <label class="tps-field">超时
            <input class="tps-input" type="number" min="10" max="900" step="10" data-form="tex.timeout">
            <span class="tps-unit">秒</span>
          </label>
        </div>
        <div class="tps-sec tps-sec-actions">
          <button class="tps-primary" type="button" data-act="genTexture">生成并应用纹理</button>
          <div class="tps-minirow">
            <button class="tps-mini" type="button" data-act="genTextureOnly">仅生成纹理</button>
            <button class="tps-mini" type="button" data-act="clearTexture">移除纹理</button>
          </div>
          <p class="tps-hint">纹理作为基础色贴图叠加到当前模型材质；可在检查器里实时调平铺、粗糙度与金属度。</p>
        </div>
      </section>

      <section class="tps-pane hidden" data-pane="assets">
        <div class="tps-pane-head">
          <span class="tps-pane-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3.4 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4"/><path d="m4 16.6 8 4 8-4"/></svg>
          </span>
          <div class="tps-pane-copy">
            <span class="tps-eyebrow">Library</span>
            <h3>项目资源</h3>
            <p>生成结果与本地导入统一管理</p>
          </div>
        </div>
        <div class="tps-sec">
          <div class="tps-filters" data-role="assetFilters">
            <button type="button" class="is-on" data-filter="all">全部</button>
            <button type="button" data-filter="image">图像</button>
            <button type="button" data-filter="model">模型</button>
            <button type="button" data-filter="texture">纹理</button>
          </div>
          <div class="tps-assetlist" data-role="assetList"></div>
        </div>
        <div class="tps-sec tps-sec-actions">
          <div class="tps-minirow">
            <button class="tps-mini" type="button" data-act="importImage">导入图像</button>
            <button class="tps-mini" type="button" data-act="importModel">导入模型</button>
          </div>
          <button class="tps-primary" type="button" data-act="pullBack">拉回生成结果…</button>
          <p class="tps-hint">「拉回」可以把 Tripo 助手输出目录、图床或本地中转里的结果重新接回项目，生成记录不会丢。</p>
        </div>
      </section>
    </aside>

    <main class="tps-stage">
      <div class="tps-stagebar">
        <div class="tps-toolgroup" data-role="tools2d">
          <button type="button" data-act="fit" title="适应窗口 (F)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>适应
          </button>
          <button type="button" data-act="actual" title="实际大小">1:1</button>
          <button type="button" data-act="zoomOut" title="缩小">−</button>
          <span class="tps-zoomtext" data-role="zoomText">100%</span>
          <button type="button" data-act="zoomIn" title="放大">＋</button>
          <span class="tps-toolsep"></span>
          <button type="button" data-act="toggleGrid" data-toggle="grid">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M9 3.5v17M15 3.5v17M3.5 9h17M3.5 15h17"/></svg>网格
          </button>
        </div>
        <div class="tps-toolgroup hidden" data-role="tools3d">
          <button type="button" data-act="fit" title="适应窗口 (F)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>适应
          </button>
          <select class="tps-select tps-select-mini" data-role="camPreset" title="相机视角">
            <option value="persp">透视</option>
            <option value="front">前</option>
            <option value="back">后</option>
            <option value="left">左</option>
            <option value="right">右</option>
            <option value="top">顶</option>
          </select>
          <span class="tps-toolsep"></span>
          <div class="tps-seg tps-seg-mini" data-role="matSeg">
            <button type="button" class="is-on" data-mat="texture">材质</button>
            <button type="button" data-mat="clay">白模</button>
            <button type="button" data-mat="wire">线框</button>
          </div>
          <span class="tps-toolsep"></span>
          <button type="button" data-act="toggleGrid" data-toggle="grid">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M9 3.5v17M15 3.5v17M3.5 9h17M3.5 15h17"/></svg>网格
          </button>
          <button type="button" data-act="toggleRotate" data-toggle="rotate">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v4.5h-4.5"/></svg>旋转
          </button>
          <button type="button" data-act="shot">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="6.5" width="17" height="13" rx="2.4"/><circle cx="12" cy="13" r="3.2"/><path d="M8.6 6.5 10 4.2h4l1.4 2.3"/></svg>截图
          </button>
          <button type="button" data-act="exportModel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/></svg>导出 GLB
          </button>
        </div>
        <div class="tps-stagetitle" data-role="stageTitle">未选择资源</div>
        <div class="tps-busy hidden" data-role="busy">
          <i class="tps-spin"></i>
          <span data-role="busyText">生成中…</span>
          <button type="button" data-act="cancel">取消</button>
        </div>
      </div>

      <div class="tps-viewport" data-role="viewport">
        <div class="tps-imgstage" data-role="imgStage">
          <div class="tps-imgtile" data-role="imgTile"><img data-role="img" alt=""></div>
          <div class="tps-gridoverlay hidden" data-role="grid2d"></div>
          <div class="tps-empty" data-role="empty">
            <div class="tps-emptyicon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4"/><circle cx="8.8" cy="9.8" r="1.5"/><path d="m4.2 16.6 4.6-4.2 3.4 2.8 3-2.4 4.2 3.8"/></svg>
            </div>
            <b>生成或拉回一张图像</b>
            <p>左侧填写提示词开始生图；也可以把图片拖进这里，或从「文件 → 导入图像」进入项目。</p>
          </div>
        </div>
        <div class="tps-scene3d hidden" data-role="scene3d">
          <div class="tps-3dhost" data-role="host3d"></div>
        </div>
        <div class="tps-missing hidden" data-role="missing">
          <b>资源暂不可用</b>
          <p data-role="missingText">文件可能已被清理，或本地助手尚未启动。</p>
          <div class="tps-minirow">
            <button class="tps-mini" type="button" data-act="retryAsset">重试加载</button>
            <button class="tps-mini" type="button" data-act="pinAsset">保存到本地资产</button>
          </div>
        </div>
        <div class="tps-dropmask hidden" data-role="dropmask"><b>松开以导入</b><span>图像 / GLB / glTF / OBJ / FBX</span></div>

        <!-- 内嵌 Tripo 网页：登录和生成都在这个 guest 里完成，桌面版专用 -->
        <div class="tps-embed hidden" data-role="embed">
          <div class="tps-embed-bar">
            <b>Tripo 网页</b>
            <span class="tps-embed-state" data-role="embedState">连接中…</span>
            <span class="tps-spacer"></span>
            <button class="tps-mini" type="button" data-act="embedHome">打开工作台</button>
            <button class="tps-mini" type="button" data-act="embedReload">刷新</button>
            <button class="tps-mini" type="button" data-act="embedClose">切回编辑器</button>
          </div>
          <div class="tps-embed-host" data-role="embedHost"></div>
          <div class="tps-embed-note" data-role="embedNote">内嵌网页仅在桌面版可用；登录、生图和下载都在这个页面里完成。</div>
        </div>
      </div>

      <footer class="tps-stagefoot">
        <span data-role="assetMeta">—</span>
        <span class="tps-spacer"></span>
        <span data-role="stageHint">就绪</span>
      </footer>
    </main>

    <aside class="tps-inspect" data-role="inspect">
      <div class="tps-inspect-head">
        <span>检查器</span>
        <button type="button" class="tps-mini" data-act="toggleInspect" title="收起检查器">«</button>
      </div>
      <div class="tps-inspect-body">
        <section class="tps-insp-sec">
          <h4>资源信息</h4>
          <dl class="tps-info" data-role="info"><dt>资源</dt><dd>未选择</dd></dl>
        </section>
        <section class="tps-insp-sec" data-role="texSec">
          <h4>模型纹理</h4>
          <div class="tps-insp-controls">
            <label class="tps-field">平铺
              <input class="tps-range" type="range" min="1" max="8" step="1" data-form="tex.tile">
              <output class="tps-out" data-role="texTileOut2">2</output>
            </label>
            <label class="tps-field">粗糙度
              <input class="tps-range" type="range" min="0" max="1" step="0.01" data-form="tex.roughness">
              <output class="tps-out" data-role="texRoughOut2">0.62</output>
            </label>
            <label class="tps-field">金属度
              <input class="tps-range" type="range" min="0" max="1" step="0.01" data-form="tex.metalness">
              <output class="tps-out" data-role="texMetalOut2">0.00</output>
            </label>
          </div>
          <div class="tps-minirow">
            <button class="tps-mini" type="button" data-act="applyCurrentTexture">应用纹理</button>
            <button class="tps-mini" type="button" data-act="clearTexture">移除</button>
          </div>
        </section>
        <section class="tps-insp-sec">
          <h4>任务</h4>
          <div class="tps-queue" data-role="queue">空闲</div>
        </section>
        <section class="tps-insp-sec tps-insp-log">
          <h4>日志 <button type="button" class="tps-mini" data-act="clearLog">清空</button></h4>
          <div class="tps-log" data-role="log"></div>
        </section>
      </div>
    </aside>
  </div>

  <div class="tps-timeline">
    <div class="tps-timeline-head">
      <div class="tps-timeline-title">项目资源 <span class="tps-count" data-role="assetCount">0</span></div>
      <div class="tps-timeline-actions">
        <button type="button" data-act="pullBack">拉回结果…</button>
        <button type="button" data-act="pullAll">校验</button>
        <button type="button" data-act="clearAll">清空</button>
      </div>
    </div>
    <div class="tps-strip" data-role="strip"></div>
  </div>

  <div class="tps-statusbar">
    <span data-role="statusMain">就绪</span>
    <span class="tps-spacer"></span>
    <span data-role="statusConn">Tripo 助手未检测</span>
    <span class="tps-statussep"></span>
    <span data-role="statusCount">0 个资源</span>
  </div>

  <div class="tps-dialog hidden" data-role="dialog">
    <div class="tps-dialog-box" role="dialog" aria-modal="true" aria-label="拉回生成结果">
      <h3>拉回生成结果</h3>
      <p>粘贴生成结果地址（Tripo 助手输出目录、图床或本地中转），把结果重新接回当前项目。</p>
      <input class="tps-input" type="text" data-role="pullUrl" placeholder="http://127.0.0.1:8790/out/model_xxx.glb">
      <div class="tps-row">
        <label class="tps-field">类型
          <select class="tps-select" data-role="pullKind">
            <option value="auto">自动识别</option>
            <option value="image">图像</option>
            <option value="model">模型</option>
            <option value="texture">纹理</option>
          </select>
        </label>
        <label class="tps-check"><input type="checkbox" data-role="pullAsTexture"> 作为纹理应用到当前模型</label>
      </div>
      <div class="tps-dialog-actions">
        <button type="button" data-act="pullCancel">取消</button>
        <button type="button" class="tps-primary" data-act="pullDo">拉回</button>
      </div>
    </div>
  </div>

  <div class="tps-toast" data-role="toast"></div>

  <input type="file" hidden data-role="fileImage" accept="image/*" multiple>
  <input type="file" hidden data-role="fileModel" accept=".glb,.gltf,.obj,.fbx,.stl">
  <input type="file" hidden data-role="fileTexture" accept="image/*">
</div>`;
