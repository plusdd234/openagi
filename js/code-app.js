/* 编码 App：文件树 + 编辑器 + 搜索（只读浏览 → 单文件改写的第一步）
 *
 * 定位：这是「编写代码能力」的**链路验证版**，不是完整 IDE。
 *   跑通四件事就够：选文件夹 → 展开树 → 打开文件 → 改完保存。
 *   语法高亮 / 多标签 / diff / Agent 面板都是后面挂上去的，不在这版。
 *
 * 四条约束（都是这个能力真正会踩的地方）：
 *
 *   ① **写盘必须带回读时的哈希。** 主进程拿它做乐观锁，文件在编辑期间被外部工具
 *      （git checkout / 格式化 / 另一个编辑器）改过就拒绝保存。这时候自动合并是错的，
 *      人必须重新看一眼 —— 所以这里只把原话转给用户，不做任何自作主张的处理。
 *
 *   ② **行号靠 wrap="off" 才准。** textarea 一旦自动换行，一个逻辑行会占多个视觉行，
 *      行号立刻错位。所以宁可让它横向滚动，也不开 wrap。
 *
 *   ③ **树按需展开，不预加载。** node_modules 有几万个条目，一次递归能把界面卡死。
 *      heavy 目录（node_modules / .git / dist*）默认折叠，允许手动展开。
 *
 *   ④ **切文件前必须处理脏标记。** 这是编辑器最基础的良心：改完没保存就切走，
 *      等于让用户白干。用同步 confirm 而不是自定义弹层 —— 这个场景下阻塞是对的。
 *
 * 依赖：window.openagiDesktop 的 code* 接口（electron/preload.js）。
 *       网页版没有这个能力，`open()` 会直接给出提示而不是假装能用。
 */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);

  const state = {
    root: '',            // 主进程给的绝对路径，这里**只用来显示**，不参与任何拼接
    name: '',
    ready: false,
    file: null,          // { rel, text, sha, dirty }
    expanded: new Set(), // 已展开的目录 rel
    kids: new Map(),     // 目录 rel → entries（缓存一层，重新展开不必再请求）
    mode: 'tree',        // tree | search
    built: false,
    /* 预览：独立于编辑器的一块状态。
     * errors 只留最近的、且去重 —— 一个循环里抛的错能刷出上千条，
     * 不去重的话面板会被同一条塞满，反而看不到别的问题。 */
    pv: { open: false, rel: '', errors: [], title: '', lastLoad: 0 }
  };

  function api(){ return global.openagiDesktop; }
  function hasDesktop(){ const d = api(); return !!(d && typeof d.codeInfo === 'function'); }

  /* 错误文案统一出口：主进程抛的是纯文本，这里只负责把「IPC 壳」剥掉。
   * 项目铁律是不允许 String(errObj)（会得到 [object Object]），所以显式取 message。 */
  function errText(e){
    if(!e) return '未知错误';
    const m = e.message || (e.error && e.error.message) || '';
    if(m) return String(m).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
    return '操作失败';
  }

  /* ---------------- 骨架（只建一次） ---------------- */

  function build(){
    if(state.built) return;
    const host = $('codeApp');
    if(!host) return;
    host.innerHTML = [
      '<div class="ca-bar">',
      '  <button type="button" class="ca-btn ca-pick" id="caPick">选择文件夹</button>',
      '  <span class="ca-root" id="caRoot">未选择</span>',
      '  <span class="ca-grow"></span>',
      '  <button type="button" class="ca-btn" id="caModeTree">文件</button>',
      '  <button type="button" class="ca-btn" id="caModeSearch">搜索</button>',
      '  <button type="button" class="ca-btn ca-tracebtn" id="caTraceBtn" title="本机任务轨迹与基线指标">轨迹</button>',
      '</div>',
      '<div class="ca-body" id="caBody">',
      '  <div class="ca-side">',
      '    <div class="ca-tree" id="caTree"></div>',
      '    <div class="ca-searchbox" id="caSearchBox" hidden>',
      '      <input type="text" class="ca-input" id="caSearchInput" placeholder="搜索工作区内容（回车）" spellcheck="false">',
      '      <div class="ca-hits" id="caHits"></div>',
      '    </div>',
      '  </div>',
      '  <div class="ca-main">',
      '    <div class="ca-tab">',
      '      <span class="ca-tab-name" id="caTabName">没有打开的文件</span>',
      '      <span class="ca-dirty" id="caDirty" hidden>未保存</span>',
      '      <span class="ca-grow"></span>',
      '      <button type="button" class="ca-btn ca-pvbtn" id="caPvBtn" title="用内置预览看这个页面的实际效果">预览</button>',
      '      <button type="button" class="ca-btn ca-save" id="caSave" disabled>保存</button>',
      '    </div>',
      '    <div class="ca-edit" id="caEdit">',
      '      <pre class="ca-gutter" id="caGutter" aria-hidden="true"></pre>',
      '      <textarea class="ca-ta" id="caTa" spellcheck="false" wrap="off" disabled></textarea>',
      '    </div>',
      '    <div class="ca-pv" id="caPv" hidden>',
      '      <div class="ca-pv-bar">',
      '        <span class="ca-pv-url" id="caPvUrl"></span>',
      '        <span class="ca-grow"></span>',
      '        <button type="button" class="ca-btn ca-pv-errbtn" id="caPvErrBtn" hidden>错误 0</button>',
      '        <button type="button" class="ca-btn" id="caPvReload">刷新</button>',
      '        <button type="button" class="ca-btn" id="caPvExt">用浏览器打开</button>',
      '        <button type="button" class="ca-btn" id="caPvClose">回到代码</button>',
      '      </div>',
      /* sandbox 里给 allow-same-origin 是必须的：不给的话 iframe 是 opaque origin，
       * 页面里任何 localStorage / cookie 访问都会直接抛 SecurityError，
       * 而真实项目几乎都会用到 —— 预览就变成"只能看静态图"。
       * 它的 origin 是 openagi-preview://ws，跟应用本身仍然隔离。
       * 不给 allow-top-navigation：预览页不能把主窗口导航走。 */
      '      <div class="ca-pv-stage">',
      '        <iframe class="ca-pv-frame" id="caPvFrame" title="工作区预览"',
      '          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock"></iframe>',
      '      </div>',
      '      <div class="ca-pv-list" id="caPvList" hidden></div>',
      '    </div>',
      '    <div class="ca-hint" id="caHint">选一个文件夹开始。双击文件名打开，Ctrl+S 保存。</div>',
      '  </div>',
      '</div>',
      '<!-- 轨迹看板：覆盖在主体上，不改变布局。默认隐藏。 -->',
      '<div class="ca-tracebox" id="caTraceBox" hidden></div>'
    ].join('');
    state.built = true;

    $('caPick').addEventListener('click', pickDir);
    $('caModeTree').addEventListener('click', () => setMode('tree'));
    $('caModeSearch').addEventListener('click', () => setMode('search'));
    $('caSearchInput').addEventListener('keydown', e => { if(e.key === 'Enter') runSearch(); });
    $('caSave').addEventListener('click', save);
    $('caPvBtn').addEventListener('click', () => openPreview());
    $('caPvReload').addEventListener('click', () => reloadPreview(true));
    $('caPvClose').addEventListener('click', closePreview);
    $('caPvExt').addEventListener('click', openInBrowser);
    $('caPvErrBtn').addEventListener('click', () => {
      const list = $('caPvList');
      if(!list) return;
      const show = list.hidden;
      list.hidden = !show;
      list.dataset.show = show ? '1' : '0';
    });
    /* 预览页通过 postMessage 把错误送出来（见 main.js 的 PREVIEW_HOOK）。
     * 监听挂在 window 上而不是 iframe 上：iframe 每次换 src 都是新的 document，
     * 绑在它上面会随着刷新一起丢掉。 */
    global.addEventListener('message', onPreviewMsg);
    $('caTraceBtn').addEventListener('click', () => toggleTrace());
    $('caTraceBox').addEventListener('click', onTraceClick);

    /* 关闭必须走 deskCloseWin：它是唯一知道"这个窗口现在挂在 App 页里"的地方，
     * 直接 classList.add('hidden') 会留下一页已经翻过去、内容却是空的宿主。 */
    const close = $('btnCodeWinClose');
    if(close) close.addEventListener('click', e => {
      e.stopPropagation();
      if(typeof deskCloseWin === 'function') deskCloseWin($('codeWin'));
    });

    /* 树用事件委托：展开刷新会重建整棵 DOM，逐节点绑监听会越绑越多。 */
    $('caTree').addEventListener('click', onTreeClick);
    $('caHits').addEventListener('click', onHitClick);

    const ta = $('caTa');
    ta.addEventListener('input', onEdit);
    ta.addEventListener('scroll', syncGutterScroll);
    ta.addEventListener('keydown', onEditorKey);

    /* 助手面板独立成一个模块自己建 DOM（日志、工具行、diff 卡片都在那边）。
     * 这里只交出去「工作区现在什么样」这几个回调 —— 让助手直接读 state 是错的，
     * 那样工作区状态会有两份，早晚出现"树里换了目录、助手还以为在旧的里面"。 */
    if(global.CodeAgent && typeof global.CodeAgent.mount === 'function'){
      global.CodeAgent.mount({
        host: $('caBody'),
        hooks: {
          hasWorkspace: () => state.ready,
          workspaceName: () => state.name || '',
          describeWorkspace: () => state.ready
            ? ('根目录「' + state.name + '」。所有工具路径都相对它，不要用绝对路径。')
            : '',
          currentFile: () => (state.file ? state.file.rel : ''),
          isDirty: () => isDirty(),
          openFile: rel => openFile(rel),
          afterWrite: (rel, text, sha) => {
            // 用户正看着这个文件 —— 必须立刻换成磁盘上的新内容，
            // 否则他手里是旧文本，再点保存就会把助手的改动盖掉
            const cur = state.file;
            if(cur && samePath(cur.rel, rel)){
              cur.text = text;
              cur.sha = sha;
              cur.dirty = false;
              renderEditor();
            }else if(!cur){
              /* 什么都没打开的时候，直接把被改的文件打开 —— 否则用户只看到
               * 一张 diff 卡片消失了，编辑器还是空白的，不知道到底改成了什么样。
               * 有别的文件开着就不抢焦点，那会打断他正在看的东西。 */
              openFile(rel);
            }
            hint('助手已应用改动：' + rel, 'ok');
            /* 预览开着就跟着刷新 —— 用户此刻的注意力在预览上，
             * 让他自己去点一下刷新是多一步无谓的操作。
             * 200ms 防抖：一次改动可能连着写好几个文件，不该刷三遍。 */
            if(state.pv.open && isPreviewable(state.pv.rel)){
              if(pvTimer) clearTimeout(pvTimer);
              pvTimer = setTimeout(() => { pvTimer = null; if(state.pv.open) reloadPreview(); }, 200);
            }
            return refreshTree();
          },
          /* 预览报的错误要能被助手看见，否则「改完还是白屏」它永远不知道为什么。
           * 给的是只读快照，助手那边不能反过来改这里的列表。 */
          previewErrors: () => state.pv.errors.map(x => x.text),
          /* 二进制落盘后走这里，不走 afterWrite —— afterWrite 会 openFile，
           * 而二进制 openFile 必然失败（codeRead 拒绝非文本），
           * 结果是「助手说放好了，界面却弹一个读不出来的错」。 */
          afterBinary: rel => {
            hint('助手已写入文件：' + rel, 'ok');
            if(state.pv.open && isPreviewable(state.pv.rel)) reloadPreview();
            return refreshTree();
          },
          /* 二进制没法在编辑器里看，所以点路径给的是「在文件夹里定位」，
           * 让人用系统的看图工具确认。 */
          revealFile: rel => {
            if(!hasDesktop()) return;
            try { Promise.resolve(api().codeReveal(rel)).catch(() => {}); } catch(e){}
          }
        }
      });
    }
  }

  function samePath(a, b){
    return String(a || '').replace(/\\/g, '/') === String(b || '').replace(/\\/g, '/');
  }

  /* ---------------- 工作区 ---------------- */

  function paintRoot(){
    const el = $('caRoot');
    if(!el) return;
    el.textContent = state.ready ? state.name : '未选择';
    el.title = state.root || '';
    el.classList.toggle('is-on', state.ready);
  }

  function pickDir(){
    if(!hasDesktop()){ hint('这个能力要在桌面版里用：网页版拿不到本地文件系统。'); return; }
    Promise.resolve(api().codePickDir()).then(info => {
      if(!info || !info.ready) return;          // 用户取消：什么都不做，别把已有工作区清掉
      state.root = info.root;
      state.name = info.name;
      state.ready = true;
      familyReset();
      paintRoot();
      hint('工作区：' + info.root);
      return reloadTree();
    }).catch(e => hint(errText(e)));
  }

  /* 换工作区时清掉所有"关于上一个目录"的状态。
   * 抽成函数而不是挂在 state 上：state 只该装数据，装函数会让"谁在改状态"更难追。 */
  function familyReset(){
    state.expanded.clear();
    state.kids.clear();
    state.file = null;
    /* 预览必须先关：它指向上一个工作区的路径，留着会把旧目录的内容
     * 显示在新工作区下面 —— 用户完全看不出这是两个目录的东西。 */
    if(state.pv.open) closePreview();
    state.pv.rel = '';
    state.pv.errors = [];
    renderEditor();
  }

  function reloadTree(){
    // 换工作区时把缓存和展开状态全清：旧的 rel 在新根下指向完全不同的东西
    state.kids.clear();
    state.expanded.clear();
    state.file = null;
    renderEditor();
    return loadDir('');
  }

  /* 只列一层。展开某个目录时才请求它自己。 */
  function loadDir(rel){
    if(!hasDesktop()) return Promise.resolve();
    return api().codeList(rel).then(res => {
      state.kids.set(rel || '', res.entries || []);
      if(rel) state.expanded.add(rel);
      renderTree();
    }).catch(e => hint(errText(e)));
  }

  /* 保留展开状态的重新拉取：助手写完文件要它（新建的文件要出现在树里）。
   * 不走 reloadTree —— 那个会清掉展开状态和打开的文件。 */
  function refreshTree(){
    if(!state.ready || !hasDesktop()) return Promise.resolve();
    const dirs = [''].concat(Array.from(state.expanded));
    /* 全部拉完再画一次。逐个 loadDir 会连着 renderTree 好几次，
     * 展开十几层的时候肉眼能看到闪。 */
    return Promise.all(dirs.map(d => api().codeList(d).then(res => {
      state.kids.set(d, res.entries || []);
      if(d) state.expanded.add(d);
    }).catch(() => {}))).then(() => renderTree());
  }

  /* 渲染整棵树：递归画已缓存的层。没缓存过的层不画 —— 这正是"按需加载"。 */
  function renderTree(){
    const box = $('caTree');
    if(!box) return;
    if(!state.ready){ box.innerHTML = '<div class="ca-empty">还没有选择工作区</div>'; return; }
    const rows = [];
    const cur = state.file ? state.file.rel : '';

    function walk(rel, depth){
      const kids = state.kids.get(rel || '');
      if(!kids) return;
      kids.forEach(k => {
        const childRel = rel ? rel + '/' + k.name : k.name;
        const isOpen = state.expanded.has(childRel);
        const cls = ['ca-row'];
        if(k.dir) cls.push('is-dir');
        if(k.heavy) cls.push('is-heavy');
        if(isOpen) cls.push('is-open');
        if(childRel === cur) cls.push('is-sel');
        rows.push(
          '<div class="' + cls.join(' ') + '" data-rel="' + esc(childRel) + '" data-dir="' + (k.dir ? '1' : '0') + '" style="padding-left:' + (8 + depth * 14) + 'px">' +
            '<span class="ca-caret">' + (k.dir ? (isOpen ? '▾' : '▸') : '') + '</span>' +
            '<span class="ca-name">' + esc(k.name) + '</span>' +
          '</div>'
        );
        if(k.dir && isOpen) walk(childRel, depth + 1);
      });
    }

    walk('', 0);
    box.innerHTML = rows.length ? rows.join('') : '<div class="ca-empty">这个目录是空的</div>';
  }

  function onTreeClick(e){
    const row = e.target.closest('.ca-row');
    if(!row) return;
    const rel = row.getAttribute('data-rel');
    const isDir = row.getAttribute('data-dir') === '1';
    if(isDir){
      if(state.expanded.has(rel)){ state.expanded.delete(rel); renderTree(); }
      else if(state.kids.has(rel)){ state.expanded.add(rel); renderTree(); }
      else loadDir(rel);
      return;
    }
    openFile(rel);
  }

  /* ---------------- 文件读写 ---------------- */

  function isDirty(){ return !!(state.file && state.file.dirty); }

  function openFile(rel){
    if(!hasDesktop()) return;
    if(state.file && state.file.rel === rel) return;
    // 脏标记：宁可多问一次，也不能让人白改
    if(isDirty() && !global.confirm('「' + state.file.rel + '」有未保存的改动，确定放弃？')) return;
    return api().codeRead(rel).then(f => {
      state.file = { rel: f.rel, text: f.text, sha: f.sha, dirty: false, eol: f.eol || '\n' };
      renderEditor();
      renderTree();
      hint(f.size + ' 字节 · ' + (f.eol === '\r\n' ? 'CRLF' : 'LF'));
    }).catch(e => hint(errText(e)));
  }

  function renderEditor(){
    const ta = $('caTa');
    const tab = $('caTabName');
    const save = $('caSave');
    const dirty = $('caDirty');
    const pvBtn = $('caPvBtn');
    if(!ta) return;
    const f = state.file;
    if(!f){
      ta.value = '';
      ta.disabled = true;
      tab.textContent = '没有打开的文件';
      save.disabled = true;
      dirty.hidden = true;
      // 没开文件也能预览：工作区根的 index.html 大概率就是他想看的东西
      if(pvBtn) pvBtn.disabled = false;
      renderGutter();
      return;
    }
    ta.value = f.text;
    ta.disabled = false;
    tab.textContent = f.rel;
    tab.title = f.rel;
    save.disabled = !f.dirty;
    dirty.hidden = !f.dirty;
    if(pvBtn) pvBtn.disabled = !isPreviewable(f.rel);
    ta.scrollTop = 0;
    ta.scrollLeft = 0;
    renderGutter();
    syncGutterScroll();
  }

  function onEdit(){
    if(!state.file) return;
    const f = state.file;
    const now = $('caTa').value;
    if(now === f.text) return;
    f.text = now;
    f.dirty = true;
    $('caDirty').hidden = false;
    $('caSave').disabled = false;
    renderGutter();
  }

  function save(){
    if(!state.file || !hasDesktop()) return;
    const f = state.file;
    $('caSave').disabled = true;
    return api().codeWrite({ rel: f.rel, text: f.text, expectSha: f.sha }).then(r => {
      // 用主进程回传的哈希续上：它才是磁盘上那份的真实指纹
      f.sha = r.sha;
      f.dirty = false;
      $('caDirty').hidden = true;
      $('caSave').disabled = true;
      hint((r.created ? '已创建 ' : '已保存 ') + r.rel + ' · ' + r.size + ' 字节');
    }).catch(e => {
      $('caSave').disabled = false;
      hint(errText(e) + '（改动还在编辑器里，不会丢）', 'err');
    });
  }

  function onEditorKey(e){
    if((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')){
      e.preventDefault();
      if(isDirty()) save();
      return;
    }
    // Tab 缩进：代码编辑器的基本预期。用 insertText 保住撤销栈，
    // 直接改 value 会让 Ctrl+Z 失效（整行都变成一次撤销）。
    if(e.key === 'Tab'){
      e.preventDefault();
      const ta = e.target;
      if(document.execCommand) document.execCommand('insertText', false, '  ');
      else {
        const s = ta.selectionStart;
        ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = s + 2;
        onEdit();
      }
    }
  }

  /* ---------------- 行号 ---------------- */

  function renderGutter(){
    const g = $('caGutter');
    const ta = $('caTa');
    if(!g || !ta) return;
    // 只按换行符切：wrap="off" 保证一个逻辑行就是一个视觉行，行号才和内容对齐
    const n = ta.value ? ta.value.split('\n').length : 1;
    const cap = Math.min(n, 20000);       // 超大文件不再逐个拼，退化成"行号只是装饰"
    let s = '';
    for(let i = 1; i <= cap; i++) s += i + '\n';
    g.textContent = s;
  }

  function syncGutterScroll(){
    const g = $('caGutter');
    const ta = $('caTa');
    if(!g || !ta) return;
    g.scrollTop = ta.scrollTop;
  }

  /* ---------------- 搜索 ---------------- */

  function setMode(mode){
    state.mode = mode;
    $('caTree').hidden = mode !== 'tree';
    $('caSearchBox').hidden = mode !== 'search';
    $('caModeTree').classList.toggle('is-on', mode === 'tree');
    $('caModeSearch').classList.toggle('is-on', mode === 'search');
    if(mode === 'search') $('caSearchInput').focus();
  }

  function runSearch(){
    if(!hasDesktop() || !state.ready) return;
    const q = $('caSearchInput').value.trim();
    if(!q) return;
    $('caHits').innerHTML = '<div class="ca-empty">搜索中…</div>';
    return api().codeSearch(q, { maxHits: 120 }).then(r => {
      const hits = r.hits || [];
      if(!hits.length){
        $('caHits').innerHTML = '<div class="ca-empty">没有命中（扫了 ' + r.scanned + ' 个文件）</div>';
        return;
      }
      const rows = hits.map(h =>
        '<div class="ca-hit" data-rel="' + esc(h.rel) + '" data-line="' + h.line + '">' +
          '<div class="ca-hit-file">' + esc(h.rel) + '<span class="ca-hit-line">:' + h.line + '</span></div>' +
          '<div class="ca-hit-text">' + esc(h.text) + '</div>' +
        '</div>'
      );
      $('caHits').innerHTML = rows.join('') +
        (r.truncated ? '<div class="ca-empty">结果已截断，缩小关键词可看到更多</div>' : '');
    }).catch(e => { $('caHits').innerHTML = '<div class="ca-empty">' + esc(errText(e)) + '</div>'; });
  }

  function onHitClick(e){
    const hit = e.target.closest('.ca-hit');
    if(!hit) return;
    const rel = hit.getAttribute('data-rel');
    const line = Number(hit.getAttribute('data-line')) || 0;
    Promise.resolve(openFile(rel)).then(() => {
      if(!line) return;
      const ta = $('caTa');
      const lines = ta.value.split('\n');
      let pos = 0;
      for(let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = Math.min(pos, ta.value.length);
      // 目标行滚到靠上的位置，而不是贴底 —— 看到上下文才知道自己在哪
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
      ta.scrollTop = Math.max(0, (line - 3) * lh);
      syncGutterScroll();
    });
  }

  /* ---------------- 预览 ----------------
   *
   * 这一段解决的是「改完看不见」。没有它，助手说"已经修好了"和真的修好了
   * 在界面上长得一模一样 —— 人只能靠读代码判断，而那正是最容易出错的地方。
   *
   * 两个设计决定：
   *   ① **预览走独立协议，不用 file://**。file:// 在 app://openagi 源里
   *      会被拦；而且同源 iframe 能摸到 preload 挂的 openagiDesktop，
   *      等于给 AI 生成的页面开了个写盘后门。详见 main.js 的协议注释。
   *   ② **错误只上报不拦截**。注入的钩子只监听事件，不 preventDefault、
   *      不包 try/catch —— 页面行为和真浏览器必须一致，否则"预览通过"是假的。
   */

  function isPreviewable(rel){ return /\.html?$/i.test(String(rel || '')); }

  function pvUrl(rel){
    // 优先用 preload 给的构造器：scheme 只该有一处定义
    const d = api();
    if(d && typeof d.codePreviewUrl === 'function') return d.codePreviewUrl(rel);
    return 'openagi-preview://ws/' + String(rel || '').replace(/^\/+/, '')
      .split('/').map(encodeURIComponent).join('/');
  }

  /* 预览目标的选择顺序：显式传入 → 当前打开的文件 → 工作区根的 index.html。
   * 最后那一档是为「助手刚建好一个站，用户直接点预览」准备的 —— 这时候
   * 编辑器里可能还开着别的文件，不该逼人先去找 index.html。 */
  function openPreview(rel){
    if(!hasDesktop() || !state.ready) return;
    const cur = state.file && isPreviewable(state.file.rel) ? state.file.rel : '';
    const target = rel || cur;
    if(target){ startPreview(target); return; }
    return api().codeExists('index.html').then(r => {
      if(r && r.exists){ startPreview('index.html'); return; }
      hint('选一个 .html 文件再点预览（没找到工作区根的 index.html）。', 'err');
    }).catch(e => hint(errText(e)));
  }

  function startPreview(rel){
    if(isDirty()){
      /* 预览读的是磁盘。不提醒的话，用户改了三分钟点预览还是旧样子，
       * 会以为预览坏了或者助手没生效 —— 这个歧义必须当场消掉。 */
      hint('编辑器里有未保存的改动，预览看到的是磁盘上的版本。Ctrl+S 之后再看。', 'err');
    }else{
      hint('预览：' + rel);
    }
    state.pv.open = true;
    state.pv.rel = rel;
    state.pv.errors = [];
    state.pv.title = '';
    $('caPv').hidden = false;
    $('caEdit').hidden = true;
    paintPvBar();
    renderPvErrors();
    reloadPreview();
  }

  function paintPvBar(){
    const u = $('caPvUrl');
    if(!u) return;
    const t = state.pv.title ? (state.pv.title + '  —  ') : '';
    u.textContent = t + state.pv.rel;
    u.title = pvUrl(state.pv.rel);
  }

  let pvTimer = null;
  /* 刷新加个时间戳：文件本身已经 no-store，但 iframe 换 src 时
   * 浏览器可能复用上一份 document（尤其同 URL），加参数是成本最低的可靠办法。 */
  function reloadPreview(flash){
    const f = $('caPvFrame');
    if(!f || !state.pv.rel) return;
    if(pvTimer){ clearTimeout(pvTimer); pvTimer = null; }
    const sep = pvUrl(state.pv.rel).indexOf('?') < 0 ? '?' : '&';
    state.pv.lastLoad = Date.now();
    f.src = pvUrl(state.pv.rel) + sep + '_=' + state.pv.lastLoad;
    state.pv.errors = [];
    state.pv.title = '';
    paintPvBar();
    renderPvErrors();
    if(flash) hint('已刷新预览。');
  }

  function closePreview(){
    state.pv.open = false;
    const f = $('caPvFrame');
    /* 置空而不是留着：页面里的 setInterval / 动画 / 音频不会因为 hidden 就停，
     * 一直跑着既费电又会持续发 postMessage。 */
    if(f) f.src = 'about:blank';
    $('caPv').hidden = true;
    $('caEdit').hidden = false;
  }

  function openInBrowser(){
    if(!state.pv.rel || !hasDesktop()) return;
    api().codeOpenExternal(state.pv.rel).then(r => {
      if(r && r.ok === false) hint('打不开：' + (r.message || '未知原因'), 'err');
    }).catch(e => hint(errText(e)));
  }

  /* 预览页发回来的事件。只认自家源的，且必须带 __ogi 标记 ——
   * 否则第三方页面随便 postMessage 一条就能污染错误列表，
   * 让助手去修一个根本不存在的问题。 */
  function onPreviewMsg(e){
    if(!state.pv.open) return;
    const d = e.data;
    if(!d || typeof d !== 'object' || d.__ogi !== 1) return;
    const org = String(e.origin || '');
    if(org !== 'openagi-preview://ws' && org !== 'null') return;

    if(d.t === 'ready'){
      /* ⚠ 这里**不能清空 errors**。
       * 曾经在这清过，结果资源 404 全丢：404 发生在页面解析期（<script src> 是阻塞的），
       * 早于 DOMContentLoaded；ready 一来就把刚记下的错误抹掉，
       * 用户看到的永远是"只剩那几个 JS 异常"。
       * 「重新加载 = 旧错误作废」这件事由 reloadPreview() 负责 —— 那才是加载的起点。 */
      state.pv.title = String(d.title || '');
      paintPvBar();
      return;
    }
    if(d.t === 'err'){
      pushPvErr('runtime', 'JS', String(d.msg || '未知错误') + (d.at && !/:0:0$/.test(d.at) ? '  @ ' + d.at : ''));
      return;
    }
    if(d.t === 'rej'){
      pushPvErr('promise', 'Promise', String(d.msg || '未捕获的 Promise 拒绝'));
      return;
    }
    if(d.t === 'res'){
      const u = String(d.url || '').split('/').pop() || String(d.url || '');
      pushPvErr('res', String(d.tag || 'res').toUpperCase(), '加载失败：' + u);
    }
  }

  function pushPvErr(kind, tag, text){
    const key = kind + '|' + text;
    if(state.pv.errors.some(x => x.key === key)) return;
    if(state.pv.errors.length >= 40) return;   // 够用了；再多也不会有新信息
    state.pv.errors.push({ key, kind, tag, text });
    renderPvErrors();
  }

  function renderPvErrors(){
    const btn = $('caPvErrBtn');
    const list = $('caPvList');
    const errs = state.pv.errors;
    if(btn){
      btn.hidden = errs.length === 0;
      btn.textContent = '错误 ' + errs.length;
    }
    if(!list) return;
    if(!errs.length){
      list.innerHTML = '';
      list.hidden = true;
      list.dataset.show = '0';
      return;
    }
    list.innerHTML = errs.map(x =>
      '<div class="ca-pv-item"><span class="ca-pv-tag pv-' + x.kind + '">' + esc(x.tag) + '</span>'
      + '<span class="ca-pv-msg">' + esc(x.text) + '</span></div>'
    ).join('');
    // 列表默认收起，只在用户点开时展开（错误多的时候它会盖住页面）
    list.hidden = list.dataset.show !== '1';
  }

  /* ---------------- 提示 ---------------- */

  /* ---------------- 轨迹看板（H0） ----------------
   *
   * 为什么要有这个面板：轨迹如果只有"记下来"而没有"能看见"，
   * 那它就只是个看不见的副作用 —— 谁也不会去验证它记对了没有。
   * 面板上这几个数就是提案里的 evidence.baseline 的直接来源。
   */

  function traceApi(){
    return (global.CodeTrace && typeof global.CodeTrace.stats === 'function') ? global.CodeTrace : null;
  }

  function fmtMs(v){
    const n = Number(v) || 0;
    return n >= 1000 ? (Math.round(n / 100) / 10) + 's' : n + 'ms';
  }

  function statCell(label, value, note){
    return '<div class="ca-tb-cell"><div class="ca-tb-v">' + esc(String(value)) + '</div>'
      + '<div class="ca-tb-k">' + esc(label) + '</div>'
      + (note ? '<div class="ca-tb-n">' + esc(note) + '</div>' : '') + '</div>';
  }

  function renderTrace(){
    const box = $('caTraceBox');
    if(!box) return;
    const T = traceApi();
    if(!T){
      box.innerHTML = '<div class="ca-tb-empty">轨迹模块未加载（js/code-trace.js）。</div>';
      return;
    }
    const s = T.stats();
    const b = T._budget();
    const head = '<div class="ca-tb-head"><span class="ca-tb-title">任务轨迹</span>'
      + '<span class="ca-tb-sub">' + s.tasks + ' 条 · ' + Math.max(1, Math.round(b.bytes / 1024)) + 'KB'
      + (b.writable ? '' : ' · 仅本会话') + '</span>'
      + '<span class="ca-grow"></span>'
      + '<button type="button" class="ca-btn" data-tb="export">导出</button>'
      + '<button type="button" class="ca-btn" data-tb="clear">清空</button>'
      + '<button type="button" class="ca-btn" data-tb="close">关闭</button></div>';

    if(!s.tasks){
      box.innerHTML = head + '<div class="ca-tb-empty">还没有记录。和助手跑一次任务，这里就会出现基线数据。</div>';
      return;
    }

    const cells = [
      statCell('工具调用 中位', s.toolCalls.median, '共 ' + s.toolCalls.n + ' 次任务'),
      statCell('首编辑前读取', s.readsBeforeFirstEdit.median, 'H1 判定指标'),
      statCell('接受率', s.acceptRate == null ? '—' : Math.round(s.acceptRate * 100) + '%',
        s.applied + ' 应用 / ' + s.declined + ' 放弃'),
      statCell('确认等待 中位', fmtMs(s.confirmWait.median), 'H2 判定指标'),
      statCell('任务耗时 中位', fmtMs(s.ms.median), 'p90 ' + fmtMs(s.ms.p90))
    ].join('');

    const reasons = Object.keys(s.byReason).map(k => k + ' ' + s.byReason[k]).join(' · ');

    const rows = T.list({ limit: 10 }).reverse().map(t => {
      const e = t.edges || {};
      const d = new Date(t.at);
      const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      return '<div class="ca-tb-row">'
        + '<span class="ca-tb-c ca-tb-t">' + hh + '</span>'
        + '<span class="ca-tb-c ca-tb-m">' + esc(t.model || '-') + '</span>'
        + '<span class="ca-tb-c">' + esc(t.reason || '-') + '</span>'
        + '<span class="ca-tb-c">' + (e.tools || 0) + ' 工具</span>'
        + '<span class="ca-tb-c">' + fmtMs(t.ms) + '</span>'
        + '<span class="ca-tb-c">' + (e.applied || 0) + ' 应用 / ' + (e.declined || 0) + ' 放弃</span>'
        + '</div>';
    }).join('');

    box.innerHTML = head
      + '<div class="ca-tb-grid">' + cells + '</div>'
      + '<div class="ca-tb-note">结束原因：' + reasons + '</div>'
      + '<div class="ca-tb-rows">' + rows + '</div>';
  }

  function toggleTrace(force){
    const box = $('caTraceBox');
    if(!box) return;
    const show = (force === undefined) ? box.hidden : !!force;
    box.hidden = !show;
    if(show) renderTrace();
  }

  function onTraceClick(e){
    const btn = e.target.closest ? e.target.closest('[data-tb]') : null;
    if(!btn) return;
    const act = btn.getAttribute('data-tb');
    if(act === 'close'){ toggleTrace(false); return; }
    const T = traceApi();
    if(!T) return;
    if(act === 'clear'){
      if(typeof global.confirm === 'function' && !global.confirm('清空全部轨迹记录？不可恢复。')) return;
      T.clear();
      renderTrace();
      return;
    }
    if(act === 'export'){
      try{
        const blob = new Blob([T.exportJson()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'code-trace-' + Date.now() + '.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        hint('已导出轨迹 JSON。', 'ok');
      }catch(err){ hint('导出失败：' + errText(err), 'err'); }
    }
  }

  function hint(msg, cls){
    const el = $('caHint');
    if(!el) return;
    el.textContent = msg;
    el.classList.toggle('is-err', cls === 'err');
    el.classList.toggle('is-ok', cls === 'ok');
  }

  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------- 入口 ---------------- */

  /* 由 desk-shell 的 DESK_APPS 调用。窗口本身已经由 openDeskApp 挂好了，
   * 这里**只填充内容**，不要再 deskMountApp（会把骨架提前撤掉）。 */
  function open(){
    build();
    setMode('tree');
    paintRoot();
    if(!hasDesktop()){
      hint('网页版拿不到本地文件系统。要在桌面版（Electron）里用这个 App。');
      return Promise.resolve();
    }
    // 返回 promise：骨架要等真正画出内容才撤（deskSkelWatch 认这个）
    return api().codeInfo().then(info => {
      paintRoot();
      if(!info || !info.ready){
        hint('还没有选择工作区。点左上角「选择文件夹」——建议不要选正在跑的这个项目目录。');
        renderTree();
        return;
      }
      state.root = info.root;
      state.name = info.name;
      state.ready = true;
      paintRoot();
      return reloadTree();
    }).catch(e => hint(errText(e)));
  }

  /* 只给测试用的渲染钩子。为什么需要暴露：
   * 文件树的渲染逻辑（转义、缩进、折叠）在 Node 里测不到，而真测试又没法点
   * 系统的选目录对话框 —— 没有这个钩子，"树画得对不对"只能靠肉眼看截图。
   * 与 asset-store 的 _resetCache 同一性质：只为测试存在，不参与业务。
   * 界面上没有任何调用方，删掉它不影响功能（但会让 test-code-ui 失去覆盖）。 */
  global.codeApp = {
    open,
    state,
    /* openFile 是真入口（双击文件走的就是它），导出来是给测试直接驱动 ——
     * 靠模拟 DOM 双击去触发等价于测"双击事件有没有绑上"，那是另一件事。 */
    openFile,
    _render: { tree: renderTree, editor: renderEditor, gutter: renderGutter }
  };
})(window);
