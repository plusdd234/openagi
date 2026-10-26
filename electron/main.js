/* Electron 主进程
 *
 * 职责边界很窄：起窗口、托管两个本地服务、提供稳定的 app:// 源、跑内容热更新。
 * 业务逻辑一行都不在这里 —— 前端仍然是那套静态脚本。
 *
 * 三个关键决策（改之前先读）：
 *   1) 用自定义协议 app://openagi 而不是 file:// —— file:// 的 localStorage 归属随路径变化，
 *      每次热更新换目录就会「数据全丢」；app:// 的 origin 永远稳定。
 *   2) 两个服务用 utilityProcess 子进程跑，不 require —— relay.js / tripo-web.js 是 listen-on-require，
 *      而且服务崩了不该带走整个窗口。
 *   3) 内容包（index.html / css / js / vendor）单独热更新，程序本体更新留给 P2 的安装包链路。
 */
const { app, BrowserWindow, protocol, ipcMain, Menu, shell, utilityProcess } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const netmod = require('net');
const content = require('./content-updater');

const REPO_ROOT = path.join(__dirname, '..');
let bootLogFile = null;   // 打包后没有 stdout，统一写 userData/boot.log
function logLine(){
  const text = '[' + new Date().toISOString().slice(11, 19) + '] ' +
    Array.prototype.map.call(arguments, x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  try { if(bootLogFile) fs.appendFileSync(bootLogFile, text + '\n'); } catch(e){}
  try { console.log(text); } catch(e){}
}
const CONTENT_ORIGIN = 'app://openagi';

// 自定义协议必须在 ready 之前登记
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
}]);

let mainWin = null;
let relayProc = null;
let bridgeProc = null;
let chatProc = null;
let contentRoot = REPO_ROOT;       // 协议处理器读这个变量（热更新后就地改）
let contentVersion = 'bundled';
let relayPort = 8787;
let tripoPort = 8790;
let chatPort = 8792;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm'
};

/* ---------- 路径 ---------- */
function bridgeDir(){
  return app.isPackaged ? path.join(process.resourcesPath, 'bridge') : REPO_ROOT;
}
function bundledContentRoot(){
  // 打包后前端在 asar 里（files 白名单控制了范围），开发时就是仓库根目录
  return app.isPackaged ? app.getAppPath() : REPO_ROOT;
}
function contentBaseDir(){
  return path.join(app.getPath('userData'), 'content');
}
function readUpdateConfig(){
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'update.json'), 'utf8'));
  } catch(e){
    return {};
  }
}

/* ---------- 端口 ---------- */
function isFree(port){
  return new Promise(resolve => {
    const srv = netmod.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function pickPort(start, span){
  for(let p = start; p < start + (span || 20); p++){
    if(await isFree(p)) return p;
  }
  throw new Error('找不到可用端口（' + start + ' 起 ' + (span || 20) + ' 个都被占用）');
}

/* ---------- 服务 ---------- */
function startService(name, script, env, cwd){
  const proc = utilityProcess.fork(script, [], {
    env: Object.assign({}, process.env, env),
    cwd,
    serviceName: name,
    stdio: 'pipe'
  });
  if(proc.stdout) proc.stdout.on('data', d => process.stdout.write('[' + name + '] ' + String(d)));
  if(proc.stderr) proc.stderr.on('data', d => process.stderr.write('[' + name + '] ' + String(d)));
  proc.on('exit', code => console.log('[' + name + '] 已退出，code=' + code));
  return proc;
}

function startServices(){
  const dir = bridgeDir();
  const userData = app.getPath('userData');
  relayProc = startService('relay', path.join(dir, 'relay.js'), {
    HOST: '127.0.0.1',
    PORT: String(relayPort),
    RELAY_STORE_FILE: path.join(userData, 'openagi-store.json')
  }, dir);

  // 交流社区（server/chat.js）：数据落 userData，和网关共用一个 data 目录
  const chatScript = app.isPackaged
    ? path.join(process.resourcesPath, 'bridge', 'chat.js')
    : path.join(REPO_ROOT, 'server', 'chat.js');
  chatProc = startService('chat', chatScript, {
    CHAT_PORT: String(chatPort),
    GATEWAY_DATA: userData,
    CHAT_ADMIN_KEY: (readUpdateConfig().chatAdminKey || '')
  }, dir);

  bridgeProc = startService('tripo', path.join(dir, 'tripo-web.js'), {
    PORT: String(tripoPort),
    TRIPO_PROFILE_DIR: path.join(userData, 'tripo-profile'),
    TRIPO_OUT_DIR: path.join(userData, 'tripo_out'),
    TRIPO_TMP_DIR: path.join(userData, 'tripo_tmp')
  }, dir);
}

function stopServices(){
  [relayProc, bridgeProc, chatProc].forEach(p => {
    try { if(p) p.kill(); } catch(e){}
  });
  relayProc = null;
  bridgeProc = null;
  chatProc = null;
}

/* ---------- app:// 协议 ---------- */
function serveContent(req){
  let rel = '/index.html';
  try {
    const u = new URL(req.url);
    rel = decodeURIComponent(u.pathname || '/');
  } catch(e){}
  if(rel === '/' || rel === '') rel = '/index.html';

  const rootAbs = path.normalize(contentRoot);
  const abs = path.normalize(path.join(rootAbs, rel));
  if(abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)){
    return new Response('forbidden', { status: 403 });
  }
  return fsp.readFile(abs).then(buf => new Response(buf, {
    headers: {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    }
  })).catch(() => new Response('not found: ' + rel, { status: 404 }));
}

/* ---------- 窗口 ---------- */
async function createWindow(){
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0a0b0e',
    show: false,
    title: 'Open AGI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  const qs = new URLSearchParams({
    relay: 'http://127.0.0.1:' + relayPort,
    tripo: 'http://127.0.0.1:' + tripoPort,
    chat: 'http://127.0.0.1:' + chatPort
  }).toString();

  win.once('ready-to-show', () => {
    win.show();
    // 冒烟模式：只验证「能起来、能加载、服务在跑」然后自动退出（CI / 无头验证用）
    if(process.env.OPENAGI_SMOKE){
      setTimeout(async () => {
        try {
          const alive = await isFree(relayPort) === false;
          logLine('[smoke] window=ok relay=' + (alive ? 'up' : 'down') + ' content=' + contentVersion);
        } catch(e){}
        app.quit();
      }, 1200);
    }
  });
  await win.loadURL(CONTENT_ORIGIN + '/index.html?' + qs);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logLine('[window] 加载失败 ' + code + ' ' + desc + ' ' + url);
  });
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if(level >= 2) logLine('[renderer] ' + message + ' @' + (source || '') + ':' + line);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if(/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if(url.indexOf(CONTENT_ORIGIN + '/') !== 0) e.preventDefault();
  });
  win.on('closed', () => { mainWin = null; });
  return win;
}

function buildMenu(){
  const isDev = !app.isPackaged;
  const template = [
    {
      label: '文件',
      submenu: [
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具', visible: isDev },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(app.getPath('userData'))
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- 内容热更新 ---------- */
async function maybeUpdateContent(){
  const cfg = readUpdateConfig();
  const manifestUrl = process.env.OPENAGI_CONTENT_URL || cfg.manifestUrl;
  if(!manifestUrl) return;                       // 没配内容源就静默跳过（开发期常态）
  const r = await content.check({
    baseDir: contentBaseDir(),
    bundledRoot: bundledContentRoot(),
    manifestUrl,
    publicKey: process.env.OPENAGI_CONTENT_PUBKEY || cfg.publicKey,
    appVersion: app.getVersion(),
    onProgress: info => {
      if(mainWin) mainWin.webContents.send('content:progress', info);
    }
  });
  if(!r.ok){
    console.log('[content] 跳过：' + r.reason);
    return;
  }
  if(!r.updated){
    console.log('[content] 已是最新（' + r.version + '）');
    return;
  }
  console.log('[content] 已更新到 ' + r.version + '（上一版 ' + r.previous + '）');
  if(mainWin) mainWin.webContents.send('content:updated', { version: r.version });
  // 自动重载：前端有 350ms 的落盘防抖，留 1.5s 让编辑中的流程存下来
  if(process.env.OPENAGI_CONTENT_AUTORELOAD !== '0' && mainWin){
    setTimeout(() => {
      contentRoot = r.root;
      contentVersion = r.version;
      try { mainWin.reload(); } catch(e){}
    }, 1500);
  } else {
    contentRoot = r.root;   // 下次启动生效
    contentVersion = r.version;
  }
}

/* ---------- 启动 ---------- */
const gotLock = app.requestSingleInstanceLock();
if(!gotLock){
  app.quit();
} else {
  app.on('second-instance', () => {
    if(mainWin){
      if(mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  process.on('unhandledRejection', e => logLine('[fatal] 未处理的 Promise 拒绝：', String((e && e.stack) || e)));
  process.on('uncaughtException', e => logLine('[fatal] 未捕获异常：', String((e && e.stack) || e)));

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.openagi.desktop');
    try {
      bootLogFile = path.join(app.getPath('userData'), 'boot.log');
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(bootLogFile, '');
      logLine('启动 v' + app.getVersion() + ' packaged=' + app.isPackaged + ' electron=' + process.versions.electron);
    } catch(e){}

    try {
    // 1) 先选内容根（current → previous → 内置）
    try {
      const chosen = await content.resolveRoot({
        baseDir: contentBaseDir(),
        bundledRoot: bundledContentRoot()
      });
      contentRoot = chosen.root;
      contentVersion = chosen.version;
      logLine('[content] 版本 ' + chosen.version + ' → ' + chosen.root);
      if(chosen.degraded) console.warn('[content] 当前版本目录校验失败，已回退到 ' + chosen.version);
      else console.log('[content] 使用内容版本 ' + chosen.version);
    } catch(e){
      console.warn('[content] 内容根解析失败，使用内置版本：' + ((e && e.message) || e));
      contentRoot = bundledContentRoot();
    }

    protocol.handle('app', req => {
      const res = serveContent(req);
      res.then(r => { if(r.status >= 400) logLine('[app] ' + r.status + ' ' + req.url); }).catch(e => logLine('[app] 读取失败 ' + req.url + ' ' + e.message));
      return res;
    });

    // 2) 端口（被占用就顺延，然后通过 ?relay= / ?tripo= 告诉前端）
    try {
      relayPort = await pickPort(8787);
      tripoPort = await pickPort(8790);
      chatPort = await pickPort(8792);
      if(relayPort !== 8787) console.warn('[port] 8787 被占用，改用 ' + relayPort);
      if(tripoPort !== 8790) console.warn('[port] 8790 被占用，改用 ' + tripoPort);
    } catch(e){
      console.error('[port] ' + ((e && e.message) || e));
    }

    // 3) 服务 + 菜单 + 窗口
    logLine('[port] relay=' + relayPort + ' tripo=' + tripoPort + ' chat=' + chatPort);
    startServices();
    buildMenu();
    mainWin = await createWindow();
    logLine('[window] 已创建并加载 ' + CONTENT_ORIGIN);

    // 4) 后台检查内容更新（不阻塞首屏）
    setTimeout(() => { maybeUpdateContent().catch(e => logLine('[content] ' + e.message)); }, 5000);
    } catch(e){
      logLine('[fatal] 启动失败：' + ((e && e.stack) || e));
      throw e;
    }
  });

  app.on('window-all-closed', () => {
    stopServices();
    if(process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', stopServices);
  app.on('activate', async () => {
    if(BrowserWindow.getAllWindows().length === 0) mainWin = await createWindow();
  });

  ipcMain.handle('app:versions', () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    content: contentVersion,
    relay: relayPort,
    tripo: tripoPort
  }));
}
