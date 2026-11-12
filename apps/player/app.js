/* 播放器 —— 播「已经攒到本地」的东西。
 *
 * 文件不进浏览器存储（一集就几个 G），而是落在 userData/media，
 * 由主进程的 openagi-media:// 协议流式读——这样进度条能拖，内存也不涨。
 *
 * 和图库配对：图库里是「造出来的图」，播放器里是「攒下来的影音」。
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
    name: '播放器',
    title: '播放器',
    sub: '本地的视频与音频',
    glyph: 'video',
    order: 9,
    cls: 'player',
    win: 'playerWin',
    body: `
        <div class="pl-wrap">
          <div class="pl-stage">
            <div class="pl-screen" id="plScreen">
              <video id="plVideo" playsinline preload="metadata"></video>
              <div class="pl-empty" id="plEmpty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.6"/><path d="m10 9.4 5 2.6-5 2.6V9.4Z"/></svg>
                <div class="pl-empty-t">还没有可播的东西</div>
                <div class="pl-empty-s">用右边「导入文件夹」加一整部，或「＋ 直链」下一集进来</div>
              </div>
            </div>
            <div class="pl-ctrl" id="plCtrl">
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
              <span class="pl-time" id="plTime">0:00 / 0:00</span>
              <input type="range" class="pl-seek" id="plSeek" min="0" max="1000" value="0" step="1" aria-label="播放进度">
              <button class="pl-btn" id="plMute" title="静音（M）" aria-label="静音">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3L11 6v12L7 14.5H4z"/><path class="pl-ico-wave" d="M14.5 9.2a4 4 0 0 1 0 5.6M17.2 6.8a7.4 7.4 0 0 1 0 10.4"/><path class="pl-ico-mute hidden" d="m15 10 4 4m0-4-4 4"/></svg>
              </button>
              <input type="range" class="pl-vol" id="plVol" min="0" max="100" value="100" step="1" aria-label="音量">
              <button class="pl-btn pl-rate" id="plRate" title="播放速度">1×</button>
              <button class="pl-btn" id="plFull" title="全屏（F）" aria-label="全屏">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
              </button>
            </div>
          </div>
          <aside class="pl-side">
            <div class="pl-side-head">
              <div class="pl-folders" id="plFolders" role="tablist" aria-label="分组"></div>
              <span class="pl-count" id="plCount"></span>
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
        </div>
        <!-- 浏览器里打开（没有 Electron 媒体库）时的降级入口：只能临时播内存里的文件 -->
        <input type="file" id="plFile" class="hidden" multiple accept="video/*,audio/*">`,
    open: function () {
      if (typeof window.playerApp !== 'undefined' && typeof window.playerApp.open === 'function') window.playerApp.open();
    }
  });
})();
