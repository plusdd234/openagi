/* App 注册表 —— 把「加一个 App」从「改三处共享文件」收敛成「App 自己声明一句」。
 *
 * 原来加一个 App 要动：
 *   ① index.html 里手写一段 .os-win（13 个窗口块挤在 209–600 这 392 行里）
 *   ② index.html 里加 <script>（113 个全挤在 1603–1734）和 <link>
 *   ③ desk-shell.js 的三张表（DESK_GLYPH / DESK_APPS / DESK_APP_META）
 * 三处都是「必须串行写」的单点 —— 多个 AI 同时加 App 就会互相踩。
 *
 * 现在一个 App = 一个目录：
 *   apps/<id>/app.js    里面一句 registerApp({...})
 *   apps/<id>/app.css   可选，打开时才注入
 * 清单 apps/manifest.js 由 tools/app-scan.js 自动生成，**没人手改**。
 * 于是并行的冲突面 = 0：各自写各自的目录。
 *
 * 三个必须守住的约定：
 * ① **app.js 整体包一层 IIFE**。不然 App 里的顶层函数会挂到和 1165 个名字同一个 window 作用域上，
 *    两个 AI 各写一个 openViewer() 就静默互相覆盖（git 不报错，见 tools/ns-guard.js）。
 * ② **窗口 DOM 由这里造，不写在 index.html**。file:// 下 fetch('x.html') 会失败（实测 Failed to fetch），
 *    所以模板只能是 JS 字符串 —— 这也正好让 App 自带窗口。
 * ③ **open() 返回 promise**。deskSkelWatch 会等它落定才撤骨架，脚本按需注入的那几十毫秒
 *    由骨架顶着，不会出现「翻过来了但里面空白」。
 *
 * 老 App（chat / store / player …）仍走原来那套，一行都没动；
 * 以后要迁过来，就是把它的窗口块删掉、在 apps/<id>/app.js 里声明一遍。
 */

const APP_REGISTRY = new Map();
const APP_ASSET = { css: new Map(), js: new Map() };

function appEscape(s){
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------- 按需注入（同一个地址只注入一次，重复注册不会叠样式） ---------- */
function appInjectCss(href){
  if(APP_ASSET.css.has(href)) return APP_ASSET.css.get(href);
  const p = new Promise(res => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    l.onload = () => res();
    /* 样式丢了不阻断 App：界面丑但能用，比整块打不开强 */
    l.onerror = () => { console.warn('[app] 样式加载失败', href); res(); };
    document.head.appendChild(l);
  });
  APP_ASSET.css.set(href, p);
  return p;
}

function appInjectJs(src){
  if(APP_ASSET.js.has(src)) return APP_ASSET.js.get(src);
  const p = new Promise(res => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
    s.onerror = () => { console.warn('[app] 脚本加载失败', src); res(); };
    document.head.appendChild(s);
  });
  APP_ASSET.js.set(src, p);
  return p;
}

/* ---------- 造窗口：这就是「窗口块外置」 ----------
 * 结构和 index.html 里手写的 .os-win 保持一致（os-win-bar / dots / title / close / body），
 * 所以所有既有样式、deskMountApp 的搬迁逻辑、deskAppRestore 的回位逻辑都不用改。
 *
 * def.body 是窗口 body 的初始 HTML —— 从 index.html 迁过来的那一坨原样放在这里。
 * ⚠ 它**只在新建窗口时**写。gallery 和 modelLib 共用一个 #libWin，
 *   第二个注册时窗口已存在，此处必须跳过，否则两个 App 会把对方的内容冲掉。 */
function appBuildWin(def, winId){
  const win = document.createElement('div');
  win.className = 'os-win' + (def.cls ? ' ' + def.cls : '') + ' hidden';
  win.id = winId;
  /* 标题与关闭按钮的 id **沿用 index.html 时代的老命名**（<winId>Title / btn<WinId>Close）。
     不是为了好看 —— 模块里有一堆按 id 找它们的地方，而且找关闭按钮的那些
     往往不是"关闭窗口"，是"关之前先停播放 / 先销毁 3D 场景 / 先存草稿"。
     id 一改，那些清理逻辑就静默失效，症状是切走之后后台还在跑。
     命名规则：libWin → libWinTitle / btnLibWinClose。 */
  const cap = winId.charAt(0).toUpperCase() + winId.slice(1);
  win.innerHTML =
    '<div class="os-win-bar">' +
      '<div class="os-win-dots" aria-hidden="true"><span></span><span></span><span></span></div>' +
      '<div class="os-win-title" id="' + winId + 'Title">' + appEscape(def.barTitle || def.title || def.name || def.id) + '</div>' +
      '<button class="os-win-close" type="button" id="btn' + cap + 'Close" aria-label="关闭窗口" title="关闭">×</button>' +
    '</div>' +
    '<div class="os-win-body' + (def.bodyCls ? ' ' + def.bodyCls : '') + '">' + (def.body || '') + '</div>';
  const close = win.querySelector('.os-win-close');
  /* 统一走 deskCloseWin：它会顺带划掉顶栏标签、处理全屏、再翻回桌面 */
  if(close) close.addEventListener('click', () => deskCloseWin(win));
  /* 挂在 desk-wall 里（和手写的 .os-win 同级），这样 deskAppRestore 把它放回原位时
     拿到的是同一个父节点，行为与老 App 完全一致 */
  const wall = $('deskWall');
  (wall || document.body).appendChild(win);
  return win;
}

/* ---------- 打开：先备齐样式与脚本，再交给 App 自己填内容 ----------
 * def.open 优先于 def.mount：老 App 的模块（openLibrary / openComfyApp / deskChat …）
 * 自己就会 deskMountApp + 填内容，这里只负责把脚本备齐再转发，不重复实现一遍。 */
function appOpenRegistered(def, win){
  const css = [].concat(def.css || []);
  const scripts = [].concat(def.scripts || []);
  return Promise.all(css.map(appInjectCss))
    .then(() => scripts.reduce((p, src) => p.then(() => appInjectJs(src)), Promise.resolve()))
    .then(() => {
      if(typeof def.open === 'function') return def.open(win);
      if(typeof def.mount !== 'function') return;
      const body = win.querySelector('.os-win-body');
      return def.mount(body, win);
    })
    .catch(e => {
      console.warn('[app] ' + def.id + ' 打开失败', e);
    });
}

/* ---------- 注册 ---------- */
function registerApp(def){
  if(!def || !def.id) throw new Error('registerApp: 缺 id');
  if(APP_REGISTRY.has(def.id)) { console.warn('[app] 重复注册，忽略', def.id); return null; }
  if(typeof deskAppById === 'function' && deskAppById(def.id)) {
    console.warn('[app] id 已被内置 App 占用', def.id);
    return null;
  }

  /* 窗口 id 默认由 App id 推：`img2svg` → `img2svgWin`。
   * ⚠ 先按连字符驼峰化：`my-app` 直接拼成 `my-appWin` 是个**写得进 getElementById、
   *   写不进 CSS 选择器**的 id（`#my-appWin` 会被解析成 `#my` + 元素 `appWin`），
   *   谁想给它写一行 `#my-appWin { … }` 就是一条静默失效的样式。→ `myAppWin`。 */
  const winId = def.win || (def.id + 'Win').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  let win = document.getElementById(winId);
  const created = !win;
  if(!win) win = appBuildWin(def, winId);

  /* 三张表写在这一处，不再逐个 App 手改 desk-shell.js */
  DESK_APP_META[def.id] = {
    title: def.title || def.name || def.id,
    sub: def.sub || '',
    win: winId
  };
  DESK_APPS.push({
    id: def.id,
    name: def.name || def.id,
    glyph: def.glyph,
    icon: def.icon,
    type: def.type || 'system',
    /* 桌面图标的排列位次。**由 App 自己声明，不集中到一张表里** ——
       集中就是又一个共享单点，等于把刚拆掉的热点装回去。
       没声明的排在最后（100），所以新 App 默认出现在末尾，符合直觉。
       排序用稳定排序，同 order 的两个 App 保持注册顺序。 */
    order: typeof def.order === 'number' ? def.order : 100,
    open: () => appOpenRegistered(def, win)
  });
  DESK_APPS.sort((a, b) => (a.order == null ? 100 : a.order) - (b.order == null ? 100 : b.order));

  APP_REGISTRY.set(def.id, { def: def, win: win });
  /* 图标按 DESK_APPS 重画一遍。正在桌面上时立刻能看见，在 App 页里也无害（那是另一页）。
     ⚠ 合并到微任务里只画一次：启动时是一串注册（14 个 App），
       每个都立刻重绘就是 14 次清空重建，而结果只取决于最后一次。 */
  appQueueIcons();
  return { id: def.id, winId: winId, created: created };
}

let appIconQueued = false;
function appQueueIcons(){
  if(appIconQueued) return;
  appIconQueued = true;
  Promise.resolve().then(() => {
    appIconQueued = false;
    if(typeof renderDeskIcons === 'function') renderDeskIcons();
  });
}
