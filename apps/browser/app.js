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
