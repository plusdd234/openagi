/* 本地生图引擎（ComfyUI）独立 app
 *
 * 为什么单拎成一个 app：
 *   ComfyUI 不是一个 exe，而是「一整个带 Python 的目录」。它有自己的安装、启动、
 *   端口、网页界面、模型目录——把这套东西塞在「模型控制台」里的一个小方块里，
 *   用户既不知道点哪里，也不知道它到底在干什么。独立窗口才能把「现在是什么状态、
 *   下一步该点哪个按钮」一次说清。
 *
 * 三个必须守住的设计：
 *   ① **不再弹「需要先装 7-Zip」的确认框**。解压走系统自带的 tar（libarchive 能读 7z），
 *      点一下就开始下，装完自动启动——这才是「一键」。
 *   ② 状态必须区分「未安装 / 已安装未启动 / 运行中」三种，对应三组完全不同的按钮。
 *      只显示「启动失败」而不说缺什么，用户只能干瞪眼。
 *   ③ 启动是长任务（加载 torch 实测要 106 秒），必须有进度说明，不能让按钮看起来没反应。
 */
const CF_MODE = { portable: '便携版', venv: '虚拟环境', system: '系统 Python' };

const cfState = {
  checked: false,
  running: false,
  installed: false,
  dir: '', mode: '',
  hasTar: '', has7z: '', canInstall: false,
  busy: '', progress: '', pct: -1,
  error: '', log: '', stats: null
};

/* ComfyUI 自己就是一个网页界面。内嵌之后，「启动引擎 → 打开网页」这条外部流程
 * 就收进了这个窗口：顶部状态条管生命周期，中间舞台直接显示工作流画布。
 *
 * 容器选择与浏览器 App 一致：
 *   · Electron（主进程开了 webviewTag）→ <webview>，不受 X-Frame-Options 限制；
 *   · 普通浏览器 / 探针 → <iframe>（ComfyUI 是本地 aiohttp，没有 XFO，实测可嵌）。
 *
 * ⚠ webview 必须有初始 src=about:blank，否则不会创建 guest、也不会派发 dom-ready，
 *   之后 loadURL 必抛错（浏览器 App 里踩过，一次白屏）。
 * ⚠ 不要用 display:none 收 webview：guest 会被压成 0 尺寸。收起统一用 .is-off（visibility）。
 */
const CF_UI = 'http://127.0.0.1:8188/';

const cfUi = {
  frame: null,
  web: false,        /* true = Electron webview */
  ready: false,      /* webview 要等 dom-ready 才允许 loadURL */
  loaded: false,     /* 界面已经加载过（避免每次重绘都重新导航） */
  pending: '',
  manage: false,     /* 用户手动切到管理面板 */
  fail: '',          /* 界面加载失败原因 */
  wasRunning: false,
  retry: 0,
  retries: 0,
  poll: 0
};

/* 外壳只画一次。之后 cfPaint() 只重写 .cf-panel 的内容 ——
 * 以前它整块重写 #cfApp，内嵌网页会被一起销毁再重建（工作流状态全丢）。 */
function cfShellHtml(){
  return '<div class="cf-bar">' +
      '<span class="cf-dot off"></span>' +
      '<span class="cf-bar-title">ComfyUI</span>' +
      '<span class="cf-bar-state">检测中…</span>' +
      '<span class="cf-bar-url">127.0.0.1:8188</span>' +
      '<button type="button" class="cf-tb" data-cf-act="reload" hidden>刷新界面</button>' +
      '<button type="button" class="cf-tb" data-cf-act="manage" hidden>管理</button>' +
      '<button type="button" class="cf-tb" data-cf-act="openui" hidden>浏览器打开</button>' +
      '<button type="button" class="cf-tb" data-cf-act="launch" hidden>启动</button>' +
      '<button type="button" class="cf-tb" data-cf-act="stop" hidden>停止</button>' +
    '</div>' +
    '<div class="cf-stage">' +
      '<div class="cf-panel"></div>' +
    '</div>';
}

function cfEnsureShell(){
  const box = $('cfApp');
  if(!box) return false;
  if(typeof box.querySelector === 'function' && box.querySelector('.cf-bar')) return true;
  box.innerHTML = cfShellHtml();
  cfBuildFrame();
  cfWireBar();
  return true;
}

/* 面板节点：真实 DOM 里是 .cf-panel；老测试沙箱没有子结构，退回整块 #cfApp。 */
function cfPanel(){
  const box = $('cfApp');
  if(!box) return null;
  const p = (typeof box.querySelector === 'function') ? box.querySelector('.cf-panel') : null;
  return p || box;
}

function cfBuildFrame(){
  if(cfUi.frame) return;
  const box = $('cfApp');
  const stage = (box && typeof box.querySelector === 'function') ? box.querySelector('.cf-stage') : null;
  if(!stage || typeof document === 'undefined' || typeof document.createElement !== 'function') return;

  let el = null;
  let web = false;
  try{
    const wv = document.createElement('webview');
    if(wv && typeof wv.loadURL === 'function'){ el = wv; web = true; }
  }catch(e){ /* 普通浏览器里没有 webview */ }
  if(!el){
    el = document.createElement('iframe');
    el.setAttribute('referrerpolicy', 'no-referrer');
  }

  el.className = 'cf-frame' + (web ? ' cf-webview' : '') + ' is-off';
  el.setAttribute('title', 'ComfyUI 界面');
  if(web){
    el.setAttribute('webpreferences', 'nodeIntegration=no, contextIsolation=yes');
    el.setAttribute('src', 'about:blank');
  }

  stage.appendChild(el);
  cfUi.frame = el;
  cfUi.web = web;
  cfUi.ready = !web;
  cfWireFrame();
}

function cfWireFrame(){
  const f = cfUi.frame;
  if(!f) return;

  if(cfUi.web){
    f.addEventListener('dom-ready', () => {
      cfUi.ready = true;
      const url = cfUi.pending;
      cfUi.pending = '';
      if(url || cfState.running) cfLoadFrame(true);
      cfSyncChrome();
    });
    f.addEventListener('did-start-loading', () => cfSyncChrome());
    /* 只有「真正加载成功」才清错误：did-stop-loading 在失败之后也会来，
       在那里清会把失败原因一闪而过地抹掉。 */
    f.addEventListener('did-finish-load', () => {
      cfUi.fail = '';
      cfSyncChrome();
    });
    f.addEventListener('did-stop-loading', () => cfSyncChrome());
    f.addEventListener('did-fail-load', e => {
      if(e && e.errorCode === -3) return;   /* -3 = 主动中止 / 切换地址 */
      cfFrameFailed('界面加载失败：' + ((e && e.errorDescription) || (e && e.errorCode) || '未知原因'));
    });
    return;
  }

  /* iframe 加载失败没有可靠事件（被拦时也只派发 load），
     只在引擎明明在跑、页面却迟迟没 load 的情况下给一句提示。 */
  f.addEventListener('load', () => {
    cfUi.fail = '';
    cfSyncChrome();
  });
}

function cfLoadFrame(force){
  cfBuildFrame();
  if(!cfUi.frame) return;
  if(!cfUi.ready){ cfUi.pending = CF_UI; return; }
  if(!force && cfUi.loaded) return;
  cfUi.fail = '';
  cfUi.loaded = true;
  try{
    if(cfUi.web) cfUi.frame.loadURL(CF_UI);
    else cfUi.frame.src = CF_UI;
  }catch(e){
    cfFrameFailed('界面加载失败：' + ((e && e.message) || e));
  }
}

/* 刷新必须绕开「src 赋同值不重载」：iframe 加一个一次性参数，webview 直接 reload。 */
function cfReloadFrame(){
  cfBuildFrame();
  if(!cfUi.frame) return;
  cfUi.retries = 0;                  /* 手动刷新重新给两次自动补连机会 */
  if(!cfUi.ready){ cfUi.pending = CF_UI; return; }
  if(cfUi.web){
    try{ cfUi.frame.reload(); cfUi.fail = ''; cfSyncChrome(); return; }
    catch(e){ /* 还没加载过就退回 loadURL */ }
  }
  cfUi.loaded = false;
  cfUi.fail = '';
  const url = CF_UI + (CF_UI.indexOf('?') < 0 ? '?' : '&') + '_r=' + Date.now();
  try{ cfUi.frame.src = url; }catch(e){ cfUi.fail = String((e && e.message) || e); }
  cfSyncChrome();
}

/* 引擎停了就把界面卸掉：留着旧的错误页只会在下次启动时先闪一下白屏。 */
function cfUnloadFrame(){
  cfUi.loaded = false;
  if(!cfUi.frame) return;
  try{
    if(cfUi.web) cfUi.frame.loadURL('about:blank');
    else cfUi.frame.src = 'about:blank';
  }catch(e){ /* dom-ready 还没来，下一次加载会覆盖 */ }
}

function cfFrameFailed(msg){
  cfUi.fail = msg;
  cfUi.loaded = false;
  cfUi.manage = true;
  cfPaint();
  /* 引擎刚起来时 8188 会短暂拒绝连接：等两秒自动再接一次，不逼用户点按钮。
     但只补两次：一直失败就停在错误提示上，不能变成每 2 秒重载一次的死循环。 */
  if(cfUi.retries >= 2) return;
  cfUi.retries++;
  clearTimeout(cfUi.retry);
  cfUi.retry = setTimeout(() => {
    cfDetect(true).then(() => {
      if(!cfState.running) return;
      cfUi.manage = false;
      cfUi.fail = '';
      cfLoadFrame(true);
      cfPaint();
    }).catch(() => {});
  }, 2200);
}

function cfWireBar(){
  const box = $('cfApp');
  const bar = (box && typeof box.querySelector === 'function') ? box.querySelector('.cf-bar') : null;
  if(!bar || bar.dataset.wired === '1') return;
  bar.dataset.wired = '1';
  bar.addEventListener('click', e => {
    const btn = (e.target && typeof e.target.closest === 'function') ? e.target.closest('[data-cf-act]') : null;
    if(!btn || btn.disabled) return;
    cfDoAct(btn.getAttribute('data-cf-act'));
  });
}

/* 状态条的按钮与状态词：三态（运行中 / 启动中 / 未启动）对应三组按钮。 */
function cfSyncChrome(){
  const box = $('cfApp');
  const bar = (box && typeof box.querySelector === 'function') ? box.querySelector('.cf-bar') : null;
  if(!bar) return;

  const running = cfState.running;
  const starting = cfState.busy === '启动中';
  const desk = !!cfDesk();

  let word = '未启动';
  let tone = 'off';
  if(!desk){ word = '网页版'; }
  else if(running){ word = '运行中'; tone = 'ok'; }
  else if(starting){ word = '启动中'; tone = 'wait'; }
  else if(cfState.installed){ word = '已停止'; }

  const dot = bar.querySelector('.cf-dot');
  if(dot) dot.className = 'cf-dot ' + tone;
  const state = bar.querySelector('.cf-bar-state');
  if(state){
    state.textContent = word;
    state.className = 'cf-bar-state' + (tone === 'ok' ? ' ok' : tone === 'wait' ? ' wait' : '');
  }

  const show = (act, on) => {
    const b = bar.querySelector('[data-cf-act="' + act + '"]');
    if(b) b.hidden = !on;
  };
  const able = (act, on) => {
    const b = bar.querySelector('[data-cf-act="' + act + '"]');
    if(b) b.disabled = !on;
  };

  show('reload', running);
  show('manage', running);
  show('openui', running);
  show('launch', desk && cfState.installed && !running && !starting);
  show('stop', running);
  able('launch', !cfState.busy && cfState.installed);
  able('stop', !cfState.busy);
  able('openui', running);
  able('reload', running);

  const manageBtn = bar.querySelector('[data-cf-act="manage"]');
  if(manageBtn) manageBtn.textContent = cfUi.manage ? '返回界面' : '管理';

  /* 面板与网页互斥：管理态、未运行、加载失败时显示面板。 */
  const showPanel = !running || cfUi.manage || !!cfUi.fail;
  const panel = (typeof box.querySelector === 'function') ? box.querySelector('.cf-panel') : null;
  if(panel) panel.classList.toggle('is-off', !showPanel);
  if(cfUi.frame) cfUi.frame.classList.toggle('is-off', showPanel);

  if(!cfUi.wasRunning && running) cfUi.retries = 0;   /* 新的引擎会话，重新计次 */
  if(running && !showPanel) cfLoadFrame();
  if(cfUi.wasRunning && !running) cfUnloadFrame();
  cfUi.wasRunning = running;
}

function cfEsc(s){
  if(typeof mcEsc === 'function') return mcEsc(s);
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function cfDesk(){
  const d = window.openagiDesktop;
  return (d && typeof d.comfyDetect === 'function') ? d : null;
}
function cfSleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function cfDetect(quiet){
  const d = cfDesk();
  if(!d){
    cfState.checked = true;
    return null;
  }
  if(!quiet){ cfState.error = ''; }
  try{
    const st = await d.comfyDetect();
    cfState.checked = true;
    cfState.running = !!(st && st.running);
    cfState.installed = !!(st && st.installed);
    cfState.dir = (st && st.dir) || '';
    cfState.mode = (st && st.layout && st.layout.mode) || '';
    cfState.hasTar = (st && st.tar) || '';
    cfState.has7z = (st && st.sevenZip) || '';
    cfState.canInstall = !!(st && st.canInstall);
    cfState.stats = (st && st.systemStats) || null;
    // 运行中就没必要再看启动日志，别把有用的界面挤下去
    cfState.log = (st && !st.running) ? (st.log || '') : '';
    return st;
  }catch(e){
    cfState.checked = true;
    cfState.error = '检测失败：' + ((e && e.message) || e);
    return null;
  }
}

let cfProgBound = false;
function cfBindProgress(){
  if(cfProgBound) return;
  const d = cfDesk();
  if(!d || typeof d.onComfyProgress !== 'function') return;
  cfProgBound = true;
  d.onComfyProgress(info => {
    if(!info) return;
    if(typeof info.pct === 'number' && info.pct >= 0) cfState.pct = info.pct;
    if(info.message) cfState.progress = info.message;
    if(info.stage === 'done' || info.stage === 'error') cfState.busy = '';
    cfPaint();
  });
}

/* ---------- 动作 ---------- */
async function cfInstall(){
  const d = cfDesk();
  if(!d) return;
  if(cfState.busy) return;
  cfState.busy = '安装中';
  cfState.progress = '准备下载 ComfyUI 便携包（约 2 GB）…';
  cfState.pct = 0;
  cfState.error = '';
  cfPaint();
  try{
    const r = await d.comfyInstall();
    if(!r || !r.ok){
      // 取消不是失败，别泼一脸红字
      if(r && r.cancelled) cfState.progress = '已取消安装';
      else cfState.error = (r && r.message) || '安装失败';
      return;
    }
    cfState.progress = '安装完成，正在启动引擎…';
    cfPaint();
    await cfDetect(true);
    /* 装完直接启动：用户点「安装」想要的是「能用」，不是「装好了自己去点启动」。
     * 必须先清掉 busy——cfLaunch 自己有 `if(cfState.busy) return` 的守卫，
     * 留着「安装中」会让自动启动被自己的标志挡住（表现为装完了却停在未启动）。 */
    if(cfState.installed && !cfState.running){
      cfState.busy = '';
      await cfLaunch(true);
    }
  }catch(e){
    cfState.error = '安装失败：' + ((e && e.message) || e);
  }finally{
    cfState.busy = '';
    await cfDetect(true);
    cfPaint();
  }
}

/* 等引擎起来：每 2 秒探一次，最多 2 分钟（实测首次启动 106 秒）。
 * 启动是长任务，不能让用户盯着一个静止的按钮猜「是不是卡了」。 */
/* 引擎状态一变，就把全局的 rtHealth 也拉一次。
 * 对话页头、出图前的就绪检查读的都是它；不同步的话会出现
 * 「这个窗口写着运行中，对话里却说没在运行」——两边都对，只是看的是两个快照。 */
function cfSyncHealth(){
  if(typeof rtRefresh !== 'function') return;
  try{ rtRefresh().catch(() => {}); }catch(e){}
}

async function cfWatch(){
  for(let i = 0; i < 60; i++){
    await cfSleep(2000);
    const st = await cfDetect(true);
    if(st && st.running){
      cfState.error = '';
      cfState.log = '';
      cfPaint();
      cfSyncHealth();
      if(typeof refreshDeskStates === 'function') refreshDeskStates();
      if(typeof bpToast === 'function') bpToast('ComfyUI 已就绪');
      return true;
    }
  }
  return false;
}

/* 启动引擎。三种结局，界面必须分得清：
 *   ① 起来了 → 刷成「运行中」
 *   ② 主进程那边已经有一次启动在跑（开机自动启动的就是它）→ 不报错，转成「等它」
 *   ③ 真失败 → 红字 + 日志尾巴
 * ② 以前会被当成失败：主进程抛「正在启动中，请稍候」，界面把它当红字显示，
 * 而那次启动明明成功了 —— 这就是「卡在启动中」的由来。 */
async function cfLaunch(silent){
  const d = cfDesk();
  if(!d || cfState.busy) return;
  cfState.busy = '启动中';
  cfState.progress = '正在加载模型框架，首次启动要一两分钟（要读 torch 和一堆节点）…';
  cfState.error = '';
  cfPaint();
  let r = null;
  try{
    r = await d.comfyLaunch();
  }catch(e){
    r = { ok: false, message: String((e && e.message) || e) };
  }
  const msg = String((r && r.message) || '');
  if(!(r && r.ok) && /正在启动/.test(msg)){
    // 别人已经在起了：留在「启动中」，自己盯着它，好了自动切过去
    cfState.progress = '引擎正在启动（已经有一次启动在进行中，完成会自动刷新）…';
    cfPaint();
    cfWatch().then(hit => {
      cfState.busy = '';
      cfState.progress = '';
      if(!hit && !cfState.running){
        cfState.error = '等了约两分钟还没起来：点「重新检测」再试一次，或看下面的启动日志';
      }
      cfPaint();
      if(!silent && cfState.running && typeof bpToast === 'function') bpToast('ComfyUI 已启动');
    });
    return;
  }
  cfState.busy = '';
  cfState.progress = '';
  /* 启动失败时主进程会回一段日志，而紧跟着的 cfDetect 会用「还没跑起来所以没日志」
   * 把它冲成空串——那恰恰是用户唯一能看出原因的线索。这里先存一把再刷新。 */
  const errLog = (r && r.log) || cfState.log;
  if(!(r && r.ok)) cfState.error = msg || '启动失败';
  await cfDetect(true);
  if(!cfState.running && errLog) cfState.log = errLog;
  cfPaint();
  cfSyncHealth();
  // 工作台图标上的状态点要跟着变，否则窗口里写着「运行中」、图标还是橙的
  if(typeof refreshDeskStates === 'function') refreshDeskStates();
  if(!silent && cfState.running && typeof bpToast === 'function') bpToast('ComfyUI 已启动');
}

/* 开机自动启动由主进程牵头，这个窗口只是旁观者：订阅它的状态广播，
 * 别人把引擎起好了这里就自己变成「运行中」，不用用户点「重新检测」。 */
let cfEngBound = false;
function cfApplyAuto(d){
  if(!d || !d.comfy) return;
  if(d.comfy === 'starting'){
    if(cfState.running || cfState.busy) return;
    cfState.busy = '启动中';
    cfState.progress = d.comfyNote || '引擎正在启动（首次加载 torch 约 100 秒，界面照常可用）…';
    cfState.error = '';
    cfPaint();
    return;
  }
  if(d.comfy === 'ready' || d.comfy === 'already'){
    if(cfState.running) return;
    cfState.busy = '';
    cfState.progress = '';
    cfState.error = '';
    cfDetect(true).then(() => {
      cfPaint();
      if(typeof refreshDeskStates === 'function') refreshDeskStates();
    });
    return;
  }
  /* idle = 还没跟主进程对过表，不是「没在启动」。把它当「没启动」会把刚进来的
     starting 状态立刻抹掉（打开窗口先对表那一刻正好撞上）。 */
  if(d.comfy === 'idle') return;
  // failed / absent / off：把「启动中」放开，别让按钮永远停在灰的那个上
  if(cfState.busy === '启动中'){
    cfState.busy = '';
    cfState.progress = '';
    if(d.comfy === 'failed') cfState.error = '自动启动没成功：' + (d.comfyNote || '原因未知');
    cfPaint();
  }
}

function cfBindEngines(){
  if(cfEngBound) return;
  cfEngBound = true;
  if(typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('engines-status', e => cfApplyAuto(e && e.detail));
}

/* 打开窗口时先对一次表：自动启动可能在页面加载前就已经在跑了，
 * 那时不会有「变成 starting」的事件，只能主动问一下当前状态。 */
function cfSyncAuto(){
  const a = window.engineAuto;
  if(!a) return;
  try{
    cfApplyAuto(a.status());
    if(typeof a.refresh === 'function') a.refresh().then(s => cfApplyAuto(s)).catch(() => {});
  }catch(e){}
}

async function cfStop(){
  const d = cfDesk();
  if(!d || cfState.busy) return;
  cfState.busy = '停止中';
  cfPaint();
  try{ await d.comfyStop(); }catch(e){}
  await cfSleep(900);
  cfState.busy = '';
  await cfDetect(true);
  cfPaint();
  cfSyncHealth();
  if(typeof refreshDeskStates === 'function') refreshDeskStates();
}

async function cfOpenUi(){
  const d = cfDesk();
  if(!d || typeof d.comfyOpenUi !== 'function') return;
  const r = await d.comfyOpenUi();
  if(r && r.ok){
    if(typeof bpToast === 'function') bpToast('已在浏览器打开 ComfyUI 界面');
  } else {
    cfState.error = (r && r.message) || '打不开界面';
    cfPaint();
  }
}

async function cfPick(){
  const d = cfDesk();
  if(!d) return;
  const r = await d.comfyPickDir();
  if(r && r.ok){
    await cfDetect(true);
    if(cfState.installed && !cfState.running) await cfLaunch(true);
  } else if(r && r.message){
    cfState.error = r.message;
    cfPaint();
  }
}

function cfGoStore(){
  const win = $('comfyWin');
  if(win) win.classList.add('hidden');
  if(typeof openModelStore === 'function') openModelStore();
}

/* ---------- 渲染 ---------- */
function cfBtn(act, label, cls){
  return '<button type="button" class="btn sm' + (cls ? ' ' + cls : '') +
    '" data-cf-act="' + act + '">' + cfEsc(label) + '</button>';
}

function cfPaint(){
  const box = $('cfApp');
  if(!box) return;
  cfEnsureShell();
  const target = cfPanel();
  if(!target) return;
  const desk = !!cfDesk();
  const running = cfState.running;
  const installed = cfState.installed;
  const busy = cfState.busy;
  const modeText = CF_MODE[cfState.mode] || '';

  /* 状态词：三态必须一眼分清，因为它决定了下面长什么样 */
  let stateWord = '未安装';
  let dot = 'off';
  let sub = '';
  if(!desk){
    stateWord = '需桌面端'; dot = 'off';
    sub = '本地生图要启动本机进程，网页版做不到。请用 The seed 桌面版打开这个 app。';
  } else if(running){
    stateWord = '运行中'; dot = 'ok';
    sub = '引擎已就绪，监听 127.0.0.1:8188。工作流界面已内嵌在本窗口（点顶部「返回界面」），' +
      '不用再去系统浏览器单开网页；生图切到「本地生成」后就走本机显卡，不再消耗云端额度。';
  } else if(busy === '启动中'){
    /* 正在起的时候徽标不能还写着「未启动」——那和下面的进度条自相矛盾，
       用户第一反应就是「卡住了」 */
    stateWord = '启动中'; dot = 'wait';
    sub = '正在启动 ComfyUI（首次加载 torch 约 100 秒）：起好这里会自动变成「运行中」，期间界面照常可用。';
  } else if(installed){
    stateWord = '已安装 · 未启动'; dot = 'wait';
    sub = '目录：' + cfState.dir + (modeText ? '（' + modeText + '）' : '') + '。启动后即可本地出图。';
  } else {
    stateWord = '未安装'; dot = 'off';
    sub = '还没在本机找到 ComfyUI。点「一键安装」会自动下载官方便携包（约 2 GB）并解压到用户目录，装完自动启动。';
  }

  /* 按钮组：按状态给不同的主操作，避免「一排按钮不知道点哪个」 */
  const btns = [];
  if(busy){
    btns.push('<button type="button" class="btn sm" disabled>' + cfEsc(busy) + '…</button>');
    if(busy === '安装中') btns.push('<button type="button" class="btn sm" data-cf-act="cancel">取消</button>');
  } else if(!desk){
    btns.push('<button type="button" class="btn sm" disabled>桌面版可用</button>');
  } else if(running){
    if(cfUi.manage) btns.push(cfBtn('showui', '返回工作流界面', 'primary'));
    btns.push(cfBtn('openui', '在浏览器打开'));
    btns.push(cfBtn('stop', '停止引擎'));
    btns.push(cfBtn('store', '装生图模型'));
  } else if(installed){
    btns.push(cfBtn('launch', '启动引擎', 'primary'));
    btns.push(cfBtn('store', '装生图模型'));
    btns.push(cfBtn('pick', '选择目录'));
    btns.push(cfBtn('refresh', '重新检测'));
  } else {
    if(cfState.canInstall) btns.push(cfBtn('install', '一键安装', 'primary'));
    btns.push(cfBtn('pick', '选择已有目录'));
    btns.push(cfBtn('refresh', '重新检测'));
  }

  /* 进度：下载有百分比，解压没有——解压 2 GB 要几分钟，
   * 画一根钉在 100% 的条会让人以为卡死了，所以走不确定态 */
  let prog = '';
  if(cfState.progress){
    const extracting = /解压|启动/.test(cfState.progress);
    const q = (!extracting && cfState.pct >= 0) ? Math.max(0, Math.min(100, cfState.pct)) : 0;
    prog = '<div class="cf-prog' + (extracting ? ' indet' : '') + '"><i' +
      (extracting ? '' : ' style="width:' + q + '%"') + '></i></div>' +
      '<div class="cf-prog-txt">' + cfEsc(cfState.progress) + '</div>';
  }

  /* 缺解压工具：极少见（Win10 1803 以下），但必须说清楚否则一键安装会莫名失败 */
  const toolHint = (desk && !installed && !busy && !cfState.canInstall)
    ? '<div class="cf-warn">没找到解压工具（系统 tar / 7-Zip 都没有）：一键安装会失败。' +
      'Win10 1803 以上都自带 tar，若确实缺失请先装 7-Zip 再回来点安装。</div>'
    : '';

  /* 技术信息：装法、解压工具、显卡。出问题时这些是唯一线索 */
  const facts = [];
  if(cfState.dir) facts.push(['安装目录', cfState.dir]);
  if(modeText) facts.push(['安装方式', modeText]);
  if(cfState.hasTar) facts.push(['解压方式', '系统 tar（免安装）']);
  else if(cfState.has7z) facts.push(['解压方式', '7-Zip']);
  if(cfState.stats){
    const sys = cfState.stats.system || {};
    const dev = cfState.stats.devices && cfState.stats.devices[0];
    if(dev) facts.push(['运行设备', String(dev.name || '') + (dev.type ? '（' + dev.type + '）' : '')]);
    if(sys.comfyui_version) facts.push(['ComfyUI 版本', String(sys.comfyui_version)]);
  }
  const factHtml = facts.length
    ? '<div class="cf-facts">' + facts.map(([k, v]) =>
        '<div class="cf-fact"><span>' + cfEsc(k) + '</span><b title="' + cfEsc(v) + '">' + cfEsc(v) + '</b></div>'
      ).join('') + '</div>'
    : '';

  /* 没装过的时候给「装好之后怎么用」，否则用户装完还是不知道下一步 */
  const steps = (!running && !installed && desk)
    ? '<div class="cf-steps">' +
        '<div class="cf-step"><i>1</i><span>点「一键安装」，等它下完并自动启动</span></div>' +
        '<div class="cf-step"><i>2</i><span>点「装生图模型」，从商店里选一个跑得动的（4 GB 显存选 SD1.5）</span></div>' +
        '<div class="cf-step"><i>3</i><span>在工作流里用「文生图 / 图生图」节点，来源选「本地生成」</span></div>' +
      '</div>'
    : '';

  const logBox = cfState.log
    ? '<details class="cf-log-wrap"' + (cfState.error ? ' open' : '') + '>' +
        '<summary>启动日志（排查失败原因用）</summary>' +
        '<pre class="cf-log">' + cfEsc(cfState.log) + '</pre>' +
      '</details>'
    : '';

  target.innerHTML =
    '<div class="cf-hero">' +
      '<div class="cf-hero-top">' +
        '<span class="cf-dot ' + dot + '"></span>' +
        '<span class="cf-title">本地生图引擎 · ComfyUI</span>' +
        '<span class="cf-state ' + dot + '">' + cfEsc(stateWord) + '</span>' +
      '</div>' +
      (sub ? '<div class="cf-sub">' + cfEsc(sub) + '</div>' : '') +
      '<div class="cf-acts">' + btns.join('') + '</div>' +
      prog +
      (cfState.error ? '<div class="cf-err">' + cfEsc(cfState.error) + '</div>' : '') +
      (cfUi.fail ? '<div class="cf-err">' + cfEsc(cfUi.fail) + '</div>' : '') +
      toolHint +
    '</div>' +
    steps +
    factHtml +
    logBox;

  target.querySelectorAll('[data-cf-act]').forEach(b => {
    b.addEventListener('click', () => cfDoAct(b.dataset.cfAct));
  });

  cfSyncChrome();
}

/* 面板和状态条共用一套动作。 */
function cfDoAct(a){
  if(a === 'install') cfInstall();
  else if(a === 'launch') cfLaunch();
  else if(a === 'stop') cfStop();
  else if(a === 'openui') cfOpenUi();
  else if(a === 'pick') cfPick();
  else if(a === 'store') cfGoStore();
  else if(a === 'cancel') cfCancelInstall();
  else if(a === 'refresh'){ cfDetect().then(cfPaint); }
  else if(a === 'reload') cfReloadFrame();
  else if(a === 'manage'){
    cfUi.manage = !cfUi.manage;
    cfUi.fail = '';
    cfPaint();
  }
  else if(a === 'showui'){
    cfUi.manage = false;
    cfUi.fail = '';
    cfPaint();
  }
}

async function cfCancelInstall(){
  const d = cfDesk();
  if(!d || typeof d.comfyCancel !== 'function') return;
  cfState.progress = '正在取消…';
  cfPaint();
  try{ await d.comfyCancel(); }catch(e){}
}

/* 打开 app：每次进来都重新检测。
 * 不走缓存——用户很可能刚在别处装完 / 起完，显示上一次的状态会让他以为没生效。 */
async function openComfyApp(){
  const win = $('comfyWin');
  if(!win) return false;
  /* 统一走 App 页翻页（deskMountApp 定义在 desk-shell.js）；拿不到时退回弹窗 */
  if(typeof deskMountApp === 'function') deskMountApp(win, '本地生图', 'ComfyUI 引擎');
  else win.classList.remove('hidden');
  cfEnsureShell();
  cfBindProgress();
  cfBindEngines();
  cfSyncAuto();
  if(!cfState.checked) cfPaint();     // 先出骨架，别让窗口空白等检测
  await cfDetect(true);
  cfPaint();
  cfStartPoll();
  return true;
}

/* 窗口开着时轻量对表：引擎可能在外部被停掉 / 被别人启动，
 * 不轮询的话状态条会一直停在旧快照。只在可见且没有安装/启动任务时跑。 */
function cfStartPoll(){
  if(cfUi.poll || typeof setInterval !== 'function') return;
  cfUi.poll = setInterval(async () => {
    const win = $('comfyWin');
    if(!win || win.classList.contains('hidden')) return;
    if(!cfDesk() || cfState.busy) return;
    const before = cfState.running + '|' + cfState.installed;
    await cfDetect(true);
    if(before !== cfState.running + '|' + cfState.installed) cfPaint();
    else cfSyncChrome();
  }, 5000);
}

/* 启动时静默探一次，让工作台图标上的状态点从一开始就是准的。
 * 延迟执行：desk-shell.js 在本文件之后加载，refreshDeskStates 那时才存在； */
setTimeout(() => {
  if(!cfDesk()) return;
  cfDetect(true).then(() => {
    if(typeof refreshDeskStates === 'function') refreshDeskStates();
  }).catch(() => {});
}, 2500);

if(typeof module !== 'undefined' && module.exports){
  module.exports = { cfState, cfDetect, cfPaint, cfInstall, cfLaunch, cfStop, openComfyApp };
}
