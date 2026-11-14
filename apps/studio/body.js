/* 剪辑台的窗口 DOM。逻辑在 app.js，样式在 app.css。
 *
 * 结构沿用专业剪辑器的四区布局：
 *   顶栏（项目 / 撤销 / 分割 / 导出）
 *   左素材区（媒体 / 文字 / 音频 / 滤镜）
 *   中预览（画面 + 播放控制）
 *   右检查器（选中片段的画面 / 音频 / 动画参数）
 *   底时间线（标尺 + 四条轨道 + 播放头）
 * 只写 DOM，不写内联样式与内联事件 —— 样式全部走 .st-* 前缀的 app.css。
 */
window.STUDIO_BODY = `
<div class="st-app" id="stApp">
  <header class="st-top">
    <div class="st-brand">
      <span class="st-brand-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.4"/><path d="M8.2 4.6v14.8M15.8 4.6v14.8"/><path d="m5.2 9.4 3.2 4.2M5.2 15.4l3.2-4.2"/></svg>
      </span>
      <div class="st-brand-txt">
        <b>剪辑台</b>
        <span id="stProjName">未命名项目</span>
      </div>
    </div>

    <div class="st-top-tools">
      <button type="button" class="st-tbtn" id="stUndo" title="撤销（Ctrl+Z）" aria-label="撤销">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7 4.5 11.5 9 16"/><path d="M4.5 11.5h9.3a5.2 5.2 0 0 1 0 10.4H9.6"/></svg>
      </button>
      <button type="button" class="st-tbtn" id="stRedo" title="重做（Ctrl+Shift+Z）" aria-label="重做">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 7l4.5 4.5L15 16"/><path d="M19.5 11.5h-9.3a5.2 5.2 0 0 0 0 10.4H15"/></svg>
      </button>
      <i class="st-vsep" aria-hidden="true"></i>
      <button type="button" class="st-tbtn" id="stSplit" title="在播放头处分割（S）" aria-label="分割">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v6M12 15v6"/><circle cx="7" cy="18.2" r="2.3"/><circle cx="17" cy="18.2" r="2.3"/><path d="M8.7 16.3 15.4 5.8M15.3 16.3 8.6 5.8"/></svg>
      </button>
      <button type="button" class="st-tbtn" id="stDup" title="复制片段（Ctrl+D）" aria-label="复制片段">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2.2"/><path d="M15.6 5.4H6.6a2.2 2.2 0 0 0-2.2 2.2v9"/></svg>
      </button>
      <button type="button" class="st-tbtn" id="stDel" title="删除片段（Delete）" aria-label="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 6.8h14.4"/><path d="M9.6 6.8V4.6h4.8v2.2"/><path d="m6.6 6.8.9 12.4a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.9-12.4"/><path d="M10.4 10.4v6.6M13.6 10.4v6.6"/></svg>
      </button>
    </div>

    <div class="st-top-right">
      <span class="st-savestate" id="stSaveState">已保存</span>
      <button type="button" class="st-mini st-icomin" id="stProjExport" title="把整个项目导出为 .hfstudio 文件" aria-label="导出项目">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.8h7.2l4.4 4.4v12H6.2z"/><path d="M13.4 3.8v4.4h4.4"/><path d="M12 11v5.2"/><path d="m9.6 13.8 2.4 2.4 2.4-2.4"/></svg>
      </button>
      <button type="button" class="st-mini st-icomin" id="stProjImport" title="导入 .hfstudio / .json 项目文件" aria-label="导入项目">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.8h7.2l4.4 4.4v12H6.2z"/><path d="M13.4 3.8v4.4h4.4"/><path d="M12 16.4v-5.2"/><path d="m9.6 13.6 2.4-2.4 2.4 2.4"/></svg>
      </button>
      <button type="button" class="st-ghost st-icomin" id="stNew" title="新建项目" aria-label="新建项目">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 3.8h7.2l4.4 4.4v12H6.2z"/><path d="M13.4 3.8v4.4h4.4"/><path d="M12 10.8v5.4M9.3 13.5h5.4"/></svg>
      </button>
      <button type="button" class="st-primary" id="stExport">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.6 10.6 4.4 4.4 4.4-4.4"/><path d="M4.6 19.4h14.8"/></svg>
        导出
      </button>
    </div>
  </header>

  <nav class="st-menubar" id="stMenuBar" aria-label="菜单栏">
    <button type="button" class="st-menu-btn" data-menu="file">文件</button>
    <button type="button" class="st-menu-btn" data-menu="edit">编辑</button>
    <button type="button" class="st-menu-btn" data-menu="view">视图</button>
    <button type="button" class="st-menu-btn" data-menu="help">帮助</button>
    <span class="st-menubar-note">本地剪辑 · 素材不上传</span>
  </nav>

  <div class="st-main">
    <aside class="st-left">
      <div class="st-tabs" id="stTabs" role="tablist" aria-label="素材面板">
        <button type="button" class="st-tab on" data-panel="media" role="tab" aria-selected="true">媒体</button>
        <button type="button" class="st-tab" data-panel="text" role="tab" aria-selected="false">文字</button>
        <button type="button" class="st-tab" data-panel="audio" role="tab" aria-selected="false">音频</button>
        <button type="button" class="st-tab" data-panel="fx" role="tab" aria-selected="false">滤镜</button>
      </div>

      <div class="st-panels">
        <section class="st-panel" data-panel="media">
          <div class="st-libbar">
            <label class="st-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.4"/><path d="m15.6 15.6 4.2 4.2"/></svg>
              <input type="search" id="stMediaSearch" placeholder="搜索素材…" aria-label="搜索素材">
            </label>
            <button type="button" class="st-mini st-icomin" id="stLibOpen" title="从视频库添加" aria-label="从视频库添加">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5.2" width="7.4" height="13.6" rx="1.6"/><rect x="13.6" y="5.2" width="7.4" height="13.6" rx="1.6"/><path d="M6.7 8.8v2.2M17.3 8.8v2.2"/></svg>
            </button>
          </div>
          <button type="button" class="st-ghost st-wide" id="stImport">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v10"/><path d="m8 9 4-4 4 4"/><path d="M4.6 15.4v2.6a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-2.6"/></svg>
            导入文件
          </button>
          <div class="st-media" id="stMediaGrid"></div>
          <div class="st-empty" id="stMediaEmpty">
            <div class="st-empty-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.4"/><path d="M6.6 5.2v13.6M17.4 5.2v13.6"/><path d="M10.2 9.6 14.9 12l-4.7 2.4V9.6Z" fill="currentColor" stroke="none"/></svg>
            </div>
            <b>还没有素材</b>
            <span>导入本机视频 / 音频，或从「视频库」挑一条</span>
          </div>
        </section>

        <section class="st-panel hidden" data-panel="text">
          <div class="st-hint">点一个预设，文字会落在播放头位置。</div>
          <div class="st-presets" id="stTextPresets"></div>
        </section>

        <section class="st-panel hidden" data-panel="audio">
          <div class="st-hint">音频素材与「媒体」共用；导入的音频会直接进素材库。</div>
          <button type="button" class="st-ghost st-wide" id="stImportAudio">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.4 17.2V6.2l8-1.6v10.6"/><circle cx="7" cy="17.6" r="2.4"/><circle cx="15" cy="15.6" r="2.4"/></svg>
            导入音频
          </button>
          <div class="st-media" id="stAudioGrid"></div>
        </section>

        <section class="st-panel hidden" data-panel="fx">
          <div class="st-hint">先选中时间线上的视频 / 图片片段，再点滤镜。</div>
          <div class="st-fxgrid" id="stFxGrid"></div>
        </section>
      </div>
    </aside>

    <section class="st-center">
      <div class="st-prev">
        <div class="st-frame" id="stFrame">
          <div class="st-layer" data-track="v1"></div>
          <div class="st-layer" data-track="v2"></div>
          <div class="st-texts" id="stTexts"></div>
          <div class="st-safe" id="stSafe" aria-hidden="true"></div>
          <div class="st-prev-empty" id="stPrevEmpty">
            <div class="st-empty-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.4"/><path d="M6.6 5.2v13.6M17.4 5.2v13.6"/><path d="M10.2 9.6 14.9 12l-4.7 2.4V9.6Z" fill="currentColor" stroke="none"/></svg>
            </div>
            <b>时间线还是空的</b>
            <span>把左侧素材拖到下面轨道，或双击素材自动追加</span>
          </div>
        </div>
      </div>

      <div class="st-transport">
        <div class="st-tc" id="stTc">00:00:00.00</div>
        <div class="st-trans-mid">
          <button type="button" class="st-tbtn" id="stGoStart" title="回到开头（Home）" aria-label="回到开头">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M5.6 5h2.2v14H5.6zM19 5.6v12.8L9.4 12z"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stPrevFrame" title="上一帧（,）" aria-label="上一帧">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8.4 6.4h2v11.2h-2zM17.6 6.4v11.2L9.8 12z"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stBack1s" title="后退 1 秒（Shift+←）" aria-label="后退一秒">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M11 6 5.2 12 11 18zM18 6l-5.8 6 5.8 6z"/></svg>
          </button>
          <button type="button" class="st-play" id="stPlay" title="播放 / 暂停（空格）" aria-label="播放">
            <svg class="st-ico-play" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M8 5.4 19 12 8 18.6z"/></svg>
            <svg class="st-ico-pause hidden" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7.5 5h3.2v14H7.5zM13.3 5h3.2v14h-3.2z"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stFwd1s" title="前进 1 秒（Shift+→）" aria-label="前进一秒">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 6l5.8 6L13 18zM6 6l5.8 6L6 18z"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stNextFrame" title="下一帧（.）" aria-label="下一帧">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13.6 6.4h2v11.2h-2zM6.4 6.4v11.2L14.2 12z"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stGoEnd" title="跳到结尾（End）" aria-label="跳到结尾">
            <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M16.2 5H18.4v14h-2.2zM5 5.6v12.8L14.6 12z"/></svg>
          </button>
        </div>
        <div class="st-trans-right">
          <button type="button" class="st-tbtn" id="stLoop" title="循环播放" aria-label="循环播放">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 9.4A5.4 5.4 0 0 1 10 4h7.4"/><path d="m14.6 1.8 2.8 2.2-2.8 2.2"/><path d="M19.4 14.6A5.4 5.4 0 0 1 14 20H6.6"/><path d="m9.4 22.2-2.8-2.2 2.8-2.2"/></svg>
          </button>
          <button type="button" class="st-tbtn" id="stMute" title="静音预览" aria-label="静音预览">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3L11 6v12L7 14.5H4z"/><path class="st-ico-wave" d="M14.5 9.2a4 4 0 0 1 0 5.6M17.2 6.8a7.4 7.4 0 0 1 0 10.4"/><path class="st-ico-mute hidden" d="m15 10 4 4m0-4-4 4"/></svg>
          </button>
          <input type="range" class="st-vol" id="stVol" min="0" max="100" step="1" value="100" aria-label="预览音量">
        </div>
      </div>
    </section>

    <aside class="st-right">
      <div class="st-insp" id="stInspector"></div>
    </aside>
  </div>

  <div class="st-tl" id="stTimeline">
    <div class="st-tl-bar">
      <div class="st-tl-name">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.6 6.4h16.8M3.6 12h16.8M3.6 17.6h16.8"/><circle cx="9" cy="6.4" r="1.7" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="7.4" cy="17.6" r="1.7" fill="currentColor" stroke="none"/></svg>
        时间线
        <span class="st-dur" id="stDur">00:00</span>
      </div>
      <div class="st-tl-tools">
        <button type="button" class="st-tbtn sm on" id="stToolSelect" title="选择工具（V）" aria-label="选择工具">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6 3.4 18.2 12l-5.1.9 2.9 6.1-2.2 1-2.9-6.1L6 17.6z"/></svg>
        </button>
        <button type="button" class="st-tbtn sm" id="stToolBlade" title="剃刀工具（B）：点击片段在指针处分割" aria-label="剃刀工具">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.4v6.2M12 14.4v6.2"/><circle cx="7.4" cy="17.6" r="2.2"/><circle cx="16.6" cy="17.6" r="2.2"/><path d="m9 15.8 6.2-9.2M15 15.8 8.8 6.6"/></svg>
        </button>
        <span class="st-vsep" aria-hidden="true"></span>
        <button type="button" class="st-tbtn sm" id="stAddV" title="新增视频轨" aria-label="新增视频轨">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.8" y="5.2" width="12.2" height="13.6" rx="2.2"/><path d="M6.6 5.2v13.6M11.2 5.2v13.6"/><path d="M19 8.8v6.8M15.6 12.2h6.8"/></svg>
        </button>
        <button type="button" class="st-tbtn sm" id="stAddT" title="新增文字轨" aria-label="新增文字轨">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.6 5.4h9.6M9.4 5.4v13.2M7 18.6h4.8"/><path d="M19 8.8v6.8M15.6 12.2h6.8"/></svg>
        </button>
        <button type="button" class="st-tbtn sm" id="stAddA" title="新增音频轨" aria-label="新增音频轨">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 10.4v3.2M6.4 8v8M9.6 5.6v12.8M12.8 8.8v6.4"/><path d="M19 8.8v6.8M15.6 12.2h6.8"/></svg>
        </button>
        <span class="st-vsep" aria-hidden="true"></span>
        <button type="button" class="st-tbtn sm on" id="stSnap" title="磁吸对齐（吸附播放头、标记与相邻片段边缘）" aria-label="磁吸对齐">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 4.6v6.8a6.8 6.8 0 0 0 13.6 0V4.6"/><path d="M5.2 9.2h4.2M14.6 9.2h4.2"/></svg>
        </button>
        <span class="st-tlhint">滚轮平移 · Ctrl+滚轮缩放</span>
        <button type="button" class="st-tbtn sm" id="stZoomFit" title="适配时间线（F）" aria-label="适配时间线">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 8.4V4.8h3.6M19.8 8.4V4.8h-3.6M4.2 15.6v3.6h3.6M19.8 15.6v3.6h-3.6"/><path d="M8.6 12h6.8"/></svg>
        </button>
        <button type="button" class="st-tbtn sm" id="stZoomOut" title="缩小" aria-label="缩小">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.6" cy="10.6" r="5.8"/><path d="m14.8 14.8 4.4 4.4M8.4 10.6h4.4"/></svg>
        </button>
        <input type="range" class="st-zoom" id="stZoom" min="32" max="240" step="4" value="80" aria-label="时间线缩放">
        <button type="button" class="st-tbtn sm" id="stZoomIn" title="放大" aria-label="放大">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10.6" cy="10.6" r="5.8"/><path d="m14.8 14.8 4.4 4.4M8.4 10.6h4.4M10.6 8.4v4.4"/></svg>
        </button>
        <span class="st-zoomval" id="stZoomVal">80</span>
      </div>
    </div>
    <div class="st-tl-body">
      <div class="st-heads" id="stHeads"></div>
      <div class="st-scroll" id="stScroll">
        <div class="st-inner" id="stInner">
          <div class="st-ruler" id="stRuler"></div>
          <div class="st-rows" id="stRows"></div>
          <div class="st-drop hidden" id="stDrop"></div>
          <div class="st-playhead" id="stPlayhead"><b></b></div>
        </div>
      </div>
    </div>
  </div>

  <input type="file" id="stProjFile" accept=".hfstudio,.json,application/json" aria-label="导入项目文件" hidden>

  <div class="st-modal hidden" id="stLibModal">
    <div class="st-modal-card wide" role="dialog" aria-modal="true" aria-label="从视频库添加">
      <div class="st-modal-h">
        <b>从视频库添加</b>
        <button type="button" class="st-modal-x" data-close="stLibModal" aria-label="关闭">×</button>
      </div>
      <div class="st-modal-body">
        <div class="st-libsearch">
          <input type="search" id="stLibSearch" placeholder="搜索视频库…" aria-label="搜索视频库">
          <span class="st-mut" id="stLibCount"></span>
        </div>
        <div class="st-liblist" id="stLibList"></div>
      </div>
      <div class="st-modal-f">
        <button type="button" class="st-ghost" data-close="stLibModal">取消</button>
        <button type="button" class="st-primary" id="stLibAdd" disabled>加入素材库</button>
      </div>
    </div>
  </div>

  <div class="st-modal hidden" id="stExportModal">
    <div class="st-modal-card" role="dialog" aria-modal="true" aria-label="导出视频">
      <div class="st-modal-h">
        <b>导出视频</b>
        <button type="button" class="st-modal-x" data-close="stExportModal" aria-label="关闭">×</button>
      </div>
      <div class="st-modal-body">
        <label class="st-form-row"><span>文件名</span><input type="text" id="stExName" value="未命名项目"></label>
        <label class="st-form-row"><span>分辨率</span>
          <select id="stExRes">
            <option value="1920x1080">1080p · 1920 × 1080</option>
            <option value="1280x720">720p · 1280 × 720</option>
            <option value="854x480">480p · 854 × 480</option>
            <option value="1080x1920">竖屏 · 1080 × 1920</option>
          </select>
        </label>
        <label class="st-form-row"><span>帧率</span>
          <select id="stExFps">
            <option value="30">30 fps</option>
            <option value="25">25 fps</option>
            <option value="24">24 fps</option>
          </select>
        </label>
        <label class="st-form-row"><span>画质</span>
          <select id="stExBr">
            <option value="12">高 · 12 Mbps</option>
            <option value="8" selected>标准 · 8 Mbps</option>
            <option value="4">轻量 · 4 Mbps</option>
          </select>
        </label>
        <div class="st-exnote">导出为 WebM（浏览器实时渲染并编码，时长越长等待越久；导出期间不要切走页面）。</div>
        <div class="st-progress hidden" id="stExProg">
          <div class="st-progress-bar"><i id="stExBar"></i></div>
          <div class="st-progress-txt" id="stExTxt">准备中…</div>
        </div>
        <div class="st-exresult hidden" id="stExResult">
          <b id="stExResultT"></b>
          <span id="stExResultS"></span>
          <a id="stExLink" class="st-primary" download>下载到本机</a>
        </div>
      </div>
      <div class="st-modal-f">
        <button type="button" class="st-ghost" id="stExCancel" data-close="stExportModal">取消</button>
        <button type="button" class="st-primary" id="stExStart">开始导出</button>
      </div>
    </div>
  </div>

  <div class="st-modal hidden" id="stConfirmModal">
    <div class="st-modal-card sm" role="dialog" aria-modal="true" aria-label="确认">
      <div class="st-modal-h"><b id="stConfirmT">确认</b></div>
      <div class="st-modal-body"><div class="st-confirm-msg" id="stConfirmS"></div></div>
      <div class="st-modal-f">
        <button type="button" class="st-ghost" id="stConfirmNo">取消</button>
        <button type="button" class="st-primary" id="stConfirmYes">确定</button>
      </div>
    </div>
  </div>

  <div class="st-toast hidden" id="stToast" role="status" aria-live="polite"></div>
  <input type="file" id="stFile" class="hidden" multiple accept="video/*,audio/*,image/*">
  <input type="file" id="stFileAudio" class="hidden" multiple accept="audio/*">
</div>
`;
