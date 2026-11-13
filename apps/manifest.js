/* ============================================================
 * 自动生成，别手改 —— node tools/app-scan.js
 * App 清单：browser , card , chara , chat , code , comfy , gallery , hello , imglab , modeldesk , models , multiview , player , store
 *
 * 加一个 App = 建 apps/<id>/app.js（参考 apps/hello）+ 跑一次 app-scan。
 * index.html 与 desk-shell.js 都不用碰，所以多路 AI 并行时不会互相踩。
 * ============================================================ */
/* ---- apps/browser/app.js ---- */
/* 浏览器 —— 在 App 窗口里直接打开网页。
 *
 * 两种容器，按运行环境自动选：
 *   · Electron（主进程开了 webviewTag）→ <webview>。它是独立的 guest 页面（等价于顶层导航），
 *     X-Frame-Options / CSP frame-ancestors 管不到它 —— Tripo 这类禁止内嵌的站只有走这条路才进得来。
 *   · 普通浏览器 / 探针 → <iframe>，只能显示允许内嵌的站。
 *
 * ⚠ iframe 读不到网页内容 —— 跨域之后连标题都拿不到。所以地址栏历史是本 App 自己记的
 *   URL 栈（不碰 iframe 的 history）。webview 能收到 did-navigate，页面内跳转时地址栏会跟着变。
 *
 * ⚠ 被站点拒绝内嵌时 iframe 里是一张空白错误页，父页面**收不到任何信号**（load 照样触发）。
 *   http(s)/app:// 父页面下这张空白页的 contentDocument 同源可访问且 body 空 —— 可据此明确提示。
 *   ⚠ 但 file:// 父页面的 origin 是 opaque，跨域 iframe 的 contentDocument 一律为 null
 *   （正常站也一样读不到），此时**无法分辨**「空白」与「正常」，只给条件式出口、绝不下断言。
 *
 * ⚠ Electron 的 <webview> **必须带一个初始 src**（about:blank）。没有 src 时它不创建 guest、
 *   也不派发 dom-ready，之后任何 loadURL 都会抛 "The WebView must be attached to the DOM and
 *   the dom-ready event emitted" —— 症状就是整块白屏，状态栏只留一闪而过的报错。
 *   2026-11-13 用真实 Electron guest 复现并确认；别把这行 src 删掉。
 */
(function () {
  'use strict';

  const HOME = '';
  const SEARCH = 'https://www.bing.com/search?q=';
  /* app: 必须认得 —— Electron 发行版的页面 origin 就是 app://openagi，
     本地页地址（apps/browser/demo.html）解析出来是 app:// 开头。漏了它，
     用户手输本地地址会被当成搜索词拼到必应去。 */
  const SCHEME = /^(https?|file|ftp|data|about|app):/i;
  const BLOCKED_SCHEME = /^(javascript|vbscript|blob):/i;

  const SVG = (d) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  const ICO = {
    back: SVG('<path d="M15 4.5 7.5 12 15 19.5"/>'),
    fwd: SVG('<path d="M9 4.5 16.5 12 9 19.5"/>'),
    reload: SVG('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3.5V9h-5.5"/>'),
    home: SVG('<path d="M4 11.5 12 4l8 7.5"/><path d="M6.5 10.3V20h11v-9.7"/>'),
    ext: SVG('<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v6H4V6h6"/>'),
    lock: SVG('<rect x="5.5" y="10" width="13" height="9" rx="2"/><path d="M8.5 10V7.6a3.5 3.5 0 0 1 7 0V10"/>'),
    go: SVG('<path d="M5 12h12.5"/><path d="m13 7.5 4.5 4.5-4.5 4.5"/>'),
    globe: SVG('<circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2"/><path d="M12 3.4c2.5 2.4 3.9 5.4 3.9 8.6s-1.4 6.2-3.9 8.6c-2.5-2.4-3.9-5.4-3.9-8.6s1.4-6.2 3.9-8.6Z"/>')
  };

  function localUrl(rel){
    try { return new URL(rel, location.href).href; } catch (e) { return rel; }
  }

  /* 起始页导航：按用途分组。图标用单字/缩写瓷贴，颜色按站点气质取，
     不引外部 favicon —— 断网打开时不会出现一排破图。
     url 都是站点首页，直达功能页（如抠图）用对应的深链。 */
  const NAV = [
    {
      title: '3D 生成',
      hint: '文本 / 图片 → 模型',
      items: [
        { name: 'Tripo 国际版', mark: 'T', badge: '国际版', note: '文生 / 图生 3D', url: 'https://www.tripo3d.ai/', tint: '#e9f1ff', ink: '#2f6ad0' },
        { name: 'Meshy', mark: 'M', note: '建模 · 贴图 · 动画', url: 'https://www.meshy.ai/', tint: '#f0ecff', ink: '#6a4ed1' },
        { name: '混元 3D', mark: '混', badge: '腾讯', note: '混元 · 文生 3D', url: 'https://3d.hunyuan.tencent.com/', tint: '#e6f7f9', ink: '#0c7c93' },
        { name: 'Hyper3D Rodin', mark: 'R', note: '高质量 3D 生成', url: 'https://hyper3d.ai/', tint: '#fff0e8', ink: '#c0641f' },
        { name: 'Luma Genie', mark: 'L', note: '文生 3D 场景', url: 'https://lumalabs.ai/genie', tint: '#f2f4f7', ink: '#4a5568' },
        { name: 'CSM 3D', mark: 'C', note: '图生 3D 场景', url: 'https://3d.csm.ai/', tint: '#eaf7ef', ink: '#237a4c' }
      ]
    },
    {
      title: '图像处理',
      hint: '抠图 / 压缩 / 修复',
      items: [
        { name: '佐糖 AI 抠图', mark: '扣', badge: '推荐', note: '一键去背景', url: 'https://picwish.cn/remove-background', tint: '#e7f6ed', ink: '#1f7a4d' },
        { name: '佐糖工具箱', mark: '糖', note: '图片处理工具箱', url: 'https://picwish.cn/', tint: '#eaf7f3', ink: '#1c7a6b' },
        { name: 'remove.bg', mark: 'bg', note: '通用在线抠图', url: 'https://www.remove.bg/', tint: '#eef2f8', ink: '#3c5a8a' },
        { name: 'TinyPNG', mark: 'T', note: '在线图片压缩', url: 'https://tinypng.com/', tint: '#fff5e3', ink: '#a5761a' }
      ]
    },
    {
      title: '素材与设计',
      hint: '模型 / 材质 / 网页 3D',
      items: [
        { name: 'Sketchfab', mark: 'S', note: '3D 模型社区', url: 'https://sketchfab.com/', tint: '#e8f3ff', ink: '#2b6cb0' },
        { name: 'Poly Haven', mark: 'P', note: 'HDRI · 材质 · 模型', url: 'https://polyhaven.com/', tint: '#eaf7ef', ink: '#2f7d4f' },
        { name: 'Spline', mark: 'S', note: '网页 3D 设计', url: 'https://spline.design/', tint: '#fdeef4', ink: '#b03a6b' }
      ]
    },
    {
      title: '通用',
      hint: '搜索 / 文档 / 离线验证',
      items: [
        { name: '必应', mark: 'B', note: '网页搜索', url: 'https://www.bing.com/', tint: '#e9f2ff', ink: '#2563b8' },
        { name: '维基百科', mark: 'W', note: '中文百科', url: 'https://zh.wikipedia.org/', tint: '#f1f3f6', ink: '#4a5568' },
        { name: 'MDN', mark: 'M', note: 'Web 文档', url: 'https://developer.mozilla.org/zh-CN/', tint: '#edf1f5', ink: '#33475c' },
        { name: '本地示例页', mark: '本', badge: '离线', note: '验证内嵌是否正常', url: localUrl('apps/browser/demo.html'), tint: '#fdf6e6', ink: '#a5761a' }
      ]
    }
  ];

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* 单实例状态：窗口节点在切回桌面时只是被藏起来，状态必须跟着它活着。
     再次 mount 只做同步，不重建 DOM —— 否则当前网页会被冲掉（README 的幂等约束）。 */
  let S = null;

  function looksLikeUrl(s){
    if (/^localhost(:\d+)?([/?#]|$)/i.test(s)) return true;
    if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#]|$)/.test(s)) return true;
    return /^[^\s/]+\.[^\s/]{2,}([/?#]|$)/.test(s);
  }

  /* 网址规整：能看出是地址就补 https://，否则当搜索词。
     返回 null 表示拒绝（javascript: 之类会让 iframe 在父页面上下文里执行）。 */
  function normalize(raw){
    const s = String(raw || '').trim();
    if (!s) return HOME;
    if (BLOCKED_SCHEME.test(s)) return null;
    if (SCHEME.test(s)) return s;
    if (looksLikeUrl(s)){
      /* 本机地址默认 http：https 在 localhost 上十有八九连不上 */
      if (/^(localhost|127\.|192\.168\.|10\.)/i.test(s)) return 'http://' + s;
      return 'https://' + s;
    }
    return SEARCH + encodeURIComponent(s);
  }

  function buildState(body){
    return {
      body: body,
      app: body.querySelector('.bw-app'),
      frame: null,          /* iframe 或 webview，mount 时按运行环境决定 */
      web: false,           /* true = Electron webview（不受 X-Frame-Options 限制） */
      frameReady: true,     /* webview 要等 dom-ready 才允许 loadURL */
      pending: null,
      start: body.querySelector('.bw-start'),
      addr: body.querySelector('.bw-input'),
      sec: body.querySelector('.bw-sec'),
      statusUrl: body.querySelector('.bw-status-url'),
      statusMsg: body.querySelector('.bw-status-msg'),
      back: body.querySelector('[data-act="back"]'),
      fwd: body.querySelector('[data-act="forward"]'),
      reloadBtn: body.querySelector('[data-act="reload"]'),
      externals: Array.prototype.slice.call(body.querySelectorAll('[data-act="external"]')),
      hist: [HOME],
      at: 0,
      url: HOME,
      loading: false,
      msgTimer: 0,
      pendingWatch: 0,     /* guest 迟迟不 dom-ready 时的诊断计时 */
      frameCheck: 0,       /* iframe 空白页判定计时 */
      zoom: 1,             /* webview 缩放系数，1 = 100% */
      zoomTouched: false,  /* 用户手动调过后不再自动适应 */
      fitTimer: 0,         /* did-stop-loading 后延迟测宽 */
      zoomVal: body.querySelector('.bw-zoom-val'),
      zoomFit: body.querySelector('.bw-zoom-fit')
    };
  }

  /* ms=0 表示常驻：XFO 白屏提示要一直挂着，一闪而过等于没提示 */
  function flash(st, text, ms){
    st.statusMsg.textContent = text;
    clearTimeout(st.msgTimer);
    if (ms === 0) return;
    st.msgTimer = setTimeout(() => { st.statusMsg.textContent = ''; }, ms || 2600);
  }
  function clearMsg(st){
    clearTimeout(st.msgTimer);
    st.statusMsg.textContent = '';
  }

  function sync(st){
    const home = st.url === HOME;
    st.back.disabled = st.at <= 0;
    st.fwd.disabled = st.at >= st.hist.length - 1;
    st.reloadBtn.disabled = home;
    st.app.classList.toggle('is-loading', !!st.loading && !home);
    st.statusUrl.textContent = home ? '起始页' : st.url;
    st.statusUrl.title = home ? '' : st.url;
    st.externals.forEach(b => { b.disabled = home; });
    const secure = /^https:/i.test(st.url);
    st.sec.classList.toggle('is-warn', !secure && !home);
    st.sec.title = home ? '地址' : (secure ? 'HTTPS 加密连接' : '非加密连接');
  }

  function setAddr(st, v){
    st.addr.value = v;
  }

  /* 刷新必须绕过「src 赋同值不重载」：先试 location.href（跨域允许写），
     不行再退回 about:blank → 原地址 的两拍。 */
  function loadFrame(st, url, reload){
    if (reload){
      try {
        st.frame.contentWindow.location.href = url;
        return;
      } catch (e) { /* 跨域读失败就退回下面的写法 */ }
      st.frame.src = 'about:blank';
      setTimeout(() => { if (st.url === url) st.frame.src = url; }, 0);
      return;
    }
    st.frame.src = url;
  }

  /* Electron 的 webview：它是独立 guest，X-Frame-Options 管不到它。
     loadURL 要等 dom-ready，没就绪的请求先排队（用户点得快时会发生）。 */
  function loadWebview(st, url, reload){
    if (!st.frameReady){
      st.pending = { url: url, reload: !!reload };
      /* 旧版在这里挂了一个「1600ms 后强行 loadURL」的兜底。那是错的：guest 没发过
         dom-ready 时 loadURL 必然抛错，结果就是白屏 + 一闪而过的一行报错。
         dom-ready 是唯一可信的放行信号；这里只做「迟迟没来」的诊断提示。 */
      clearTimeout(st.pendingWatch);
      st.pendingWatch = setTimeout(() => {
        if (st.pending) flash(st, '网页容器未就绪，可点「在系统浏览器打开」', 0);
      }, 2500);
      return;
    }
    try {
      if (reload) st.frame.reload();
      else st.frame.loadURL(url);
    } catch (e) {
      flash(st, '网页加载失败：' + ((e && e.message) || e));
    }
  }

  /* webview 不能用 display:none：guest 会被压成 0 尺寸，部分站点会直接白屏。
     所以两种容器的「收起」语义不同，统一收到这里。 */
  function showFrame(st, on){
    if (st.web) st.frame.classList.toggle('is-off', !on);
    else st.frame.classList.toggle('hidden', !on);
  }

  /* iframe 白屏判定：XFO 拒绝内嵌后是一张空白错误页。
     两档，别把「读不到」当成「空白」：
       ① contentDocument 可读且 body 空、无子节点 → 可确定，给明确诊断（XFO 白屏）；
       ② contentDocument 读不到（file:// 父页面下所有跨域站都如此）→ 无法分辨，
          只给「若空白 → 系统浏览器打开」的条件出口，绝不写「禁止被内嵌」。
     本地 file:// 页不参与判定（本地页不可能有 XFO，且它自身也读不到）。
     只给提示、不假装能修复；webview 有真实事件，不需要猜。 */
  function armFrameCheck(st){
    clearTimeout(st.frameCheck);
    if (st.web || st.url === HOME || /^file:/i.test(st.url)) return;
    st.frameCheck = setTimeout(() => {
      if (st.url === HOME) return;
      let doc = null;
      try { doc = st.frame.contentDocument; } catch (e) { doc = null; }
      if (!doc){
        flash(st, '若此页空白，点右下「在系统浏览器打开」', 0);
        return;
      }
      const b = doc.body;
      if (b && !String(b.innerText || '').trim() && b.children.length === 0){
        flash(st, '该站点禁止被内嵌，页面为空白 · 点右下「在系统浏览器打开」', 0);
      }
    }, 1800);
  }

  /* ---- 缩放 / 适应宽度 ----
     站点常带固定最小宽度（Tripo 工作台实测 1280px）。工作台窗口比它窄时右侧内容
     直接进不了可视区；App 页的窗口是铺满画布的，拉宽主窗口也未必够（实测画布上限 ~1200）。
     webview 的 setZoomFactor 等价于浏览器 Ctrl+-：缩小后 window.innerWidth 变大，
     页面按更多 CSS 像素重排，横向溢出随之消失。iframe 没有这个能力，控件对它隐藏。 */
  const ZOOM_MIN = 0.5, ZOOM_MAX = 1.6, ZOOM_STEP = 0.1;

  function setZoom(st, f){
    if (!st.web || !st.frame) return;
    f = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(f * 100) / 100));
    st.zoom = f;
    try { st.frame.setZoomFactor(f); }
    catch (e) { flash(st, '缩放失败：' + ((e && e.message) || e)); return; }
    if (st.zoomVal) st.zoomVal.textContent = Math.round(f * 100) + '%';
    if (st.zoomFit) st.zoomFit.classList.remove('is-on');
  }

  /* 读 guest 的「内容宽 / 视口宽」，算刚好塞得下的缩放系数。
     zoom 之后 innerWidth = 物理视口宽 / zoom，故 100% 视口宽 = innerWidth * 当前 zoom。 */
  function fitWidth(st, auto){
    if (!st.web || !st.frame || typeof st.frame.executeJavaScript !== 'function') return;
    let p;
    try {
      p = st.frame.executeJavaScript(
        '({iw:window.innerWidth,' +
        'sw:Math.max(document.documentElement.scrollWidth,' +
        '(document.body?document.body.scrollWidth:0))})'
      );
    } catch (e) { return; }
    Promise.resolve(p).then(m => {
      if (!m || !m.iw || !m.sw) return;
      const baseW = m.iw * st.zoom;
      const f = Math.min(1, baseW / m.sw);
      if (f >= 0.985){
        if (!auto) flash(st, '页面已完整显示，无需缩放');
        if (st.zoomFit) st.zoomFit.classList.add('is-on');
        return;
      }
      setZoom(st, Math.max(ZOOM_MIN, f));
      if (st.zoomFit) st.zoomFit.classList.add('is-on');
      if (!auto) flash(st, '已缩放至 ' + Math.round(st.zoom * 100) + '% 以适应窗口');
    }).catch(() => {});
  }

  /* 运行环境决定容器：
     · Electron（主进程开了 webviewTag）→ <webview>，能进禁止内嵌的站；
     · 普通浏览器 / 探针 → <iframe>，允许内嵌的站照常显示。 */
  function makeFrame(){
    try {
      const wv = document.createElement('webview');
      if (wv && typeof wv.loadURL === 'function'){
        wv.className = 'bw-frame bw-webview is-off';
        wv.setAttribute('title', '网页内容');
        wv.setAttribute('webpreferences', 'nodeIntegration=no, contextIsolation=yes');
        /* 没有 src 的 webview 不会创建 guest、也不会派发 dom-ready —— loadURL 必抛错、白屏。
           about:blank 让 guest 在 append 后立刻就绪，dom-ready 才会把 frameReady 解锁。 */
        wv.setAttribute('src', 'about:blank');
        return wv;
      }
    } catch (e) { /* 普通浏览器里没有 webview */ }
    const f = document.createElement('iframe');
    f.className = 'bw-frame hidden';
    f.setAttribute('title', '网页内容');
    f.setAttribute('referrerpolicy', 'no-referrer');
    return f;
  }

  function apply(st, url, reload){
    st.url = url;
    /* 每次导航都把上一次的提示 / 计时作废，否则「白屏提示」会挂到下一个正常页面上 */
    clearMsg(st);
    clearTimeout(st.frameCheck);
    clearTimeout(st.pendingWatch);
    clearTimeout(st.fitTimer);   /* 上一页的适应测量不能落到新页面上 */
    if (url === HOME){
      st.pending = null;
      st.loading = false;
      st.start.classList.remove('hidden');
      showFrame(st, false);
      if (st.web){
        try { st.frame.loadURL('about:blank'); } catch (e) { /* 还没 dom-ready，下次再清 */ }
      } else if (st.frame.getAttribute('src') !== 'about:blank'){
        st.frame.src = 'about:blank';
      }
      setAddr(st, '');
    } else {
      st.start.classList.add('hidden');
      showFrame(st, true);
      st.loading = true;
      setAddr(st, url);
      if (st.web) loadWebview(st, url, reload);
      else { loadFrame(st, url, reload); armFrameCheck(st); }
    }
    sync(st);
  }

  function navigate(st, url, opts){
    opts = opts || {};
    const cur = st.hist[st.at];
    const same = url === cur && url !== HOME;
    if (!opts.replace && url !== cur){
      st.hist = st.hist.slice(0, st.at + 1);
      st.hist.push(url);
      st.at = st.hist.length - 1;
    }
    apply(st, url, same || !!opts.reload);
  }

  function step(st, delta){
    const next = st.at + delta;
    if (next < 0 || next >= st.hist.length) return;
    st.at = next;
    apply(st, st.hist[next], false);
  }

  function fromInput(st){
    const url = normalize(st.addr.value);
    if (url === null){
      setAddr(st, st.url);
      flash(st, '已拦截不安全的地址');
      return;
    }
    if (url === st.url && url !== HOME) apply(st, url, true);
    else navigate(st, url);
  }

  function openExternal(st){
    if (!st.url) return;
    try {
      window.open(st.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      flash(st, '打开失败：' + ((e && e.message) || e));
    }
  }

  function doAct(st, act){
    if (act === 'back') step(st, -1);
    else if (act === 'forward') step(st, 1);
    else if (act === 'reload') { if (st.url !== HOME) apply(st, st.url, true); }
    else if (act === 'home') navigate(st, HOME);
    else if (act === 'external') openExternal(st);
    else if (act === 'zoom-out'){ st.zoomTouched = true; setZoom(st, st.zoom - ZOOM_STEP); }
    else if (act === 'zoom-in'){ st.zoomTouched = true; setZoom(st, st.zoom + ZOOM_STEP); }
    else if (act === 'zoom-reset'){ st.zoomTouched = true; setZoom(st, 1); }
    else if (act === 'zoom-fit'){ st.zoomTouched = true; fitWidth(st, false); }
  }

  /* load 事件在「被 X-Frame-Options 拦掉」时也会触发，所以它只能当「加载结束」用，
     不能当「加载成功」用。跨域时 location 读不到 → 地址栏保持最后一次明确导航的 URL。 */
  function onFrameLoad(st){
    let href = '';
    let cross = false;
    try { href = st.frame.contentWindow.location.href; }
    catch (e) { cross = true; }
    if (!cross && (!href || href === 'about:blank')) return;   // 初始空文档，忽略
    st.loading = false;
    if (href && href !== st.url){
      st.url = href;
      st.hist[st.at] = href;     // 页面内部跳转 / 重定向：只更新当前条目
      setAddr(st, href);
    }
    sync(st);
  }

  /* webview 版：did-navigate / did-navigate-in-page 会带上真实地址，
     连 SPA 路由变化都能同步到地址栏（iframe 做不到这件事）。 */
  function syncFromGuest(st, url){
    if (!url || url === 'about:blank') return;
    st.url = url;
    st.hist[st.at] = url;
    setAddr(st, url);
    sync(st);
  }

  function wireFrame(st){
    if (st.web){
      st.frame.addEventListener('dom-ready', () => {
        st.frameReady = true;
        clearTimeout(st.pendingWatch);
        if (st.pending){
          const p = st.pending;
          st.pending = null;
          loadWebview(st, p.url, p.reload);
        }
      });
      st.frame.addEventListener('did-start-loading', () => { st.loading = true; sync(st); });
      st.frame.addEventListener('did-stop-loading', () => {
        st.loading = false;
        sync(st);
        /* 页面内容常是异步渲染的，停载后稍等再量宽；用户手动调过缩放就不再自动改。 */
        clearTimeout(st.fitTimer);
        if (!st.zoomTouched && st.url !== HOME){
          st.fitTimer = setTimeout(() => fitWidth(st, true), 650);
        }
      });
      st.frame.addEventListener('did-navigate', (e) => syncFromGuest(st, e.url));
      st.frame.addEventListener('did-navigate-in-page', (e) => syncFromGuest(st, e.url));
      st.frame.addEventListener('did-fail-load', (e) => {
        if (e.errorCode === -3) return;   // -3 = 用户主动中止 / 切换地址
        st.loading = false;
        flash(st, '加载失败：' + (e.errorDescription || e.errorCode));
        sync(st);
      });
      /* 不设「到点强行 loadURL」的兜底：src=about:blank 保证 dom-ready 会来；
         万一没来，loadWebview 里那条 pendingWatch 会给出诊断提示，而不是制造白屏。 */
      return;
    }
    st.frame.addEventListener('load', () => onFrameLoad(st));
  }

  function drawNav(st){
    const wrap = st.body.querySelector('#bwQuick');
    wrap.innerHTML = NAV.map(g =>
      '<section class="bw-group">' +
        '<div class="bw-group-head">' +
          '<h2 class="bw-group-title">' + esc(g.title) + '</h2>' +
          (g.hint ? '<span class="bw-group-hint">' + esc(g.hint) + '</span>' : '') +
        '</div>' +
        '<div class="bw-quick">' +
          g.items.map(it =>
            '<button type="button" class="bw-link" data-url="' + esc(it.url) + '" title="' + esc(it.url) + '">' +
              '<span class="bw-link-ico" style="--tint:' + esc(it.tint) + ';--ink:' + esc(it.ink) + '">' + esc(it.mark) + '</span>' +
              '<span class="bw-link-main">' +
                '<span class="bw-link-top">' +
                  '<span class="bw-link-name">' + esc(it.name) + '</span>' +
                  (it.badge ? '<span class="bw-link-badge">' + esc(it.badge) + '</span>' : '') +
                '</span>' +
                '<span class="bw-link-note">' + esc(it.note) + '</span>' +
              '</span>' +
              '<span class="bw-link-go" aria-hidden="true">↗</span>' +
            '</button>').join('') +
        '</div>' +
      '</section>').join('');
  }

  function wire(st){
    st.addr.form.addEventListener('submit', (e) => {
      e.preventDefault();
      fromInput(st);
    });

    /* 一个委托监听同时管按钮和起始页的常用入口，省掉逐个绑定 */
    st.app.addEventListener('click', (e) => {
      const link = e.target.closest('[data-url]');
      if (link){
        const url = link.getAttribute('data-url');
        setAddr(st, url);
        navigate(st, url);
        return;
      }
      const act = e.target.closest('[data-act]');
      if (act) doAct(st, act.getAttribute('data-act'));
    });

    st.app.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'l'){
        e.preventDefault();
        st.addr.focus();
        st.addr.select();
      } else if (e.key === 'Escape' && document.activeElement === st.addr){
        setAddr(st, st.url);
        st.addr.blur();
      }
    });
  }

  const HTML = `
    <div class="bw-app">
      <div class="bw-bar">
        <button type="button" class="bw-btn" data-act="back" title="后退" aria-label="后退">${ICO.back}</button>
        <button type="button" class="bw-btn" data-act="forward" title="前进" aria-label="前进">${ICO.fwd}</button>
        <button type="button" class="bw-btn" data-act="reload" title="刷新" aria-label="刷新">${ICO.reload}</button>
        <button type="button" class="bw-btn" data-act="home" title="起始页" aria-label="起始页">${ICO.home}</button>
        <form class="bw-addr" autocomplete="off">
          <span class="bw-sec" aria-hidden="true">${ICO.lock}</span>
          <input class="bw-input" type="text" spellcheck="false" placeholder="输入网址或搜索词，回车前往" aria-label="地址栏">
          <button class="bw-go" type="submit" title="前往" aria-label="前往">${ICO.go}</button>
        </form>
        <button type="button" class="bw-btn bw-btn-ext" data-act="external" title="在系统浏览器打开" aria-label="在系统浏览器打开">${ICO.ext}</button>
      </div>

      <div class="bw-view">
        <div class="bw-start">
          <div class="bw-start-in">
            <div class="bw-hero">
              <span class="bw-hero-ico">${ICO.globe}</span>
              <div>
                <h1>AI 创作导航</h1>
                <p>3D 生成、AI 抠图与常用站点，点一下直达。</p>
              </div>
            </div>
            <div class="bw-hero-tip">地址栏也可以直接输入网址或搜索词</div>
            <div class="bw-nav" id="bwQuick"></div>
            <div class="bw-note">
              <b>部分站点会显示空白。</b>Tripo、Meshy 等用 X-Frame-Options / CSP 禁止被别的页面内嵌。
              桌面版走的是 webview，不受这条限制；在普通浏览器里打开时如果空白，
              点状态栏右下的「在系统浏览器打开」。
            </div>
          </div>
        </div>
      </div>

      <div class="bw-status">
        <span class="bw-status-url">起始页</span>
        <span class="bw-status-msg" aria-live="polite"></span>
        <span class="bw-zoom" aria-label="网页缩放">
          <button type="button" class="bw-zoom-btn" data-act="zoom-out" title="缩小">−</button>
          <button type="button" class="bw-zoom-val" data-act="zoom-reset" title="恢复 100%">100%</button>
          <button type="button" class="bw-zoom-btn" data-act="zoom-in" title="放大">+</button>
          <button type="button" class="bw-zoom-fit" data-act="zoom-fit" title="缩放以适应窗口宽度">适应</button>
        </span>
        <button type="button" class="bw-status-ext" data-act="external">在系统浏览器打开 ↗</button>
      </div>
    </div>`;

  registerApp({
    id: 'browser',
    name: '浏览器',
    title: '浏览器',
    sub: '内嵌网页 · 地址栏与前进后退',
    icon: deskSvg('globe'),
    order: 14,
    cls: 'browser',
    win: 'browserWin',
    css: ['apps/browser/app.css'],
    mount: function (body){
      if (body.dataset.ready === '1' && S && S.body === body){
        sync(S);          // 已经画过：只同步按钮状态，不重建（否则当前网页被冲掉）
        return;
      }
      body.innerHTML = HTML;
      S = buildState(body);
      S.frame = makeFrame();
      S.web = S.frame.tagName.toLowerCase() === 'webview';
      S.app.classList.toggle('is-web', S.web);   /* iframe 模式隐藏缩放控件 */
      S.frameReady = !S.web;
      body.querySelector('.bw-view').appendChild(S.frame);
      drawNav(S);
      wireFrame(S);
      wire(S);
      body.dataset.ready = '1';
      sync(S);
      setTimeout(() => S.addr.focus(), 80);
    }
  });
})();

/* ---- apps/card/app.js ---- */
/* 名片 —— 「我是谁」这件事在桌面上有个正经去处。
 *
 * 内容全部由 js/dev-card.js 的 CD 常量渲染，改文案只改那一处；
 * 这里只有骨架（头图、几块 section、右侧赞赏码 / 群 / 链接）。
 *
 * 一张图兜底一处：头像和两张二维码都带 fb 占位（图没放时显示一块说明，
 * 而不是一个破图裂图标）——放图的位置写在 fb 文案里，用户自己就能补。
 */
(function () {
  'use strict';

  registerApp({
    id: 'card',
    name: '名片',
    title: '名片',
    sub: '作者与联系方式',
    glyph: 'card',
    order: 13,
    cls: 'card',
    win: 'cardWin',
    body: `
        <div class="cd-wrap">
          <div class="cd-main">
            <div class="cd-hero">
              <div class="cd-ava">
                <img id="cdAva" src="img/avatar.jpg" alt="虚幻茅场 的头像" draggable="false">
                <span class="cd-ava-fb" aria-hidden="true">虚</span>
              </div>
              <div class="cd-id">
                <div class="cd-name-row">
                  <h1 class="cd-name" id="cdName">虚幻茅场</h1>
                  <span class="cd-lv" id="cdLv">LV5</span>
                </div>
                <div class="cd-tag" id="cdTag"></div>
                <div class="cd-uid">
                  <span class="cd-uid-v" id="cdUid">UID 641892012</span>
                  <button type="button" class="cd-copy" id="cdCopyUid" data-copy="641892012" title="复制 UID">复制</button>
                </div>
              </div>
            </div>

            <div class="cd-stats" id="cdStats"></div>

            <section class="cd-sec">
              <h2 class="cd-h2">关于我</h2>
              <div class="cd-about" id="cdAbout"></div>
            </section>

            <section class="cd-sec">
              <h2 class="cd-h2">在做的四条线</h2>
              <div class="cd-tracks" id="cdTracks"></div>
            </section>

            <section class="cd-sec">
              <h2 class="cd-h2">合集与代表作<span class="cd-h2-note">右侧为该集播放量</span></h2>
              <div class="cd-works" id="cdWorks"></div>
            </section>
          </div>

          <aside class="cd-side">
            <div class="cd-pay">
              <div class="cd-pay-h" id="cdPayTitle">请我喝杯咖啡</div>
              <div class="cd-qr" id="cdQrBox">
                <img id="cdQr" src="img/pay-qr.png" alt="微信赞赏码" draggable="false">
                <div class="cd-qr-fb" id="cdQrFb">把赞赏码放到 img/pay-qr.png</div>
              </div>
              <div class="cd-pay-s" id="cdPayS">微信扫码赞赏 · 感谢每一份充电</div>
            </div>

            <!-- 技术交流群：和赞赏码是同一类动作（扫码 / 找号码），所以并排放在一起 -->
            <div class="cd-group">
              <div class="cd-group-h" id="cdGroupName">虚幻引擎蓝图笔记3群</div>
              <div class="cd-qr cd-qr-sm">
                <img id="cdGroupQr" src="img/qq-group.png" alt="技术交流群 QQ 二维码" draggable="false">
                <div class="cd-qr-fb" id="cdGroupFb">把 QQ 群二维码放到 img/qq-group.png</div>
              </div>
              <div class="cd-group-foot">
                <span class="cd-group-id" id="cdGroupId">群号 1108459704</span>
                <button type="button" class="cd-copy" id="cdCopyGroup" data-copy="1108459704" title="复制群号">复制</button>
              </div>
            </div>

            <div class="cd-links" id="cdLinks"></div>

            <div class="cd-foot" id="cdFoot"></div>
          </aside>
        </div>`,
    open: function () {
      if (typeof window.devCard !== 'undefined' && typeof window.devCard.open === 'function') window.devCard.open();
    }
  });
})();

/* ---- apps/chara/app.js ---- */
/* 角色工坊 —— 插画 → 部位图 → 三视图 → Tripo 3D 候选 → 导出。
 *
 * 工作流设计借鉴开源套件 Charakuru（nanocle/Charakuru，source-available）的
 * 「分阶段 + 确认点」理念：每个阶段产出可检查的中间物，用户点了「确认并继续」
 * 才放行下一阶段；本实现全部用本项目已有的能力（云生图 / Tripo API / Model3D），
 * 未搬运其任何代码或素材。VRM 的骨骼与权重需要 Blender，本项目导出 GLB 与制作包。
 *
 * 状态存 localStorage（hf_charaProj），大图走 blob-store 外置（blobPack 存根）。
 */
(function () {
  'use strict';

  var STORE_KEY = 'hf_charaProj';
  var byId = function (id) { return document.getElementById(id); };

  /* ---------- 阶段定义 ---------- */
  var STAGES = [
    { id: 'src',    name: '原画',    desc: '导入一张有权使用的全身角色插画' },
    { id: 'parts',  name: '部位图',  desc: '头部 / 身体各四视图，共 8 张' },
    { id: 'views',  name: '三视图',  desc: '全身 正 / 侧 / 背，建模参考' },
    { id: 'model',  name: '3D 候选', desc: 'Tripo 生成模型，你来挑' },
    { id: 'export', name: '预览导出', desc: '3D 预览 · 四视图 · 导出' }
  ];

  /* 部位图 8 张的提示词模板（英文直出，不再走翻译链）。
   * 部位图的目标是「喂给 Tripo 的干净参考」，不是插画再创作。 */
  var PARTS = [
    { key: 'head.front',  label: '头 · 正面',  prompt: 'character design reference sheet: the character\'s HEAD ONLY (face and hair, cut at the neck, no body), front view, centered on plain light gray background, keep the exact hairstyle, face and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'head.threeq', label: '头 · 四分之三', prompt: 'character design reference sheet: the character\'s HEAD ONLY (face and hair, cut at the neck, no body), three-quarter view, centered on plain light gray background, keep the exact hairstyle, face and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'head.side',   label: '头 · 侧面',  prompt: 'character design reference sheet: the character\'s HEAD ONLY (face and hair, cut at the neck, no body), side profile view, centered on plain light gray background, keep the exact hairstyle and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'head.back',   label: '头 · 背面',  prompt: 'character design reference sheet: the back of the character\'s HEAD ONLY (hair only, no face, no body), back view, centered on plain light gray background, keep the exact hairstyle and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.front',  label: '身 · 正面',  prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), front view, A-pose with arms slightly away, plain light gray background, keep the exact outfit, colors and proportions of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.threeq', label: '身 · 四分之三', prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), three-quarter view, A-pose, plain light gray background, keep the exact outfit, colors and proportions of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.side',   label: '身 · 侧面',  prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), side profile view, A-pose, plain light gray background, keep the exact outfit and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'body.back',   label: '身 · 背面',  prompt: 'character design reference sheet: the character\'s BODY ONLY from the neck down (no head, no face), back view, A-pose, plain light gray background, keep the exact outfit and colors of the reference illustration, clean lineart with flat colors, no text, no watermark' }
  ];

  var VIEWS = [
    { key: 'front', label: '全身 · 正面', prompt: 'character turnaround reference sheet: FULL BODY front view of this character, A-pose, plain light gray background, keep the exact design of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'side',  label: '全身 · 侧面', prompt: 'character turnaround reference sheet: FULL BODY side profile view of this character, A-pose, plain light gray background, keep the exact design of the reference illustration, clean lineart with flat colors, no text, no watermark' },
    { key: 'back',  label: '全身 · 背面', prompt: 'character turnaround reference sheet: FULL BODY back view of this character, A-pose, plain light gray background, keep the exact design of the reference illustration, clean lineart with flat colors, no text, no watermark' }
  ];

  /* ---------- 状态 ---------- */
  function blankPart() { return { img: '', status: '' }; }

  var state = {
    stage: 0,
    src: '', srcName: '', srcInfo: '',
    parts: {},                    // key → {img:stub|dataURL, status}
    views: {},                    // key → {img, status}
    mode: 'full',                 // full=整体 | split=头身分离
    modelSrc: 'views.front',      // 整体建模的输入图
    candN: 2,
    cands: { full: [], head: [], body: [] },   // [{model,preview,credits,version,src}]
    pick: { full: -1, head: -1, body: -1 }
  };
  PARTS.forEach(function (p) { state.parts[p.key] = blankPart(); });
  VIEWS.forEach(function (v) { state.views[v.key] = blankPart(); });

  var busy = {};                // key → true（生成中的格子）
  var candBusy = [];            // 'full' | 'head' | 'body'
  var footMsg = '';

  /* ---------- 存取 ---------- */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, stage: state.stage, mode: state.mode, modelSrc: state.modelSrc,
        candN: state.candN, pick: state.pick,
        src: blobPack(state.src), srcName: state.srcName, srcInfo: state.srcInfo,
        parts: state.parts, views: state.views,
        cands: state.cands
      }));
    } catch (e) { /* 配额满时宁可丢草稿也不打断流程 */ }
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (!raw) return;
    var d;
    try { d = JSON.parse(raw); } catch (e) { return; }
    if (!d || d.v !== 1) return;
    state.stage = Math.min(Math.max(d.stage | 0, 0), STAGES.length - 1);
    state.mode = d.mode === 'split' ? 'split' : 'full';
    state.modelSrc = typeof d.modelSrc === 'string' ? d.modelSrc : 'views.front';
    state.candN = Math.min(Math.max(d.candN | 0, 1), 3);
    state.pick = d.pick && typeof d.pick === 'object' ? d.pick : state.pick;
    state.srcName = d.srcName || '';
    state.srcInfo = d.srcInfo || '';
    state.src = typeof d.src === 'string' ? d.src : '';
    if (d.parts && typeof d.parts === 'object') {
      Object.keys(state.parts).forEach(function (k) {
        if (d.parts[k]) state.parts[k] = { img: d.parts[k].img || '', status: d.parts[k].status || '' };
      });
    }
    if (d.views && typeof d.views === 'object') {
      Object.keys(state.views).forEach(function (k) {
        if (d.views[k]) state.views[k] = { img: d.views[k].img || '', status: d.views[k].status || '' };
      });
    }
    if (d.cands && typeof d.cands === 'object') state.cands = d.cands;
  }

  /* 存根 → 可显示的 dataURL / URL */
  function resolveImg(s) {
    if (!s) return '';
    if (typeof blobResolve === 'function') {
      try { return blobResolve(s, new WeakSet()); } catch (e) {}
    }
    return s;
  }

  /* ---------- 图片工具 ---------- */
  function shrink(dataURL, maxSide) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, (maxSide || 1600) / Math.max(w, h));
        if (scale >= 1) { res(dataURL); return; }
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        try { res(c.toDataURL('image/webp', 0.85)); } catch (e) { res(dataURL); }
      };
      img.onerror = function () { res(dataURL); };
      img.src = dataURL;
    });
  }

  function readAsDataURL(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }

  /* 远程图尽量转 dataURL（持久化更稳）；跨域拿不到就原样保留 URL */
  function toDataURL(url) {
    if (!url || url.indexOf('data:') === 0) return Promise.resolve(url);
    return apiFetch(url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    }).then(function (b) {
      return new Promise(function (res) {
        var fr = new FileReader();
        fr.onload = function () { res(fr.result); };
        fr.onerror = function () { res(url); };
        fr.readAsDataURL(b);
      });
    }).catch(function () { return url; });
  }

  /* ---------- 生图（云 API / Tripo 重绘） ---------- */
  function genImage(prompt, srcImg, onProgress) {
    if (confGet('genEngine') === 'tripo') {
      var src0 = resolveImg(srcImg);
      if (!src0) throw new Error('Tripo 重绘必须有输入图');
      var tModel = confGet('imgModel') || 'seedream_v5';
      return tripoUpload(src0).then(function (token) {
        if (onProgress) onProgress('上传完成，提交任务…');
        return tripoCall('/generation/image-to-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: tModel, input: token, prompt: prompt, size: '2K', output_format: 'png' })
        });
      }).then(function (task) {
        return tripoPoll(task.task_id, function (p) { if (onProgress) onProgress(p + '%'); });
      }).then(function (done) {
        var url = done.output && done.output.generated_image_url;
        if (!url) throw new Error('Tripo 任务完成但未返回图片');
        return toDataURL(url);
      });
    }
    if (typeof imgMode === 'function' && imgMode() === 'local') {
      return Promise.reject(new Error('角色工坊需要云生图或 Tripo（设置 → 生图引擎）；本地 ComfyUI 无图生图编辑链路'));
    }
    var base = (confGet('imgBaseUrl') || confGet('llmBaseUrl') || '').replace(/\/$/, '');
    var model = confGet('imgModel') || confGet('llmModel');
    var key = confGet('imgKey') || confGet('llmKey');
    var endpoint = confGet('imgEndpoint');
    var size = confGet('imgSize') || '1024x1024';
    if (!base || !model || !key) {
      return Promise.reject(new Error('请先在设置里填写生图 Base URL / Model / API Key'));
    }
    var src = resolveImg(srcImg);
    var useImage = !!src && state.refSource !== false;
    var p;
    if (useImage && /edit/i.test(endpoint || '')) {
      /* OpenAI 兼容 /images/edits：必须 multipart/form-data（与工作台 generate() 同款） */
      p = fetch(base + endpoint, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key },
        body: (function () {
          var fd = new FormData();
          fd.append('model', model); fd.append('prompt', prompt); fd.append('size', size);
          var bin = atob(src.split(',')[1]);
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          fd.append('image', new Blob([arr], { type: 'image/png' }), 'source.png');
          return fd;
        })()
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ': 生成请求失败');
        return r.json();
      });
    } else {
      var body = { model: model, prompt: prompt, size: size };
      if (useImage) body.image = src.split(',')[1];
      p = post(base, key, endpoint, body);
    }
    return p.then(function (data) {
      var url = lookupPath(data, confGet('respPath') || 'data[0].url');
      if (!url) {
        var b64 = lookupPath(data, 'data[0].b64_json');
        if (b64) url = 'data:image/png;base64,' + b64;
      }
      if (!url) throw new Error('未找到图片地址（可在设置 → 高级里调整响应路径）');
      return toDataURL(url);
    });
  }

  /* ---------- Tripo 建模候选 ---------- */
  function genCandidate(srcImg, onProgress) {
    var src = resolveImg(srcImg);
    if (!src) return Promise.reject(new Error('缺少建模输入图'));
    var version = confGet('tripoVersion');
    if (!confGet('tripoKey')) return Promise.reject(new Error('请先在设置里填写 Tripo API Key'));
    return tripoUpload(src).then(function (token) {
      if (onProgress) onProgress('上传完成，提交建模任务…');
      return tripoCall('/generation/image-to-model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: version, input: token, texture: true, pbr: true })
      });
    }).then(function (task) {
      return tripoPoll(task.task_id, function (p) { if (onProgress) onProgress(p + '%'); });
    }).then(function (done) {
      var out = done.output || {};
      return {
        model: out.model_url || out.pbr_model || '',
        preview: out.rendered_image_url || '',
        credits: done.credits_consumed,
        version: version
      };
    });
  }

  /* ---------- 渲染 ---------- */
  var host = null, stageEl = null, railEl = null, footEl = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function render() {
    if (!host) return;
    renderRail();
    renderStage();
    renderFoot();
  }

  function stageDone(i) {
    if (i === 0) return !!state.src;
    if (i === 1) return !!(state.parts['head.front'] && state.parts['head.front'].img &&
                            state.parts['body.front'] && state.parts['body.front'].img);
    if (i === 2) return !!(state.views.front && state.views.front.img);
    if (i === 3) return (state.mode === 'full' ? state.pick.full >= 0 : state.pick.head >= 0 && state.pick.body >= 0);
    return true;
  }

  function renderRail() {
    var html = STAGES.map(function (s, i) {
      var cls = 'chara-step' + (i === state.stage ? ' cur' : '') + (stageDone(i) ? ' done' : '');
      return '<button type="button" class="' + cls + '" data-act="goto" data-i="' + i + '">' +
        '<span class="chara-step-dot"></span>' +
        '<span class="chara-step-txt"><b>' + (i + 1) + '. ' + esc(s.name) + '</b><i>' + esc(s.desc) + '</i></span>' +
        '</button>';
    }).join('');
    railEl.innerHTML = '<div class="chara-rail-t">制作流程</div>' + html +
      '<div class="chara-rail-foot">' +
      '<button type="button" class="btn sm ghost" data-act="reset">新建项目</button>' +
      (state.srcInfo ? '<div class="chara-projinfo">' + esc(state.srcInfo) + '</div>' : '') +
      '</div>';
  }

  function cellHTML(key, item, label, actKind) {
    var busyKey = actKind + ':' + key;
    var img = resolveImg(item.img);
    var isBusy = !!busy[busyKey];
    var body;
    if (isBusy) {
      body = '<div class="chara-cell-busy"><span class="chara-spin"></span><i>' + esc(item.status || '生成中…') + '</i></div>';
    } else if (img) {
      body = '<img src="' + esc(img) + '" alt="' + esc(label) + '" draggable="false">';
    } else {
      body = '<div class="chara-cell-empty">' + esc(item.status || '未生成') + '</div>';
    }
    return '<div class="chara-cell">' +
      '<div class="chara-cell-img">' + body + '</div>' +
      '<div class="chara-cell-bar"><span>' + esc(label) + '</span>' +
      '<button type="button" class="btn sm' + (img ? ' ghost' : '') + '" data-act="' + actKind + '" data-key="' + key + '"' +
      (isBusy ? ' disabled' : '') + '>' + (img ? '重生成' : '生成') + '</button></div>' +
      '</div>';
  }

  function renderStageSrc() {
    var img = resolveImg(state.src);
    return '<div class="chara-grid-2">' +
      '<div class="chara-drop' + (img ? ' has' : '') + '" data-act="dropzone">' +
      (img
        ? '<img src="' + esc(img) + '" alt="原画" draggable="false">'
        : '<div class="chara-drop-hint"><b>点击选择或拖入图片</b><i>PNG / JPEG / WebP，建议全身角色图</i></div>') +
      '</div>' +
      '<div class="chara-src-side">' +
      '<div class="chara-note"><b>开工前</b>' +
      '<ul><li>使用你有权使用的插画；输出模型的使用范围跟随原画授权。</li>' +
      '<li>全身、站姿、道具少，Tripo 的成功率最高。</li>' +
      '<li>图片会压缩到长边 1600 再使用，原图不会上传到任何服务。</li></ul></div>' +
      '<div class="chara-row">' +
      '<button type="button" class="btn sm" data-act="pick-src">选择图片</button>' +
      (img ? '<button type="button" class="btn sm ghost" data-act="clear-src">移除</button>' : '') +
      '</div>' +
      '<div class="chara-hint">生图走「设置 → 生图引擎」里的云 API；重绘也可以选 Tripo。</div>' +
      '</div>' +
      '</div>' +
      '<input type="file" id="charaSrcFile" accept="image/*" hidden>';
  }

  function renderStageParts() {
    var head = PARTS.filter(function (p) { return p.key.indexOf('head.') === 0; })
      .map(function (p) { return cellHTML(p.key, state.parts[p.key], p.label, 'gen-part'); }).join('');
    var body = PARTS.filter(function (p) { return p.key.indexOf('body.') === 0; })
      .map(function (p) { return cellHTML(p.key, state.parts[p.key], p.label, 'gen-part'); }).join('');
    return '<div class="chara-sec"><div class="chara-sec-t">头部（含发型）<span>喂给建模的头件参考</span>' +
      '<button type="button" class="btn sm ghost" data-act="gen-row" data-key="head">生成整排</button></div>' +
      '<div class="chara-grid-4">' + head + '</div></div>' +
      '<div class="chara-sec"><div class="chara-sec-t">身体（颈部以下）<span>喂给建模的身件参考</span>' +
      '<button type="button" class="btn sm ghost" data-act="gen-row" data-key="body">生成整排</button></div>' +
      '<div class="chara-grid-4">' + body + '</div></div>' +
      '<div class="chara-hint">提示词已按「参考图同款设计 + 纯色底 + 单部件」写死；建模最低要求头·正面与身·正面两张，其余可后补。</div>';
  }

  function renderStageViews() {
    var cells = VIEWS.map(function (v) { return cellHTML(v.key, state.views[v.key], v.label, 'gen-view'); }).join('');
    return '<div class="chara-sec"><div class="chara-sec-t">全身三视图<span>整体建模的主输入</span>' +
      '<button type="button" class="btn sm ghost" data-act="gen-row" data-key="views">生成整排</button></div>' +
      '<div class="chara-grid-3">' + cells + '</div></div>' +
      '<div class="chara-hint">三视图用于「整体建模」路线；走「头身分离」时只用部位图。</div>';
  }

  function srcPickList() {
    var opts = [];
    VIEWS.forEach(function (v) {
      if (state.views[v.key] && state.views[v.key].img) opts.push({ k: 'views.' + v.key, n: v.label });
    });
    PARTS.forEach(function (p) {
      if (state.parts[p.key] && state.parts[p.key].img) opts.push({ k: 'parts.' + p.key, n: p.label });
    });
    if (state.src) opts.push({ k: 'src', n: '原画' });
    return opts;
  }

  function candListHTML(kind) {
    var list = state.cands[kind] || [];
    if (!list.length) return '<div class="chara-cell-empty chara-cand-empty">还没有候选</div>';
    return '<div class="chara-cands">' + list.map(function (c, i) {
      var on = state.pick[kind] === i;
      return '<button type="button" class="chara-cand' + (on ? ' on' : '') + '" data-act="pick-cand" data-kind="' + kind + '" data-i="' + i + '">' +
        (c.preview ? '<img src="' + esc(c.preview) + '" alt="候选 ' + (i + 1) + '" draggable="false">' : '<div class="chara-cell-empty">无预览图</div>') +
        '<span class="chara-cand-tag">候选 ' + (i + 1) + (c.credits != null ? ' · ' + c.credits + ' 积分' : '') + '</span>' +
        '<span class="chara-cand-ver">' + esc(c.version || '') + '</span>' +
        (on ? '<b class="chara-cand-ok">已选</b>' : '') +
        '</button>';
    }).join('') + '</div>';
  }

  function renderStageModel() {
    var opts = srcPickList();
    var splitReady = !!(state.parts['head.front'] && state.parts['head.front'].img &&
                          state.parts['body.front'] && state.parts['body.front'].img);
    var modeFull = state.mode === 'full';
    var inputHtml;
    if (modeFull) {
      inputHtml = opts.length
        ? '<div class="chara-inputs">' + opts.map(function (o) {
            return '<label class="chara-radio"><input type="radio" name="chara-msrc" value="' + o.k + '"' +
              (state.modelSrc === o.k ? ' checked' : '') + '> ' + esc(o.n) + '</label>';
          }).join('') + '</div>'
        : '<div class="chara-cell-empty">前几阶段还没有图：先生成三视图或部位图</div>';
    } else {
      inputHtml = splitReady
        ? '<div class="chara-inputs"><label class="chara-radio"><input type="radio" checked disabled> 头·正面 + 身·正面（分别建模，后期拼装）</label></div>'
        : '<div class="chara-cell-empty">头身分离需要部位图的「头·正面」和「身·正面」</div>';
    }
    return '<div class="chara-sec"><div class="chara-sec-t">建模路线<span>整体 = 一个模型直接出；分离 = 头 / 身各建再拼</span></div>' +
      '<div class="chara-modes">' +
      '<button type="button" class="chara-mode' + (modeFull ? ' on' : '') + '" data-act="mode" data-v="full"><b>整体建模</b><i>用一张全身图，简单直接</i></button>' +
      '<button type="button" class="chara-mode' + (!modeFull ? ' on' : '') + '" data-act="mode" data-v="split"><b>头身分离</b><i>Tripo 对单部件效果更好，需要后期拼装</i></button>' +
      '</div></div>' +
      '<div class="chara-sec"><div class="chara-sec-t">输入图<span>' + (modeFull ? '选一张作为建模输入' : '固定使用两张部位正面图') + '</span></div>' +
      inputHtml + '</div>' +
      '<div class="chara-sec"><div class="chara-sec-t">候选' +
      '<label class="chara-candn">数量 <select id="charaCandN">' +
      [1, 2, 3].map(function (n) { return '<option value="' + n + '"' + (state.candN === n ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
      '</select></label>' +
      '<button type="button" class="btn sm" data-act="gen-cand"' + (candBusy.indexOf(state.mode) >= 0 ? ' disabled' : '') + '>' +
      (candBusy.indexOf(state.mode) >= 0 ? '生成中…' : '生成候选') + '</button></div>' +
      candListHTML(modeFull ? 'full' : 'head') +
      (!modeFull ? '<div class="chara-subt">身体候选</div>' + candListHTML('body') : '') +
      '<div class="chara-hint">候选由你挑选，软件不会替你做视觉判断；每次生成消耗 Tripo 积分。</div>';
  }

  function renderStageExport() {
    var modeFull = state.mode === 'full';
    var picked = [];
    if (modeFull && state.pick.full >= 0 && state.cands.full[state.pick.full]) {
      picked.push({ kind: '整体模型', c: state.cands.full[state.pick.full] });
    }
    if (!modeFull) {
      if (state.pick.head >= 0 && state.cands.head[state.pick.head]) picked.push({ kind: '头部', c: state.cands.head[state.pick.head] });
      if (state.pick.body >= 0 && state.cands.body[state.pick.body]) picked.push({ kind: '身体', c: state.cands.body[state.pick.body] });
    }
    var pickedHtml = picked.length
      ? picked.map(function (p) {
          return '<div class="chara-out-row"><b>' + esc(p.kind) + '</b>' +
            (p.c.model ? '<a class="btn sm" href="' + esc(p.c.model) + '" download="chara_model.glb">下载 GLB</a>' +
              '<button type="button" class="btn sm ghost" data-act="preview3d" data-url="' + esc(p.c.model) + '">3D 预览</button>' +
              '<button type="button" class="btn sm ghost" data-act="quad" data-url="' + esc(p.c.model) + '">导出四视图</button>'
              : '<span class="chara-hint">该候选缺少模型文件</span>') +
            '</div>';
        }).join('')
      : '<div class="chara-cell-empty">上一阶段还没挑选候选</div>';
    return '<div class="chara-sec"><div class="chara-sec-t">模型产物</div>' + pickedHtml + '</div>' +
      '<div class="chara-sec"><div class="chara-sec-t">制作包<span>所有中间图 + 选择记录，一键带走</span></div>' +
      '<div class="chara-row"><button type="button" class="btn sm" data-act="export-json">导出项目 JSON</button>' +
      '<button type="button" class="btn sm ghost" data-act="export-parts">打包部位图</button></div></div>' +
      '<div class="chara-note"><b>关于 VRM</b>' +
      '<ul><li>本项目导出 GLB 与制作包；VRM 的骨骼绑定、权重和弹簧物理需要 Blender + VRM 插件完成。</li>' +
      '<li>把制作包交给编码助手，按「权重传递 → 弹簧骨骼 → VRM 导出」的顺序可完成最后一步。</li></ul></div>';
  }

  var STAGE_RENDER = [renderStageSrc, renderStageParts, renderStageViews, renderStageModel, renderStageExport];

  function renderStage() {
    stageEl.innerHTML = STAGE_RENDER[state.stage]();
    var file = byId('charaSrcFile');
    if (file) file.addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importSrc(e.target.files[0]);
    });
    var sel = byId('charaCandN');
    if (sel) sel.addEventListener('change', function () { state.candN = sel.value | 0; save(); });
    var radios = stageEl.querySelectorAll('input[name="chara-msrc"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function () { state.modelSrc = this.value; save(); });
    }
  }

  function footReq() {
    if (state.stage === 0) return state.src ? '原画就绪' : '请先导入原画';
    if (state.stage === 1) return stageDone(1) ? '部位图最低要求已满足' : '至少生成 头·正面 与 身·正面';
    if (state.stage === 2) return stageDone(2) ? '三视图就绪' : '至少生成 正面 视图（走分离路线可跳过）';
    if (state.stage === 3) return stageDone(3) ? '已选定候选' : '请挑选一个候选';
    return '可随时导出';
  }

  function renderFoot() {
    var last = state.stage === STAGES.length - 1;
    footEl.innerHTML =
      '<span class="chara-foot-msg">' + esc(footMsg || footReq()) + '</span>' +
      '<div class="chara-foot-btns">' +
      (state.stage > 0 ? '<button type="button" class="btn sm ghost" data-act="back">上一阶段</button>' : '') +
      (!last ? '<button type="button" class="btn sm" data-act="next"' + (stageDone(state.stage) ? '' : ' disabled') + '>确认并继续 →</button>' : '') +
      '</div>';
  }

  /* ---------- 交互 ---------- */
  function importSrc(file) {
    if (!file || !/^image\//.test(file.type)) { footMsg = '请选择图片文件'; render(); return; }
    readAsDataURL(file).then(shrink).then(function (durl) {
      state.src = durl;
      state.srcName = file.name || '';
      state.srcInfo = file.name + ' · ' + Math.round(file.size / 1024) + ' KB';
      footMsg = '';
      save(); render();
    }).catch(function (e) { footMsg = '导入失败：' + e.message; render(); });
  }

  function setCell(kind, key, patch) {
    var bag = kind === 'part' ? state.parts : state.views;
    if (!bag[key]) bag[key] = blankPart();
    Object.keys(patch).forEach(function (k) { bag[key][k] = patch[k]; });
  }

  function genRow(group) {
    var items;
    if (group === 'views') items = VIEWS.map(function (v) { return ['view', v.key, 'gen-view']; });
    else items = PARTS.filter(function (p) { return p.key.indexOf(group + '.') === 0; })
      .map(function (p) { return ['part', p.key, 'gen-part']; });
    /* 整排串行生成：同时打 4 个请求容易触发限流，串行也方便逐张检查 */
    var chain = Promise.resolve();
    items.forEach(function (it) {
      chain = chain.then(function () { return genCellWait(it[0], it[1], it[2]); });
    });
  }

  function genCellWait(kind, key, actKind) {
    var busyKey = actKind + ':' + key;
    if (busy[busyKey]) return Promise.resolve();
    var bag = kind === 'part' ? state.parts : state.views;
    var item = bag[key];
    var prompt = null;
    PARTS.forEach(function (p) { if (p.key === key) prompt = p.prompt; });
    VIEWS.forEach(function (v) { if (v.key === key) prompt = v.prompt; });
    if (!prompt) return Promise.resolve();
    if (!state.src) { footMsg = '先在阶段 1 导入原画'; render(); return Promise.resolve(); }
    busy[busyKey] = true;
    setCell(kind, key, { status: '生成中…' });
    render();
    return genImage(prompt, state.src, function (msg) {
      setCell(kind, key, { status: typeof msg === 'number' ? '生成中 ' + msg : msg });
      render();
    }).then(function (durl) {
      return shrink(durl, 1280).then(function (small) {
        setCell(kind, key, { img: blobPack(small), status: '' });
      });
    }).catch(function (e) {
      setCell(kind, key, { status: '失败：' + (typeof friendlyErr === 'function' ? friendlyErr(e) : e.message) });
    }).then(function () {
      busy[busyKey] = false;
      save(); render();
    });
  }

  function genCandidates() {
    var kind = state.mode;                       // 'full' | 'split'
    if (candBusy.indexOf(kind) >= 0) return;
    var jobs = [];                               // [{ck, srcKey}]
    if (kind === 'full') {
      jobs.push({ ck: 'full', srcKey: state.modelSrc });
    } else {
      jobs.push({ ck: 'head', srcKey: 'parts.head.front' });
      jobs.push({ ck: 'body', srcKey: 'parts.body.front' });
    }
    /* 输入图检查 */
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      var img = j.srcKey === 'src' ? state.src : (j.srcKey.indexOf('views.') === 0 ? (state.views[j.srcKey.slice(6)] || {}).img : (state.parts[j.srcKey.slice(6)] || {}).img);
      if (!img) { footMsg = '缺少输入图：' + j.srcKey; render(); return; }
      j.src = img;
    }
    candBusy.push(kind);
    footMsg = '';
    render();

    var chain = Promise.resolve();
    jobs.forEach(function (j) {
      chain = chain.then(function () {
        var list = state.cands[j.ck] = state.cands[j.ck] || [];
        var n = state.candN;
        var seq = Promise.resolve();
        for (var i = 0; i < n; i++) {
          (function (idx) {
            seq = seq.then(function () {
              footMsg = '候选 ' + (idx + 1) + '/' + n + ' 建模中…';
              render();
              return genCandidate(j.src, function (m) {
                footMsg = '候选 ' + (idx + 1) + '/' + n + '：' + m;
                render();
              }).then(function (cand) {
                list.push(cand);
                if (state.pick[j.ck] < 0) state.pick[j.ck] = 0;
                save(); render();
              });
            });
          })(i);
        }
        return seq;
      });
    });
    chain.catch(function (e) {
      footMsg = '建模失败：' + (typeof friendlyErr === 'function' ? friendlyErr(e) : e.message);
    }).then(function () {
      candBusy = candBusy.filter(function (k) { return k !== kind; });
      if (!footMsg) footMsg = '候选生成完毕，请挑选';
      save(); render();
    });
  }

  function exportJSON() {
    var out = {
      kit: 'openagi-chara', v: 1,
      created: new Date().toISOString(),
      source: { name: state.srcName, info: state.srcInfo, image: resolveImg(state.src) },
      parts: {}, views: {}, mode: state.mode, picks: state.pick,
      models: state.cands
    };
    Object.keys(state.parts).forEach(function (k) {
      out.parts[k] = { image: resolveImg(state.parts[k].img) };
    });
    Object.keys(state.views).forEach(function (k) {
      out.views[k] = { image: resolveImg(state.views[k].img) };
    });
    var url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'chara-project.json'; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    footMsg = '项目 JSON 已导出';
    render();
  }

  function exportParts() {
    var imgs = [];
    Object.keys(state.parts).forEach(function (k) {
      var v = resolveImg(state.parts[k].img);
      if (v) imgs.push([k, v]);
    });
    Object.keys(state.views).forEach(function (k) {
      var v = resolveImg(state.views[k].img);
      if (v) imgs.push(['views.' + k, v]);
    });
    if (!imgs.length) { footMsg = '还没有可导出的图'; render(); return; }
    var seq = Promise.resolve();
    imgs.forEach(function (it) {
      seq = seq.then(function () {
        return new Promise(function (res) {
          var a = document.createElement('a');
          a.href = it[1];
          a.download = 'chara_' + it[0].replace('.', '_') + '.png';
          a.click();
          setTimeout(res, 350);   /* 连续下载给浏览器留间隔，防止被弹窗拦截吞掉 */
        });
      });
    });
    seq.then(function () { footMsg = '已导出 ' + imgs.length + ' 张图'; render(); });
  }

  function resetProject() {
    if (!window.confirm('新建项目会清空当前进度（原画、部位图、候选选择），确定？')) return;
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    state.stage = 0; state.src = ''; state.srcName = ''; state.srcInfo = '';
    PARTS.forEach(function (p) { state.parts[p.key] = blankPart(); });
    VIEWS.forEach(function (v) { state.views[v.key] = blankPart(); });
    state.mode = 'full'; state.modelSrc = 'views.front';
    state.cands = { full: [], head: [], body: [] };
    state.pick = { full: -1, head: -1, body: -1 };
    footMsg = '已新建项目';
    save(); render();
  }

  function onClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    if (act === 'goto') { state.stage = el.getAttribute('data-i') | 0; footMsg = ''; save(); render(); return; }
    if (act === 'next') { if (stageDone(state.stage)) { state.stage++; footMsg = ''; save(); render(); } return; }
    if (act === 'back') { if (state.stage > 0) { state.stage--; footMsg = ''; save(); render(); } return; }
    if (act === 'reset') { resetProject(); return; }
    if (act === 'pick-src') { var f = byId('charaSrcFile'); if (f) f.click(); return; }
    if (act === 'clear-src') { state.src = ''; state.srcName = ''; state.srcInfo = ''; save(); render(); return; }
    if (act === 'dropzone') { var f2 = byId('charaSrcFile'); if (f2) f2.click(); return; }
    if (act === 'gen-part') { genCellWait('part', el.getAttribute('data-key'), 'gen-part'); return; }
    if (act === 'gen-view') { genCellWait('view', el.getAttribute('data-key'), 'gen-view'); return; }
    if (act === 'gen-row') { genRow(el.getAttribute('data-key')); return; }
    if (act === 'mode') {
      state.mode = el.getAttribute('data-v') === 'split' ? 'split' : 'full';
      save(); render(); return;
    }
    if (act === 'gen-cand') { genCandidates(); return; }
    if (act === 'pick-cand') {
      var kind = el.getAttribute('data-kind'), i = el.getAttribute('data-i') | 0;
      state.pick[kind] = i; footMsg = ''; save(); render(); return;
    }
    if (act === 'preview3d') {
      var url = el.getAttribute('data-url');
      if (window.Model3D && Model3D.ready()) {
        footMsg = '3D 预览已打开';
        Model3D.openPreview(url, { title: '角色模型预览' }).catch(function (e2) { footMsg = '预览失败：' + friendlyErr(e2); render(); });
      } else footMsg = '3D 组件未就绪';
      render(); return;
    }
    if (act === 'quad') {
      var qurl = el.getAttribute('data-url');
      if (!(window.Model3D && Model3D.ready())) { footMsg = '3D 组件未就绪'; render(); return; }
      el.disabled = true;
      Model3D.quadViews(qurl, { size: 2048, mode: 'line' }).then(function (u) {
        var a = document.createElement('a');
        a.href = u; a.download = 'chara_quad_views.png'; a.click();
        footMsg = '四视图已导出';
      }).catch(function (e2) { footMsg = '四视图失败：' + friendlyErr(e2); })
        .then(function () { render(); });
      return;
    }
    if (act === 'export-json') { exportJSON(); return; }
    if (act === 'export-parts') { exportParts(); return; }
  }

  /* ---------- 装配 ---------- */
  function open() {
    host = byId('charaHost');
    if (!host || host.dataset.ready === '1') return;
    host.dataset.ready = '1';
    if (typeof blobEnsure === 'function') { try { blobEnsure(); } catch (e) {} }
    load();
    host.innerHTML =
      '<div class="chara-layout">' +
      '<aside class="chara-rail" id="charaRail"></aside>' +
      '<section class="chara-main">' +
      '<header class="chara-head"><b>角色工坊</b><span>插画 → 部位图 → 三视图 → 3D 候选 → 导出</span></header>' +
      '<div class="chara-body" id="charaStage"></div>' +
      '<footer class="chara-foot" id="charaFoot"></footer>' +
      '</section></div>';
    railEl = byId('charaRail');
    stageEl = byId('charaStage');
    footEl = byId('charaFoot');
    host.addEventListener('click', onClick);
    /* 拖放导入 */
    host.addEventListener('dragover', function (e) { e.preventDefault(); });
    host.addEventListener('drop', function (e) {
      e.preventDefault();
      if (state.stage !== 0) return;
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importSrc(f);
    });
    render();
  }

  window.charaKit = { open: open };

  registerApp({
    id: 'chara',
    name: '角色工坊',
    title: '角色工坊',
    sub: '插画 → 部位图 → 3D 候选',
    glyph: 'chara',
    order: 15,
    cls: 'chara',
    win: 'charaWin',
    css: ['apps/chara/app.css'],
    body: '<div class="chara-host" id="charaHost"></div>',
    open: function () { open(); }
  });
})();

/* ---- apps/chat/app.js ---- */
/* AI 对话 —— 和其他 App 一样双击图标翻到 App 页，不再是独立的「第二页」。
 *
 * 原来它有一套自己的翻页规则（.desk-wall.chat-open + .desk-page-2），
 * 返回按钮、动效、页头全和别的 App 对不上 —— 统一成 App 之后全都同一套。
 *
 * ⚠ 底部那条输入 (#deskAiWrap) **不在这个 body 里**。它由 desk-chat-send.js 创建，
 *   按「窗口归属」在桌面底部 ↔ 对话窗口底部之间搬运（监听 openagi:app-mounted /
 *   app-restored）。所以别把输入条写进这里，否则会出现两条。
 */
(function () {
  'use strict';

  registerApp({
    id: 'chat',
    name: 'AI 对话',
    title: 'AI 对话',
    sub: '问点什么，或让它画一张',
    glyph: 'chat',
    order: 0,
    cls: 'chat',
    win: 'chatWin',
    body: `
        <!-- 模型 / 上下文 / 生图来源：原来是第二页页头的一排角标。
             页头删掉后，这三个角标留在对话区顶部——视觉上仍是一眼可扫的信息条。 -->
        <div class="dchat-meta">
          <span class="dchat-model" id="deskChatModel"></span>
          <span class="dchat-ctx" id="deskChatCtx" title="当前对话上下文"></span>
          <span class="dchat-imgsrc" id="deskChatImg" title="当前生图来源（点一下去设置）"></span>
        </div>
        <div class="dchat-log" id="deskChatLog"></div>
        <!-- 把这一轮探索压成流程的入口。只在「跑通了且有可固化步骤」时出现，
             不做弹窗强推 —— 它是筛选器，不是广告位。 -->
        <div class="dchat-saveflow hidden" id="deskChatSaveFlow">
          <span class="dcsf-text" id="deskChatSaveFlowText"></span>
          <button type="button" class="btn sm" id="btnChatSaveFlow">存成流程</button>
          <button type="button" class="dcsf-x" id="btnChatSaveFlowX" aria-label="这次不存" title="这次不存">×</button>
        </div>
        <div class="dchat-foot" id="deskChatFoot"></div>`,
    open: function () {
      if (typeof window.deskChat !== 'undefined' && typeof window.deskChat.open === 'function') window.deskChat.open();
    }
  });
})();

/* ---- apps/code/app.js ---- */
/* 编码 —— 工作台里唯一一个「改别处东西」的 App。
 *
 * 和别的 App 的根本区别是：它的作用对象在工作区里、不归应用所有，
 * 所以它的第一条设计约束是沙箱（见 electron/code-workspace.js），不是界面。
 *
 * 位置放名片之前：名片是收尾，不该有 App 排在它后面。
 * open() 返回 promise（等文件树真画出来），骨架会等它落定才撤。
 */
(function () {
  'use strict';

  registerApp({
    id: 'code',
    name: '编码',
    title: '编码',
    sub: '选定文件夹 · 浏览与改写代码',
    glyph: 'code',
    order: 12,
    cls: 'code',
    win: 'codeWin',
    body: '<div class="ca-app" id="codeApp"></div>',
    open: function () {
      if (typeof window.codeApp !== 'undefined' && typeof window.codeApp.open === 'function') return window.codeApp.open();
    }
  });
})();

/* ---- apps/comfy/app.js ---- */
/* 本地生图 —— ComfyUI 引擎。
 *
 * 单独成 App 而不是塞进模型控制台的小方块：它自带安装 / 启动 / 端口 / 网页界面，
 * 塞进控制台里用户既不知道点哪里也看不清状态。装生图模型前先把它跑起来是最自然的顺序。
 *
 * body 里的 #cfApp 是宿主节点，界面由 js/comfy-app.js 铺开。
 */
(function () {
  'use strict';

  registerApp({
    id: 'comfy',
    name: '本地生图',
    title: '本地生图',
    /* 标签要短（切换条上塞不下「本地生图 · ComfyUI」），窗口标题栏保留完整名字 */
    barTitle: '本地生图 · ComfyUI',
    sub: 'ComfyUI 引擎',
    glyph: 'comfy',
    order: 4,
    cls: 'comfy',
    win: 'comfyWin',
    /* ComfyUI 本身就是一个网页界面（8188）。这里把它内嵌进窗口：
     * 顶部状态条管引擎的启动 / 停止 / 重载，下面直接显示工作流画布，
     * 不用每次再去系统浏览器单开一个标签页。 */
    css: ['apps/comfy/app.css'],
    body: '<div class="cf-app" id="cfApp"></div>',
    open: function () {
      if (typeof openComfyApp === 'function') openComfyApp();
    }
  });
})();

/* ---- apps/gallery/app.js ---- */
/* 图库 / 模型库 —— 两个入口共用一个窗口 #libWin。
 *
 * 为什么合在一个文件：它们的窗口是同一个，只是 `openLibrary(mode)` 传的 mode 不同
 * （image → 生成结果与素材，model → 本机模型文件）。拆成两个目录就会出现
 * 「窗口 body 在两处各写一份、谁先加载谁说了算」的隐式顺序依赖，比放一起更脆。
 * 目录名取主入口 gallery，tools/app-scan.js 校验的是「目录名在注册的 id 里」。
 *
 * body 里的 #libBody 是模块的宿主节点 —— js/library.js 会整块接管它。
 */
(function () {
  'use strict';

  const BODY = '<div class="lib-body" id="libBody"></div>';

  registerApp({
    id: 'gallery',
    name: '图库',
    title: '图库',
    sub: '生成结果与素材',
    glyph: 'gallery',
    order: 5,
    cls: 'lib',
    win: 'libWin',
    body: BODY,
    open: function () {
      if (typeof openLibrary === 'function') openLibrary('image');
    }
  });

  /* 第二个注册时 #libWin 已经存在，registerApp 会复用它、不再写 body ——
     所以这里不重复声明 body（写了也不会生效，纯噪音）。 */
  registerApp({
    id: 'modelLib',
    name: '模型库',
    title: '模型库',
    sub: '本机模型文件',
    glyph: 'modelLib',
    order: 6,
    win: 'libWin',
    open: function () {
      if (typeof openLibrary === 'function') openLibrary('model');
    }
  });
})();

/* ---- apps/hello/app.js ---- */
/* 模板 App：你好
 *
 * 复制这个目录改名就是新 App 的全部工作：
 *   1. 改 id / name / title（id 必须全项目唯一，它是标签和注册表的键）
 *   2. 改 mount() 里的界面
 *   3. 跑一次 node tools/app-scan.js 生成清单
 * index.html、desk-shell.js 一行都不用碰。
 *
 * ⚠ 三条最容易踩的（都不是语法问题，是「看着能跑但会坏」的那种）：
 * ① 整个文件包在 IIFE 里。不然这里的顶层函数会挂到那个 1165 个名字共享的 window 作用域上，
 *    和别的 App 撞名时 git 不报错、运行时时静默覆盖（用 node tools/ns-guard.js 能查出来）。
 * ② mount() 必须幂等。openDeskApp 每次翻到这个 App 都会调 open() → mount()，
 *    不是只调第一次。直接重建 innerHTML 会把用户刚输入的、刚滚动到的位置全冲掉。
 *    判据用 body.dataset.ready，画过一次就只做「刷新」不做「重建」。
 * ③ 不许写盘、不许碰 window.openagiDesktop。第三方的 App 将来会跑在同一个渲染进程里，
 *    这条线现在靠自觉，以后再收紧到能力白名单。
 */
(function () {
  'use strict';

  let openCount = 0;

  function stat(text) {
    const lines = text.length ? text.split('\n').length : 0;
    return { chars: text.length, lines: lines };
  }

  function render(body) {
    const ta = body.querySelector('.hello-in');
    const out = body.querySelector('.hello-out');
    const meta = body.querySelector('.hello-meta');
    const text = ta.value;

    /* 演示「一次能力调用」的位置：真正接 AI 时这里换成 llmConn() + 流式写 out */
    out.textContent = text ? text.split('').reverse().join('') : '（上面输入点什么）';

    const s = stat(text);
    meta.textContent = s.chars + ' 字 · ' + s.lines + ' 行 · 本会话打开 ' + openCount + ' 次';
  }

  registerApp({
    id: 'hello',
    name: '你好',
    title: '你好 · 模板 App',
    sub: '新 App 的骨架，复制即用',
    icon: deskSvg('hello'),
    css: ['apps/hello/app.css'],

    mount: function (body) {
      openCount++;

      /* 已经画过：只刷新数据，不重建 DOM（否则用户输入和滚动位置全丢） */
      if (body.dataset.ready === '1') {
        render(body);
        return;
      }

      body.innerHTML =
        '<div class="hello-wrap">' +
          '<div class="hello-head">' +
            '<div class="hello-h">你好</div>' +
            '<div class="hello-p">这是一个模板 App：窗口、样式、脚本、图标全由它自己声明，index.html 里没有它的任何代码。</div>' +
          '</div>' +
          '<textarea class="hello-in" spellcheck="false" placeholder="在这里输入，右边会把它倒过来。"></textarea>' +
          '<div class="hello-out" aria-live="polite"></div>' +
          '<div class="hello-foot">' +
            '<span class="hello-meta"></span>' +
            '<button type="button" class="hello-btn">清空</button>' +
          '</div>' +
        '</div>';

      const ta = body.querySelector('.hello-in');
      ta.addEventListener('input', () => render(body));
      body.querySelector('.hello-btn').addEventListener('click', () => { ta.value = ''; render(body); ta.focus(); });

      body.dataset.ready = '1';
      render(body);
      setTimeout(() => ta.focus(), 60);
    }
  });
})();

/* ---- apps/imglab/app.js ---- */
/* 图像工坊 —— 对标 Photoshop 的多图层图像工作站。
 *
 * 图库负责收，它负责改：多图层、选区、滤镜和大尺寸瓦片渲染。
 * 和上一代只做快速修正的图片编辑器（#imgEditWin，那个是弹窗不是 App）分工不同。
 *
 * body 里只有 #psHost 一个宿主，界面与像素逻辑由 js/ps-app.js / ps-core.js 铺开。
 */
(function () {
  'use strict';

  registerApp({
    id: 'imglab',
    name: '图像工坊',
    title: '图像工坊',
    sub: '图层 · 选区 · 滤镜 · 瓦片大图',
    glyph: 'ps',
    order: 7,
    cls: 'imglab',
    win: 'imgLabWin',
    body: '<div class="ps-host" id="psHost"></div>',
    open: function () {
      if (typeof window.psLab !== 'undefined' && typeof window.psLab.open === 'function') window.psLab.open();
    }
  });
})();

/* ---- apps/modeldesk/app.js ---- */
/* 建模 —— 网格资产工作站。摆在模型库旁边：一个是「造」，一个是「存」。
 *
 * MVP-1 用可编辑 face-vertex 网格；点线面工具随后续里程碑接入。
 * body 里只有 #modelDeskHost 一个宿主，整个三维工作台由 js/model-desk.js 铺开。
 *
 * ⚠ 这个 App 被切走时会主动 pause()（见 js/model-desk.js），这是它自己的生命周期决策，
 *   别在注册层替它改 —— 迁移只搬 DOM，不碰行为。
 */
(function () {
  'use strict';

  registerApp({
    id: 'modeldesk',
    name: '建模',
    title: '建模',
    sub: '网格资产工作站 · 变换 · 材质槽',
    glyph: 'modeler',
    order: 8,
    cls: 'modeldesk',
    win: 'modelDeskWin',
    body: '<div id="modelDeskHost" class="md-host"></div>',
    open: function () {
      if (typeof window.modelDesk !== 'undefined' && typeof window.modelDesk.open === 'function') window.modelDesk.open();
    }
  });
})();

/* ---- apps/models/app.js ---- */
/* 模型 —— 引擎与 Provider 的控制台。
 *
 * 它和别的 App 有一处不同：`open()` 里**自己再调一次 deskMountApp**。
 * 这不是多余的 —— models 这个入口原来就绕过了 openDeskApp 的通用路径
 * （见 desk-shell.js 里那句 `deskMountApp($('modelsWin'), m.title, m.sub)`），
 * 因为它要保证「先切页面，再渲染控制台」，而 renderModelsConsole 会重画整棵树。
 * 迁移时原样保留这条，否则会出现「翻过去了但内容还是上一轮的状态」。
 *
 * 四个宿主节点：硬件 / 引擎 / ComfyUI / 模型种类。
 */
(function () {
  'use strict';

  registerApp({
    id: 'models',
    name: '模型',
    title: '模型',
    barTitle: '模型控制台',
    sub: '引擎与 Provider',
    glyph: 'model',
    order: 10,
    win: 'modelsWin',
    body:
      '<div class="mc-hard" id="mcHard"></div>' +
      '<div class="mc-eng" id="mcEng"></div>' +
      '<div class="mc-eng" id="mcComfy"></div>' +
      '<div class="mc-kinds" id="mcKinds"></div>',
    open: function (win) {
      /* 用传进来的 win，不再按 id 反查 —— 少一次 getElementById，也避免名字改了两处不一致 */
      deskMountApp(win, '模型', '引擎与 Provider');
      if (typeof renderModelsConsole === 'function') renderModelsConsole();
    }
  });
})();

/* ---- apps/multiview/body.js ---- */
/* 视图工坊（多视图）的窗口 DOM —— 桌面 App 与独立页 multiview.html **共用这一份**。
 *
 * 为什么单独放一个文件：这个 App 是唯一同时有独立页的（multiview.html，双击就能用、
 * 不需要桌面）。以前 index.html 和 multiview.html 里各抄了一份 .mv-wrap（209 / 220 行、
 * 96 个 id），改一个控件要改两处，漏一处就是「桌面能用、独立页少个按钮」。
 * 现在两边都从这里取，**只有一份**。
 *
 * ⚠ 两份原来只差空态的两句文案（独立页写「点左上「＋ 文件」」，但那个按钮其实在左侧栏里，
 *   文案是错的）。统一成桌面版的说法：左边选一个 -> ＋ 文件 -> 拖进来，三种入口都覆盖到。
 *
 * ⚠ 桌面侧由 apps/multiview/app.js 的 registerApp() 取用（tools/app-scan.js 会把本文件
 *   先内联进 manifest）；独立页自己 <script src="apps/multiview/body.js"> 再赋给宿主。
 *   所以这里**只定义常量，不调 registerApp** —— 独立页没有那个函数。
 *
 * 全篇没有反引号 / ${ / 反斜杠（生成时校验过），所以能直接放进模板字符串。
 */
window.MV_BODY = `
<div class="mv-wrap">

          <aside class="mv-side">
            <div class="mv-side-head">
              <span class="mv-side-t">模型</span>
              <button type="button" class="mv-mini" id="mvOpenFile" title="打开本机的 glb / gltf / obj">＋ 文件</button>
            </div>
            <div class="mv-list" id="mvList"></div>
            <div class="mv-side-foot">
              <button type="button" class="mv-mini wide" id="mvOpenLib">打开模型库</button>
            </div>
            <input type="file" id="mvFile" class="hidden" accept=".glb,.gltf,.obj">
          </aside>

          <section class="mv-main">
            <div class="mv-ctl">
              <div class="mv-row">
                <span class="mv-lab">视图</span>
                <div class="mv-chips" id="mvPresets"></div>
                <div class="mv-chips" id="mvViews"></div>
              </div>
              <div class="mv-row">
                <span class="mv-lab">模式</span>
                <div class="mv-seg" id="mvModes"></div>
                <span class="mv-lab">相机</span>
                <div class="mv-seg" id="mvCams"></div>
                <span class="mv-lab">画布</span>
                <div class="mv-seg" id="mvSizes"></div>
              </div>
            </div>

            <details class="mv-more" id="mvMore">
              <summary title="画布级参数：列数、间距、留白、线宽——它们不属于任何一层">画布</summary>
              <div class="mv-more-body">
                <div class="mv-field"><span>列数</span><div class="mv-seg" id="mvCols"></div></div>
                <div class="mv-field"><span>铺满</span><div class="mv-seg" id="mvCompacts"></div></div>
                <div class="mv-field"><span>间距</span><input type="range" id="mvGap" min="0" max="48" step="2"><b id="mvGapV">0</b></div>
                <div class="mv-field"><span>留白</span><input type="range" id="mvMargin" min="100" max="160" step="2"><b id="mvMarginV">108</b></div>
                <div class="mv-field"><span>线宽</span><input type="range" id="mvLineW" min="4" max="60" step="2"><b id="mvLineWV">14</b></div>
                <button type="button" class="mv-mini" id="mvReset" title="把画布与各层参数恢复默认（不动已载入的模型）">恢复默认参数</button>
              </div>
            </details>

            <div class="mv-stage-wrap" id="mvStageHost">
              <div class="mv-stage" id="mvStage">
                <div class="mv-stage-hud" id="mvStageHud">
                  <b id="mvHudName">未载入</b>
                  <i id="mvHudMeta">等待模型</i>
                </div>
                <div class="mv-empty" id="mvEmpty">
                  <div class="mv-empty-t">左边选一个模型，或拖一个 glb / obj 进来</div>
                  <div class="mv-empty-s">OBJ 的四边形面按原始拓扑画线框，不会出现三角化的对角线。</div>
                </div>
                <img id="mvOut" alt="多视图结果" draggable="false" class="hidden">
                <div class="mv-pick hidden" id="mvPick"></div>
              </div>
            </div>

            <div class="mv-bar">
              <span class="mv-info" id="mvInfo"></span>
              <button type="button" class="btn sm" id="mvPreview">3D 预览</button>
              <button type="button" class="btn sm" id="mvSplit" disabled>AI 拆件</button>
              <button type="button" class="btn sm" id="mvSaveLib">存入图库</button>
              <button type="button" class="btn sm" id="mvDlCell" disabled>下载这格</button>
              <button type="button" class="btn sm" id="mvDlAll" disabled>下载整图</button>
              <button type="button" class="btn sm primary" id="mvRender">重新渲染</button>
            </div>
          </section>

          <!-- 右：图层 / 导出 / 投射 三个工作面板。做成互斥页签，
               一列堆三块面板时导出按钮会被挤到滚动区外，专业工具不该这样。 -->
      <aside class="mv-right">
        <div class="mv-right-tabs" id="mvRightTabs" role="tablist">
          <button type="button" class="mv-rtab is-on" data-mv-tab="layers" role="tab" aria-selected="true">图层</button>
          <button type="button" class="mv-rtab" data-mv-tab="export" role="tab" aria-selected="false">导出</button>
          <button type="button" class="mv-rtab" data-mv-tab="proj" role="tab" aria-selected="false">投射</button>
        </div>
        <div class="mv-right-panes">

          <!-- ① 图层：上层盖下层的心理模型，与 PS 一致 -->
          <div class="mv-right-pane is-on" data-pane="layers">
            <div class="mv-layers">
              <div class="mv-ly-head">图层<span class="mv-ly-hint" title="点一行展开它自己的属性面板；拖动可以任意换序，3D 和 2D 之间也能互换">点行调属性 · 随便拖</span></div>
              <div class="mv-ly-list" id="mvLayerList"></div>
            </div>
            <!-- 图层的眼睛驱动这些 input；留在这里是为了「state 只有一条写入口」 -->
            <div class="mv-hidden-checks">
      <input type="checkbox" id="mvWire">
      <input type="checkbox" id="mvAngleWire">
      <input type="checkbox" id="mvUvEdge">
      <input type="checkbox" id="mvUvIsland">
      <input type="checkbox" id="mvOutline">
      <input type="checkbox" id="mvDepthEdge">
      <input type="checkbox" id="mvDepthGray">
      <input type="checkbox" id="mvLabels">
      <input type="checkbox" id="mvBg">
      <input type="checkbox" id="mvGrade">
            </div>
            <!-- 层参数的控件都住在这里，被选中/展开的那一层才搬进它自己的面板。
                 不另建一套 input：id 仍是 FIELDS 认的那一个，写入口只有一条。 -->
            <div class="mv-prop-pool" id="mvPropPool">
          <div class="mv-field"><span>背景色</span><input type="color" id="mvBgColor" value="#ffffff"></div>
          <div class="mv-field"><span>折角</span><input type="range" id="mvWireAngle" min="0" max="90" step="1"><b id="mvWireAngleV">30°</b></div>
          <div class="mv-field" title="角度线框的整体粗细（相对「线宽」的倍率）。只想让结构线更醒目、又不想把普通线框一起加粗时用它"><span>角度粗细</span><input type="range" id="mvCreaseWidth" min="20" max="300" step="10"><b id="mvCreaseWidthV">1.0×</b></div>
          <div class="mv-field" title="随折角的粗细梯度：0% 所有结构线等宽；100% 折得越狠越粗（90° 硬边最粗，刚过阈值的平缓边约 1/4 宽）"><span>随角度</span><input type="range" id="mvCreaseTaper" min="0" max="100" step="5"><b id="mvCreaseTaperV">50%</b></div>
          <div class="mv-field" title="角度线框的颜色：换个颜色才分得清「哪几条是结构线、哪几条是普通线框」"><span>角度线色</span><input type="color" id="mvCreaseColor" value="#2b2b2b"></div>
          <div class="mv-field" title="相邻像素的深度差阈值（占整个视锥深度的百分比）：往左描得更多，往右只留最强的边。分辨率变了会自动补偿，换单格尺寸不用重调"><span>深度差</span><input type="range" id="mvDepthThresh" min="0" max="100" step="1"><b id="mvDepthThreshV">1.1%</b></div>
          <div class="mv-field" title="深度灰的映射窗口：100% 用模型完整的前后跨度，调小只保留靠近相机的一段（远处压成黑）。模型前后差得小、灰图看不出一层一层时，把它调小"><span>深度范围</span><input type="range" id="mvDepthGrayRange" min="10" max="100" step="5"><b id="mvDepthGrayRangeV">100%</b></div>
          <div class="mv-field" title="「无限远」的颜色：背景（没有表面）和格间距都填它。默认黑，跟「近白远黑」接得上；改成白就得到反过来的那一版（近黑远白）"><span>远景色</span><input type="color" id="mvDepthGrayBg" value="#000000"></div>
          <div class="mv-field" title="饱和度：0 是黑白，100% 是原样，200% 是色彩更艳。后期处理层调的是最终输出图像"><span>饱和度</span><input type="range" id="mvGradeSat" min="0" max="200" step="5"><b id="mvGradeSatV">100%</b></div>
          <div class="mv-field" title="对比度：100% 是原样，往上更硬朗、往下更灰雾"><span>对比度</span><input type="range" id="mvGradeContrast" min="0" max="200" step="5"><b id="mvGradeContrastV">100%</b></div>
          <div class="mv-field" title="亮度：正值提亮、负值压暗，范围 ±100"><span>亮度</span><input type="range" id="mvGradeBright" min="-100" max="100" step="5"><b id="mvGradeBrightV">0</b></div>
            </div>
          </div>

          <!-- ② 导出：画布固定正方形 2K/4K，深度 / 遮罩供 AI 回流 -->
          <div class="mv-right-pane hidden" data-pane="export">
            <aside class="mv-export">
              <div class="mv-ex-head">导出</div>
              <div class="mv-ex-row">
                <select class="mv-sel" id="mvExSize" title="画布尺寸（正方形）· 预览与导出一致">
                  <option value="2048">2K · 2048</option>
                  <option value="4096">4K · 4096</option>
                </select>
                <select class="mv-sel" id="mvExGap" title="格间距">
                  <option value="0">无间距</option>
                  <option value="16">16 px</option>
                  <option value="32">32 px</option>
                  <option value="64">64 px</option>
                </select>
              </div>
              <div class="mv-ex-info" id="mvExInfo"></div>
              <div class="mv-ex-stats" id="mvExStats"></div>
              <!-- 导出反馈：忙碌时黄点+扫光进度，成功绿点，失败红点，结果留到下一次导出 -->
              <div class="mv-ex-status hidden" id="mvExStatus"><i></i><span id="mvExStatusTxt"></span></div>
              <button type="button" class="btn sm primary" id="mvExPreview" disabled>预览导出结果</button>
              <button type="button" class="btn sm" id="mvExColor" disabled>导出视图 PNG</button>
              <button type="button" class="btn sm" id="mvExDepth" disabled>导出深度图</button>
              <button type="button" class="btn sm" id="mvExMask" disabled>导出遮罩图</button>
            </aside>
          </div>

          <!-- ③ 投射：生图 → UV 贴图。参数常驻在这里，重新投射不必重选文件 -->
          <div class="mv-right-pane hidden" data-pane="proj">
            <aside class="mv-export mv-proj-entry">
              <div class="mv-ex-head">投射纹理</div>
              <div class="mv-ex-info">AI 生成的网格图逐格反投回模型，按 UV 岛归类采样，烘成一张贴图</div>
              <div class="mv-ex-row">
                <select class="mv-sel" id="mvProjSize" title="贴图分辨率（UV 空间）">
                  <option value="1024">1K · 1024</option>
                  <option value="2048" selected>2K · 2048</option>
                  <option value="4096">4K · 4096</option>
                </select>
                <button type="button" class="btn sm primary" id="mvProj" disabled title="选一张 AI 生成的网格图（或直接 Ctrl+V 粘贴截图）">导入生图投射</button>
                <button type="button" class="btn sm" id="mvProjReproj" disabled title="用上次导入的图按当前参数重新烘一次">重新投射上次的图</button>
              </div>
              <input type="file" id="mvProjFile" class="hidden" accept="image/*">
              <div class="mv-ex-head">投射参数</div>
              <div class="mv-proj-set">
                <div class="mv-field" title="岛的边界往内缩多少 texel：躲开 AI 重绘造成的轮廓漂移。0 = 完全贴边，边缘更容易串色"><span>边缘内缩</span><input type="range" id="mvProjInset" min="0" max="4" step="1"><b id="mvProjInsetV">1 px</b></div>
                <div class="mv-field" title="次优视图补角的触发门槛（占最佳视图暴露面积的比例）。0 = 只从最佳视图采样；调高 = 少补、边缘更硬"><span>补角阈值</span><input type="range" id="mvProjFill" min="0" max="60" step="5"><b id="mvProjFillV">15%</b></div>
                <div class="mv-field" title="把岛边缘的颜色向外扩散几个 texel，抵消实时渲染的接缝。0 = 严格保持透明边界"><span>接缝扩散</span><input type="range" id="mvProjBleed" min="0" max="8" step="1"><b id="mvProjBleedV">0 px</b></div>
                <label class="mv-check mv-proj-check" title="有些模型的 UV V 轴与导出图相反：贴图上下颠倒时勾上它"><input type="checkbox" id="mvProjFlipV"> V 轴翻转</label>
              </div>
              <div class="mv-ex-info" id="mvProjQuick">选一张与当前导出布局对齐的生图</div>
            </aside>
          </div>

        </div>
      </aside>

          <!-- AI 拆件弹层：遮住整个 .mv-wrap。里面的控件 id 与 multiview.html 必须完全一致 -->
          <div class="mv-split hidden" id="mvSplitPanel">
            <div class="mv-split-card">
              <div class="mv-split-head">
                <span class="mv-split-title">AI 拆件</span>
                <span class="mv-split-sub" id="mvSplitSub"></span>
                <button type="button" class="mv-split-x" id="mvSplitClose" aria-label="关闭">×</button>
              </div>
              <div class="mv-split-body">
                <div class="mv-split-row">
                  <span class="mv-split-lab">分成</span>
                  <input type="text" id="mvSplitParts" class="mv-split-in" placeholder="面部和脖子、头发和头饰、身体">
                  <span class="mv-split-lab">候选岛</span>
                  <input type="range" id="mvSplitMax" min="20" max="240" step="10" value="120">
                  <b id="mvSplitMaxV">120</b>
                  <button type="button" class="btn sm primary" id="mvSplitRun">开始拆件</button>
                </div>
                <div class="mv-split-note" id="mvSplitInfo"></div>
                <div class="mv-split-imgs">
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">候选 UV 岛（编号给 AI 寻址）</span>
                    <img id="mvSplitAtlas" alt="候选 UV 岛图" class="hidden">
                  </div>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">拆件结果（颜色对应部件）</span>
                    <img id="mvSplitViews" alt="拆件结果预览" class="hidden">
                  </div>
                </div>
                <div class="mv-split-list" id="mvSplitList"></div>
                <div class="mv-split-foot">
                  <button type="button" class="btn sm" id="mvSplitDlGlb" disabled>下载整件 GLB</button>
                  <button type="button" class="btn sm" id="mvSplitSaveLib" disabled>存入模型库</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 投射纹理弹层：遮住整个 .mv-wrap。里面的控件 id 与 multiview.html 必须完全一致 -->
          <div class="mv-split hidden" id="mvProjPanel">
            <div class="mv-split-card">
              <div class="mv-split-head">
                <span class="mv-split-title">投射纹理</span>
                <span class="mv-split-sub" id="mvProjSub"></span>
                <button type="button" class="mv-split-x" id="mvProjClose" aria-label="关闭">×</button>
              </div>
              <div class="mv-split-body">
                <div class="mv-proj-body">
                  <aside class="mv-proj-side">
                    <span class="mv-split-cap">生图源</span>
                    <div class="mv-proj-src" id="mvProjSrcBox">
                      <img id="mvProjSrc" alt="生图源">
                      <em id="mvProjSrcEmpty">还没有导入</em>
                    </div>
                    <div class="mv-proj-stat" id="mvProjStats"></div>
                    <div class="mv-proj-tip">参数在右侧「投射」页调整<br>改完点「重新投射」即可复烘</div>
                  </aside>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">UV 贴图（透明 = 未投射的区域）</span>
                    <img id="mvProjOut" alt="投射纹理结果" class="hidden">
                  </div>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">上色预览（材质模式 · 自动生成）</span>
                    <img id="mvProjPrev" alt="投射上色预览" class="hidden">
                  </div>
                </div>
                <div class="mv-split-note" id="mvProjInfo"></div>
                <div class="mv-ex-status hidden" id="mvProjStatus"><i></i><span id="mvProjStatusTxt"></span></div>
                <div class="mv-proj-prog hidden" id="mvProjProg">
                  <i id="mvProjProgBar"></i>
                  <span id="mvProjProgTxt">投射中…</span>
                </div>
                <div class="mv-split-foot">
                  <button type="button" class="btn sm primary" id="mvProjDl" disabled>下载贴图 PNG</button>
                  <button type="button" class="btn sm" id="mvProjGlb" disabled>下载上色 GLB</button>
                  <button type="button" class="btn sm" id="mvProjLib" disabled>存入图库</button>
                  <button type="button" class="btn sm" data-mv-proj-reproj disabled title="按右侧「投射」页的当前参数重新烘一次">重新投射</button>
                </div>
              </div>
            </div>
          </div>
          </div>
`;

/* ---- apps/multiview/app.js ---- */
/* 视图工坊 —— 模型多视图出图 / 深度遮罩 / 贴图回投。
 *
 * 它同时是**桌面 App** 和**独立工具页**（multiview.html，双击就能用、不需要桌面）。
 * 所以它的窗口 DOM 单独放在 apps/multiview/body.js 里，两边共用同一份 ——
 * 以前是两份拷贝（209 + 220 行、96 个 id），改一个控件要改两处。
 *
 * 窗口本身仍由 registerApp 生成（os-win-bar 在 App 页是隐藏的），
 * body 直接取 window.MV_BODY。tools/app-scan.js 会把 body.js 先内联进 manifest，
 * 所以这里执行时它一定已经定义好了。
 */
(function () {
  'use strict';

  registerApp({
    id: 'multiview',
    name: '视图工坊',
    title: '视图工坊',
    sub: '多视图出图 · 深度遮罩 · 贴图回投',
    glyph: 'mv',
    order: 11,
    cls: 'mv',
    win: 'mvWin',
    body: window.MV_BODY,
    open: function () {
      if (typeof window.multiview !== 'undefined' && typeof window.multiview.open === 'function') window.multiview.open();
    }
  });
})();

/* ---- apps/player/app.js ---- */
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

/* ---- apps/store/app.js ---- */
/* 模型商店 —— 用 Ollama 的羊驼头做图标。
 *
 * 那张 png 是「本地模型」这件事的通用符号，比再画一个抽象图标更容易一眼认出来，
 * 所以这里用 icon（整段 HTML）而不是 glyph（内置 SVG 图形）。
 *
 * body 里的 #mcStore 是宿主节点，卡片由 js/model-store.js 渲染。
 */
(function () {
  'use strict';

  registerApp({
    id: 'store',
    name: '模型商店',
    title: '模型商店',
    sub: '安装 / 删除本地模型',
    icon: '<img class="desk-app-img" src="vendor/ollama-llama.png" alt="" draggable="false">',
    order: 3,
    cls: 'store',
    win: 'storeWin',
    body: '<div class="mc-store" id="mcStore"></div>',
    open: function () {
      if (typeof openModelStore === 'function') openModelStore();
    }
  });
})();
