/* 预加载脚本：只暴露「查看版本 / 订阅内容更新 / 本地引擎管理」几件事。
 * 渲染层不需要 Node 能力，继续保持 nodeIntegration:false。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openagiDesktop', {
  versions: () => ipcRenderer.invoke('app:versions'),
  /* 应用级全屏：所有入口（界面按钮 / 菜单 F11 / 主进程事件）共用同一份状态，
   * 渲染层只订阅结果。窗口级的 HTML 全屏（.os-win 铺满屏幕）不走这里。 */
  toggleWindowFullscreen: () => ipcRenderer.invoke('win:fullscreen-toggle'),
  windowIsFullscreen: () => ipcRenderer.invoke('win:fullscreen-get'),
  onWindowFullscreen: cb => {
    if(typeof cb !== 'function') return;
    ipcRenderer.on('win:fullscreen', (_e, on) => cb(!!on));
  },
  /* 工作流节点里的图像「右键 → 复制」：浏览器 Async Clipboard 对图片支持不稳定，
   * 桌面模式直接交给主进程写系统剪贴板。 */
  copyImage: dataUrl => ipcRenderer.invoke('clipboard:write-image', dataUrl),
  // 真实显卡列表 / 显存 / 内存：渲染进程的 WebGPU 只看得到核显，拿不到独显
  hardware: () => ipcRenderer.invoke('hw:probe'),
  ollamaDetect: () => ipcRenderer.invoke('ollama:detect'),
  ollamaInstall: () => ipcRenderer.invoke('ollama:install'),
  ollamaLaunch: () => ipcRenderer.invoke('ollama:launch'),
  // 刷新 / 重开窗口后取回进行中的安装进度，避免「按钮又变回安装引擎」的错觉
  ollamaStatus: () => ipcRenderer.invoke('ollama:status'),
  ollamaCancelInstall: () => ipcRenderer.invoke('ollama:cancel-install'),
  onOllamaProgress: cb => {
    if(typeof cb !== 'function') return;
    ipcRenderer.on('ollama:progress', (_e, info) => cb(info));
  },
  // 本地生图引擎（ComfyUI）：ComfyUI 是「自带 Python 的目录」，所以多一个选目录的口子
  comfyDetect: () => ipcRenderer.invoke('comfy:detect'),
  comfyLaunch: opts => ipcRenderer.invoke('comfy:launch', opts || {}),
  comfyStop: () => ipcRenderer.invoke('comfy:stop'),
  comfyPickDir: () => ipcRenderer.invoke('comfy:pick-dir'),
  comfyInstall: () => ipcRenderer.invoke('comfy:install'),
  comfyOpenUi: () => ipcRenderer.invoke('comfy:open-ui'),
  comfyCancel: () => ipcRenderer.invoke('comfy:cancel'),
  /* 改了 plugins/<id>/xxx.js 之后让本地服务换上新代码（端口不变）。
   * 桥自己在 /health 里报 stale，渲染层看到就点这一下，不用整只应用重启。 */
  serviceRestart: id => ipcRenderer.invoke('service:restart', id),
  /* 引擎自动启动（electron/engine-autostart.js）：
   * 开机时主进程自己会跑一遍；这里给界面三个口子——读配置、改开关、立刻再跑一次。 */
  enginesConfig: () => ipcRenderer.invoke('engines:config'),
  enginesSetConfig: patch => ipcRenderer.invoke('engines:set-config', patch || {}),
  enginesStatus: () => ipcRenderer.invoke('engines:status'),
  enginesAutoStart: () => ipcRenderer.invoke('engines:autostart'),
  // 预热当前语言模型（可选，默认关）：只加载权重，不产生 token
  enginesWarm: req => ipcRenderer.invoke('engines:warm', req || {}),
  /* 驻留保活（electron/engine-keepalive.js）：
   * 预热把模型的「冷加载」挪到了客户端启动那一刻；保活让模型一直留在显存里，
   * 于是提问永远走热请求——不再冷加载，也就不会再弹出那几次黑窗口。 */
  enginesKeepalive: () => ipcRenderer.invoke('engines:keepalive'),
  enginesKeepalivePing: req => ipcRenderer.invoke('engines:keepalive-ping', req || {}),
  onEngineStatus: cb => {
    if(typeof cb !== 'function') return;
    ipcRenderer.on('engines:status', (_e, info) => cb(info));
  },
  /* 资产库（图库 / 模型库）：图片和 3D 文件落在磁盘上，浏览器里只留 id 引用。
   * read 返回 dataURL，前端 <img src> / fetch 都能直接用。 */
  assetList: () => ipcRenderer.invoke('asset:list'),
  assetStat: () => ipcRenderer.invoke('asset:stat'),
  assetRead: id => ipcRenderer.invoke('asset:read', id),
  assetPut: req => ipcRenderer.invoke('asset:put', req || {}),
  assetRemove: ids => ipcRenderer.invoke('asset:remove', ids),
  assetReconcile: () => ipcRenderer.invoke('asset:reconcile'),
  assetEmptyTrash: () => ipcRenderer.invoke('asset:empty-trash'),
  assetImport: () => ipcRenderer.invoke('asset:import'),
  assetExport: ids => ipcRenderer.invoke('asset:export', ids),
  assetThumb: id => ipcRenderer.invoke('asset:thumb', id),
  assetThumbSave: (id, dataURL) => ipcRenderer.invoke('asset:thumb-save', { id, dataURL }),
  onComfyProgress: cb => {
    if(typeof cb !== 'function') return;
    ipcRenderer.on('comfy:progress', (_e, info) => cb(info));
  },
  /* 模型商店：生图权重是 2-7 GB 的大文件，只能由主进程落盘（浏览器里攒 blob 会直接吃满内存） */
  storeImageList: () => ipcRenderer.invoke('store:image-list'),
  storeInstallImage: req => ipcRenderer.invoke('store:image-install', req || {}),
  storeRemoveImage: file => ipcRenderer.invoke('store:image-remove', file),
  storeCancel: id => ipcRenderer.invoke('store:cancel', id),
  onStoreProgress: cb => {
    if(typeof cb !== 'function') return;
    ipcRenderer.on('store:progress', (_e, info) => cb(info));
  },
  onContentUpdated: cb => {
    if(typeof cb !== 'function') return;
    ipcRenderer.on('content:updated', (_e, info) => cb(info));
  },
  onContentProgress: cb => {
    if(typeof cb !== 'function') return;
    ipcRenderer.on('content:progress', (_e, info) => cb(info));
  },
  /* 媒体库（播放器 App）：视频/音频/字幕落 userData/media，界面只拿 id。
   * 播放地址由主进程的 openagi-media:// 协议提供，渲染层不接触真实路径。 */
  mediaList: () => ipcRenderer.invoke('media:list'),
  mediaStat: () => ipcRenderer.invoke('media:stat'),
  mediaImport: () => ipcRenderer.invoke('media:import'),
  mediaImportDir: () => ipcRenderer.invoke('media:import-dir'),
  mediaRemove: ids => ipcRenderer.invoke('media:remove', ids),
  mediaReveal: id => ipcRenderer.invoke('media:reveal', id),
  mediaOpenDir: () => ipcRenderer.invoke('media:open-dir'),
  mediaDownload: req => ipcRenderer.invoke('media:download', req || {}),
  mediaCancel: jobId => ipcRenderer.invoke('media:cancel', jobId),
  onMediaProgress: cb => {
    if(typeof cb !== 'function') return;
    ipcRenderer.on('media:progress', (_e, info) => cb(info));
  },
  /* 编码工作区：用户选的那个文件夹。所有 rel 都是相对路径，绝对路径不外泄到渲染层。
   * 写盘必须带 expectSha（读的时候拿到的哈希）—— 主进程会拿它做乐观锁，
   * 文件在编辑期间被外部改过就拒绝，不会静默覆盖别人的改动。 */
  codeInfo: () => ipcRenderer.invoke('code:info'),
  codePickDir: () => ipcRenderer.invoke('code:pick-dir'),
  codeClear: () => ipcRenderer.invoke('code:clear'),
  codeList: rel => ipcRenderer.invoke('code:list', rel || ''),
  codeTree: (rel, opts) => ipcRenderer.invoke('code:tree', rel || '', opts || {}),
  codeRead: rel => ipcRenderer.invoke('code:read', rel),
  codeWrite: req => ipcRenderer.invoke('code:write', req || {}),
  codeSearch: (q, opts) => ipcRenderer.invoke('code:search', q, opts || {}),
  codeReveal: rel => ipcRenderer.invoke('code:reveal', rel),
  /* 二进制写：base64 进、文件出。图片 / 字体 / 音频走这条，
   * 因为它们没法参与 text 的 diff，所以确认卡片的样子也不一样。 */
  codePutBin: req => ipcRenderer.invoke('code:put-bin', req || {}),
  codeExists: rel => ipcRenderer.invoke('code:exists', rel),
  codeOpenExternal: rel => ipcRenderer.invoke('code:open-external', rel),
  /* 预览地址是主进程的协议，渲染层只拼路径 —— 不要把 scheme 写死在两处，
   * 以后要换端口 / 换 scheme 只改这里一处。 */
  codePreviewUrl: rel => 'openagi-preview://ws/' + String(rel || '').replace(/^\/+/, '')
    .split('/').map(encodeURIComponent).join('/'),
  /* 命令执行：白名单 + cwd 锁工作区 + 超时杀进程树，全在主进程判定。
   * 输出走 code:run-output 流式事件 —— 跑 npm test 要几十秒，
   * 攒到结束才回传的话界面上看不出「在跑」还是「卡住了」。 */
  codeRun: req => ipcRenderer.invoke('code:run', req || {}),
  codeRunCancel: runId => ipcRenderer.invoke('code:run-cancel', runId),
  codeRunStatus: () => ipcRenderer.invoke('code:run-status'),
  onCodeRunOutput: cb => {
    if(typeof cb !== 'function') return () => {};
    const h = (_e, info) => cb(info);
    ipcRenderer.on('code:run-output', h);
    return () => ipcRenderer.removeListener('code:run-output', h);
  },
  /* 只在测试环境（OPENAGI_TEST=1）有对应 handler，正常运行时调用会 reject */
  codeSetRoot: dir => ipcRenderer.invoke('code:set-root', dir)
});
