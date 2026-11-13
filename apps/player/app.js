/* 视频库 —— 收「已经攒到本地」的影音，并就地播放。
 *
 * 文件不进浏览器存储（一集就几个 G），而是落在 userData/media，
 * 由主进程的 openagi-media:// 协议流式读——这样进度条能拖，内存也不涨。
 *
 * 和图库配对：图库里是「造出来的图」，视频库里是「攒下来的影音」。
 * 它只播本地已有的文件（媒体库目录），不负责去网上抓内容 —— 那个「直链下载」
 * 是给人下自己有权保存的东西的入口，不是搜索器。
 *
 * ⚠ 它被切走时会 stopPlayback()（见 js/player.js）：那是它自己的生命周期决策，
 *   迁移只搬 DOM，不碰行为。
 */
(function () {
  'use strict';

  registerApp({
    id: 'player',
    name: '视频库',
    title: '视频库',
    sub: '本地的视频与音频',
    glyph: 'video',
    order: 9,
    cls: 'player',
    win: 'playerWin',
    body: `
        <div class="pl-wrap">
          <div class="pl-stage" id="plStage">
            <div class="pl-screen" id="plScreen">
              <video id="plVideo" playsinline preload="metadata"></video>

              <div class="pl-empty" id="plEmpty">
                <div class="pl-empty-ico">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.4"/><path d="M6.6 5.2v13.6M17.4 5.2v13.6"/><path d="M10.2 9.6 14.9 12l-4.7 2.4V9.6Z" fill="currentColor" stroke="none"/><path d="M4.4 8.2h1.1M4.4 12h1.1M4.4 15.8h1.1M18.5 8.2h1.1M18.5 12h1.1M18.5 15.8h1.1"/></svg>
                </div>
                <div class="pl-empty-t">视频库还是空的</div>
                <div class="pl-empty-s">用右边「导入文件夹」加一整部，或「＋ 直链」下一集进来</div>
                <div class="pl-empty-acts">
                  <button class="pl-empty-btn primary" id="plEmptyImport">导入文件</button>
                  <button class="pl-empty-btn" id="plEmptyDir">导入文件夹</button>
                </div>
              </div>

              <div class="pl-osd" id="plOsd" aria-live="polite"></div>

              <div class="pl-help hidden" id="plHelp">
                <div class="pl-help-card" role="dialog" aria-label="快捷键">
                  <div class="pl-help-h">
                    <span>快捷键</span>
                    <button class="pl-help-x" id="plHelpX" type="button" aria-label="关闭">×</button>
                  </div>
                  <div class="pl-help-grid">
                    <kbd>空格</kbd><span>播放 / 暂停</span>
                    <kbd>← →</kbd><span>快退 / 快进 5 秒</span>
                    <kbd>J L</kbd><span>快退 / 快进 10 秒</span>
                    <kbd>↑ ↓</kbd><span>音量 +5% / −5%</span>
                    <kbd>M</kbd><span>静音切换</span>
                    <kbd>C</kbd><span>字幕开关</span>
                    <kbd>&lt; &gt;</kbd><span>减速 / 加速</span>
                    <kbd>PgUp PgDn</kbd><span>上一集 / 下一集</span>
                    <kbd>F2</kbd><span>重命名选中项</span>
                    <kbd>Delete</kbd><span>移到回收站</span>
                    <kbd>F</kbd><span>全屏</span>
                    <kbd>?</kbd><span>打开这张面板</span>
                  </div>
                  <div class="pl-help-foot">双击画面也能进全屏；F 或 Esc 退出。</div>
                </div>
              </div>
            </div>

            <div class="pl-head">
              <div class="pl-head-l">
                <div class="pl-head-t" id="plHeadTitle">未选择媒体</div>
                <div class="pl-head-s" id="plHeadSub">从右侧列表选一集开始播放</div>
              </div>
              <div class="pl-head-r">
                <span class="pl-badge" id="plHeadKind">视频</span>
                <span class="pl-badge" id="plHeadSize">—</span>
              </div>
            </div>

            <div class="pl-ctrl" id="plCtrl">
              <div class="pl-ctrl-seek">
                <div class="pl-seek-wrap" id="plSeekWrap">
                  <div class="pl-seek-rail">
                    <i class="pl-seek-buf" id="plSeekBuf"></i>
                    <i class="pl-seek-fill" id="plSeekFill"></i>
                  </div>
                  <input type="range" class="pl-seek" id="plSeek" min="0" max="1000" value="0" step="1" aria-label="播放进度">
                  <span class="pl-seek-tip" id="plSeekTip">0:00</span>
                </div>
                <span class="pl-time" id="plTime">0:00 / 0:00</span>
              </div>

              <div class="pl-ctrl-row">
                <div class="pl-ctrl-l">
                  <button class="pl-btn" id="plPrev" title="上一集（PgUp）" aria-label="上一集">
                    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7 5h2.2v14H7zM19 5.6v12.8L9.6 12z"/></svg>
                  </button>
                  <button class="pl-btn pl-btn-main" id="plPlay" title="播放 / 暂停（空格）" aria-label="播放">
                    <svg class="pl-ico-play" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M8 5.4 19 12 8 18.6z"/></svg>
                    <svg class="pl-ico-pause hidden" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7.5 5h3.2v14H7.5zM13.3 5h3.2v14h-3.2z"/></svg>
                  </button>
                  <button class="pl-btn" id="plNext" title="下一集（PgDn）" aria-label="下一集">
                    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M14.8 5H17v14h-2.2zM5 5.6 14.4 12 5 18.4z"/></svg>
                  </button>
                  <span class="pl-ctrl-sep" aria-hidden="true"></span>
                  <button class="pl-btn pl-btn-skip" id="plBack10" title="后退 10 秒（J）" aria-label="后退 10 秒">
                    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M11 6 5.2 12 11 18zM18 6l-5.8 6 5.8 6z"/></svg>
                  </button>
                  <button class="pl-btn pl-btn-skip" id="plFwd10" title="快进 10 秒（L）" aria-label="快进 10 秒">
                    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M13 6l5.8 6L13 18zM6 6l5.8 6L6 18z"/></svg>
                  </button>
                </div>

                <div class="pl-ctrl-r">
                  <button class="pl-btn pl-cc is-off" id="plCc" title="字幕（C）" aria-label="字幕" aria-pressed="false" disabled>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.6" y="5" width="18.8" height="14" rx="3.2"/><text x="12" y="15.4" text-anchor="middle" font-size="7" font-weight="700" fill="currentColor" stroke="none" font-family="Segoe UI,Arial,sans-serif">CC</text></svg>
                  </button>
                  <div class="pl-pop">
                    <button class="pl-btn pl-rate" id="plRate" title="播放速度（&lt; &gt;）" aria-haspopup="true" aria-expanded="false">1×</button>
                    <div class="pl-menu hidden" id="plRateMenu" role="menu" aria-label="播放速度">
                      <button type="button" class="pl-menu-i" data-rate="0.5" role="menuitem">0.5×</button>
                      <button type="button" class="pl-menu-i" data-rate="0.75" role="menuitem">0.75×</button>
                      <button type="button" class="pl-menu-i" data-rate="1" role="menuitem">1×</button>
                      <button type="button" class="pl-menu-i" data-rate="1.25" role="menuitem">1.25×</button>
                      <button type="button" class="pl-menu-i" data-rate="1.5" role="menuitem">1.5×</button>
                      <button type="button" class="pl-menu-i" data-rate="2" role="menuitem">2×</button>
                    </div>
                  </div>
                  <div class="pl-vol-wrap">
                    <button class="pl-btn" id="plMute" title="静音（M）" aria-label="静音">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3L11 6v12L7 14.5H4z"/><path class="pl-ico-wave" d="M14.5 9.2a4 4 0 0 1 0 5.6M17.2 6.8a7.4 7.4 0 0 1 0 10.4"/><path class="pl-ico-mute hidden" d="m15 10 4 4m0-4-4 4"/></svg>
                    </button>
                    <input type="range" class="pl-vol" id="plVol" min="0" max="100" value="100" step="1" aria-label="音量">
                  </div>
                  <button class="pl-btn" id="plPip" title="画中画" aria-label="画中画">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.8" y="4.8" width="18.4" height="14.4" rx="2.6"/><rect x="12.2" y="11.4" width="7" height="5.4" rx="1.4" fill="currentColor" stroke="none" opacity=".85"/></svg>
                  </button>
                  <button class="pl-btn" id="plFull" title="全屏（F）" aria-label="全屏">
                    <svg class="pl-ico-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
                    <svg class="pl-ico-exit hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <aside class="pl-side">
            <div class="pl-side-head">
              <div class="pl-side-title">
                <span class="pl-side-name">视频库</span>
                <span class="pl-count" id="plCount"></span>
              </div>
              <label class="pl-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.4"/><path d="m15.6 15.6 4.2 4.2"/></svg>
                <input type="search" id="plSearch" class="pl-search-in" placeholder="搜索文件名…" aria-label="搜索媒体">
                <button type="button" class="pl-search-x hidden" id="plSearchX" aria-label="清空搜索">×</button>
              </label>
              <div class="pl-folders" id="plFolders" role="tablist" aria-label="分组"></div>
            </div>
            <div class="pl-list-bar">
              <span class="pl-list-lab">播放列表</span>
              <button class="pl-sort" id="plSort" title="切换排序：名称 / 时间 / 大小">名称</button>
              <button class="pl-mini" id="plHelpBtn" title="快捷键（?）" aria-label="快捷键">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><path d="M9.7 9.4a2.4 2.4 0 1 1 3.1 2.3c-.7.3-.9.8-.9 1.5v.3"/><circle cx="12" cy="16.6" r=".9" fill="currentColor" stroke="none"/></svg>
              </button>
            </div>
            <div class="pl-list" id="plList" aria-label="播放列表"></div>
            <div class="pl-dl hidden" id="plDl">
              <input type="url" id="plDlUrl" class="pl-in" placeholder="粘贴视频直链（http/https，自己有权下载的）" aria-label="下载地址">
              <input type="text" id="plDlName" class="pl-in" placeholder="保存名（可留空，自动取链接末尾）" aria-label="保存名">
              <div class="pl-dl-row">
                <button class="btn sm primary" id="plDlGo">下载到本地</button>
                <button class="btn sm" id="plDlCancel">关闭</button>
                <span class="pl-dl-hint">只下你有权保存的内容</span>
              </div>
            </div>
            <div class="pl-prog hidden" id="plProg">
              <div class="pl-prog-bar"><i id="plProgBar"></i></div>
              <span class="pl-prog-txt" id="plProgTxt"></span>
              <button class="pl-prog-x" id="plProgX" title="取消下载">取消</button>
            </div>
            <div class="pl-foot">
              <button class="btn sm" id="plImport" title="从磁盘选文件（可多选）">导入文件</button>
              <button class="btn sm" id="plImportDir" title="选一个文件夹，按子文件夹分组成剧集">导入文件夹</button>
              <button class="btn sm" id="plDlOpen" title="粘贴直链下载">＋ 直链</button>
              <button class="btn sm" id="plDir" title="在资源管理器里打开媒体库目录">目录</button>
            </div>
          </aside>

          <!-- 文件操作菜单：右键或行尾「⋯」打开。只在桌面版显示改名 / 删除 / 定位 -->
          <div class="pl-ctx hidden" id="plCtx" role="menu" aria-label="文件操作">
            <button type="button" class="pl-ctx-i" data-act="play" role="menuitem">播放</button>
            <button type="button" class="pl-ctx-i" data-act="rename" role="menuitem">重命名<kbd>F2</kbd></button>
            <button type="button" class="pl-ctx-i" data-act="reveal" role="menuitem">在文件夹中显示</button>
            <button type="button" class="pl-ctx-i" data-act="copy" role="menuitem">复制文件名</button>
            <div class="pl-ctx-sep" role="separator"></div>
            <button type="button" class="pl-ctx-i danger" data-act="remove" role="menuitem">移到回收站<kbd>Del</kbd></button>
          </div>

          <!-- 删除确认：不用 window.confirm —— 它会把整个 App 卡住，也没法写清「进回收站」 -->
          <div class="pl-dialog hidden" id="plDialog">
            <div class="pl-dialog-card" role="dialog" aria-modal="true" aria-labelledby="plDialogT">
              <div class="pl-dialog-t" id="plDialogT"></div>
              <div class="pl-dialog-s" id="plDialogS"></div>
              <div class="pl-dialog-acts">
                <button type="button" class="pl-dialog-btn" id="plDialogCancel">取消</button>
                <button type="button" class="pl-dialog-btn danger" id="plDialogOk">移到回收站</button>
              </div>
            </div>
          </div>
        </div>
        <!-- 浏览器里打开（没有 Electron 媒体库）时的降级入口：只能临时播内存里的文件 -->
        <input type="file" id="plFile" class="hidden" multiple accept="video/*,audio/*">`,
    open: function () {
      if (typeof window.playerApp !== 'undefined' && typeof window.playerApp.open === 'function') window.playerApp.open();
    }
  });
})();
