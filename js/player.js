/* 播放器 App
 *
 * 定位很窄：播「已经在本地的」视频 / 音频。它不抓站、不解码不可解的格式，
 * 也不碰任何版权来源——素材怎么进本地是用户自己的事（导入文件夹 / 导文件 / 直链下载）。
 *
 * 三种环境都要能用：
 *   ① Electron（正常形态）：文件在 userData/media，走 openagi-media:// 流式播，
 *      所以进度条能拖、内存不涨。列表由主进程扫磁盘得出，id 是相对路径。
 *   ② 浏览器直开 index.html：没有媒体库，退化成 <input type=file> + objectURL，
 *      只在当前会话有效（刷新就没了）——这条路的用途是方便调试，不是日常形态。
 *   ③ 打包后同样的代码，只是 root 换成 userData。
 *
 * 三条要守的：
 *   ① **切走就暂停**：App 页翻走之后视频还在响、又看不到画面，是最容易让人
 *      「以为是 bug」的那种状态。暂停并把进度落盘，回来接着播。
 *   ② **进度按 id 存**：id 是相对路径，改文件名不影响，删了文件记录自然失效。
 *   ③ **列表重绘要带签名**：切集时列表只该变一个高亮，整表重建会打断滚动位置，
 *      一部番八十集往下翻着找，一重绘就跳回顶部。
 */
(function(){
  'use strict';

  const POS_KEY = 'hf_player_pos';
  const SET_KEY = 'hf_player_set';
  const MAX_POS = 300;

  /* ---------------- 纯逻辑（无 DOM，测试直接调） ---------------- */

  function fmtTime(sec){
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
  }

  function fmtSizeMB(mb){
    const n = Number(mb) || 0;
    if(n >= 1024) return (Math.round(n / 102.4) / 10) + ' GB';
    return (Math.round(n * 10) / 10) + ' MB';
  }

  /* 自然序：`第2集` 必须排在 `第10集` 前面。播放列表的顺序错了，
   * 用户第一次点「下一集」就会发现跳集，这比什么优化都致命。 */
  const NAT = (typeof Intl !== 'undefined' && Intl.Collator)
    ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    : null;
  function naturalCmp(a, b){
    if(NAT) return NAT.compare(String(a == null ? '' : a), String(b == null ? '' : b));
    return String(a) < String(b) ? -1 : (String(a) > String(b) ? 1 : 0);
  }

  /* 可播队列：只要视频和音频。字幕和图不进队列（图片点开看不了，字幕更不能当一集播）。
     folder 用 **null 表示「全部」**，`''` 表示「根目录下的散文件」——
     两者必须分开，否则用户点「散文件」分组会得到整个库。
     排序上「有分组」的在前、「散文件」垫底：一部番是主菜，散落的单个文件是杂物。 */
  function queueOf(files, folder){
    const list = (Array.isArray(files) ? files : []).filter(f => {
      if(!f || (f.kind !== 'video' && f.kind !== 'audio')) return false;
      if(folder == null) return true;
      return (f.folder || '') === folder;
    });
    return list.slice().sort((a, b) => {
      const fa = a.folder || '';
      const fb = b.folder || '';
      if(!fa !== !fb) return fa ? -1 : 1;              // 有分组的一律在前
      return naturalCmp(fa, fb) || naturalCmp(a.name, b.name);
    });
  }

  /* 分组：根目录散文件归一个「散文件」组，其余按子目录名。 */
  function groupsOf(files){
    const map = new Map();
    for(const f of (Array.isArray(files) ? files : [])){
      if(!f || (f.kind !== 'video' && f.kind !== 'audio')) continue;
      const key = f.folder || '';
      if(!map.has(key)) map.set(key, { key, name: key || '散文件', count: 0 });
      map.get(key).count++;
    }
    const out = Array.from(map.values());
    /* 「散文件」恒在最后：分组条上它就是个杂物筐，占着第一个位置会让人以为它是主入口。 */
    out.sort((a, b) => {
      const ka = a.key || '';
      const kb = b.key || '';
      if(!ka !== !kb) return ka ? -1 : 1;
      return naturalCmp(a.name, b.name);
    });
    return out;
  }

  /* 断点续播的判断：太靠前（片头曲还没完）不续，太靠后（只剩十几秒）也不续——
   * 直接当看完处理，否则「下一集」的体验会变成每次都要重新拖到最后。 */
  function resumeAt(rec, duration){
    const t = Number(rec && rec.t) || 0;
    const d = Number(duration || (rec && rec.d) || 0);
    if(!(t > 10)) return 0;
    if(d && t > d - 15) return 0;
    return t;
  }

  const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  function nextRate(cur){
    const i = RATES.indexOf(Number(cur));
    return RATES[(i < 0 ? 2 : i + 1) % RATES.length];
  }

  function loadPos(){
    try{
      const raw = JSON.parse(localStorage.getItem(POS_KEY) || '{}');
      return (raw && typeof raw === 'object') ? raw : {};
    }catch(e){ return {}; }
  }
  function savePos(map){
    try{
      /* 按时间裁一刀：不裁的话看两年能攒几千条，localStorage 一共才 5MB。 */
      const keys = Object.keys(map);
      if(keys.length > MAX_POS){
        keys.sort((a, b) => (map[b].at || 0) - (map[a].at || 0));
        const keep = {};
        for(const k of keys.slice(0, MAX_POS)) keep[k] = map[k];
        map = keep;
      }
      localStorage.setItem(POS_KEY, JSON.stringify(map));
    }catch(e){}
  }

  function loadSet(){
    /* folder 默认 null = 「全部」。存了 '' 就是「只看根目录散文件」，两者不能混。 */
    const def = { vol: 1, rate: 1, muted: false, folder: null };
    try{
      const raw = JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {};
      return {
        vol: typeof raw.vol === 'number' && raw.vol >= 0 && raw.vol <= 1 ? raw.vol : def.vol,
        rate: RATES.indexOf(Number(raw.rate)) >= 0 ? Number(raw.rate) : def.rate,
        muted: !!raw.muted,
        folder: (raw.folder === null || typeof raw.folder === 'string') ? raw.folder : def.folder
      };
    }catch(e){ return def; }
  }
  function saveSet(s){
    try{ localStorage.setItem(SET_KEY, JSON.stringify(s)); }catch(e){}
  }

  /* ---------------- UI ---------------- */

  const $ = id => document.getElementById(id);
  const desktop = (typeof window !== 'undefined' && window.openagiDesktop) ? window.openagiDesktop : null;
  const hasLib = !!(desktop && typeof desktop.mediaList === 'function');

  const state = {
    open: false,
    files: [],          // 媒体库全量（含图片/字幕）
    local: [],          // 浏览器降级的临时条目（objectURL）
    folder: null,       // null = 全部；'' = 根目录散文件；其余 = 子目录名
    cur: null,
    queue: [],
    idx: -1,
    pos: loadPos(),
    set: loadSet(),
    listSig: '',
    root: '',           // 媒体库目录（用于提示与「打开目录」）
    jobId: '',
    downloading: false,
    tick: 0,
    error: ''
  };

  /* 浏览器降级的条目也走同一套结构，只是 url 换成 objectURL。 */
  function allFiles(){
    return state.local.concat(state.files);
  }

  function urlOf(item){
    if(!item) return '';
    if(item.url) return item.url;
    /* 整段 encodeURIComponent：路径里可能有空格、中文、`#`，
     * 不编码的话 `#` 会被当成 fragment，浏览器只请求到 `#` 前面的部分。 */
    return 'openagi-media://media/' + encodeURIComponent(item.id);
  }

  function curPos(){ return state.pos[state.cur ? state.cur.id : ''] || null; }

  function markPos(force){
    const v = $('plVideo');
    if(!v || !state.cur || !v.duration || !isFinite(v.duration)) return;
    const id = state.cur.id;
    if(!id) return;
    const rec = { t: v.currentTime, d: v.duration, at: Date.now() };
    /* 只在有意义的位置落盘：0 秒和结尾不记，省得记录了又用不上。 */
    if(rec.t < 5 || rec.t > rec.d - 5){ if(!force) return; }
    state.pos[id] = rec;
    savePos(state.pos);
  }

  function renderList(){
    const host = $('plList');
    if(!host) return;
    const q = queueOf(allFiles(), state.folder);
    state.queue = q;
    state.idx = state.cur ? q.findIndex(f => f.id === state.cur.id) : -1;
    /* 签名里必须有 cur.id 和 folder：这两样一变高亮就要动，
     * 但文件集合没变时不该整表重建（会丢滚动位置）。 */
    const sig = state.folder + '|' + (state.cur ? state.cur.id : '') + '|' + q.map(f => f.id + ':' + f.size).join(',');
    if(sig === state.listSig) return;
    state.listSig = sig;
    if(!q.length){
      host.innerHTML = '<div class="pl-hint">这个分组里没有可播的文件。</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    q.forEach((f, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pl-item' + (state.cur && state.cur.id === f.id ? ' is-cur' : '');
      row.dataset.id = f.id;
      row.title = f.name + (f.playable === false ? '（这个容器的编码浏览器一般解不了，可能黑屏）' : '');
      const pos = state.pos[f.id];
      const pct = (pos && pos.d > 5) ? Math.min(100, Math.round(pos.t / pos.d * 100)) : 0;
      row.innerHTML =
        '<span class="pl-no">' + (i + 1) + '</span>' +
        '<span class="pl-nm">' + esc(f.name) + (f.playable === false ? '<i class="pl-warn" title="可能不支持">!</i>' : '') + '</span>' +
        '<span class="pl-meta">' + fmtSizeMB(f.sizeMB) + '</span>' +
        (pct ? '<span class="pl-done" style="width:' + pct + '%"></span>' : '');
      row.addEventListener('click', () => playId(f.id));
      frag.appendChild(row);
    });
    host.innerHTML = '';
    host.appendChild(frag);
    /* 当前项滚进视野：换集之后列表要跟着走，否则用户看不到自己播到第几集。 */
    const cur = host.querySelector('.pl-item.is-cur');
    if(cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'nearest' });
  }

  function renderFolders(){
    const host = $('plFolders');
    if(!host) return;
    const gs = groupsOf(allFiles());
    const total = gs.reduce((n, g) => n + g.count, 0);
    const items = [{ key: null, name: '全部', count: total }].concat(gs);
    host.innerHTML = '';
    for(const g of items){
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pl-chip' + (state.folder === g.key ? ' is-on' : '');
      b.textContent = g.name + ' · ' + g.count;
      b.title = g.name;
      b.addEventListener('click', () => {
        state.folder = g.key;
        state.set.folder = g.key;
        saveSet(state.set);
        renderFolders();
        renderList();
        renderCount();
      });
      host.appendChild(b);
    }
  }

  /* 侧栏右上角的「N 个 · 总量」：文件数 + 占用空间都是用户真正关心的两件事，
   * 放在同一行而不是两处。 */
  function renderCount(){
    const el = $('plCount');
    if(!el) return;
    const all = allFiles().filter(f => f && (f.kind === 'video' || f.kind === 'audio'));
    const n = queueOf(all, state.folder).length;
    if(!all.length){ el.textContent = ''; return; }
    const mb = all.reduce((s, f) => s + (Number(f.sizeMB) || 0), 0);
    el.textContent = n + ' / ' + all.length + ' 个 · ' + fmtSizeMB(mb);
    el.title = state.root ? ('媒体库目录：' + state.root) : '';
  }

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* 三态：null = 收起、'empty' = 还没东西可播、'error' = 这一集播不了。
   * 关键点是**收起不能等 loadedmetadata** —— 容器解不了的文件根本不会有那个事件，
   * 空态会一直盖在画面上，看起来像「点了没反应」。 */
  function setEmpty(mode, msg){
    const box = $('plEmpty');
    if(!box) return;
    const t = box.querySelector('.pl-empty-t');
    const s = box.querySelector('.pl-empty-s');
    if(!mode){ box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if(mode === 'error'){
      if(t) t.textContent = '播不了这一集';
      if(s) s.textContent = msg || '未知原因';
    }else{
      if(t) t.textContent = '还没有可播的东西';
      if(s) s.textContent = '用右边「导入文件夹」加一整部，或「＋ 直链」下一集进来';
    }
  }

  function setError(msg){
    state.error = msg || '';
    setEmpty('error', msg);
  }

  function clearError(){
    if(!state.error) return;
    state.error = '';
    setEmpty(null);
  }

  function paintPlayIcon(playing){
    const b = $('plPlay');
    if(!b) return;
    const play = b.querySelector('.pl-ico-play');
    const pause = b.querySelector('.pl-ico-pause');
    if(play) play.classList.toggle('hidden', !!playing);
    if(pause) pause.classList.toggle('hidden', !playing);
    b.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  function paintTime(){
    const v = $('plVideo');
    const t = $('plTime');
    const seek = $('plSeek');
    if(!v || !t) return;
    const d = isFinite(v.duration) ? v.duration : 0;
    t.textContent = fmtTime(v.currentTime) + ' / ' + (d ? fmtTime(d) : '--:--');
    if(seek && document.activeElement !== seek){
      seek.value = d ? String(Math.round(v.currentTime / d * 1000)) : '0';
    }
  }

  function applySettings(){
    const v = $('plVideo');
    if(!v) return;
    v.volume = state.set.vol;
    v.muted = state.set.muted;
    v.playbackRate = state.set.rate;
    const vol = $('plVol');
    if(vol) vol.value = String(Math.round(state.set.vol * 100));
    const rate = $('plRate');
    if(rate) rate.textContent = state.set.rate + '×';
    const mute = $('plMute');
    if(mute){
      const wave = mute.querySelector('.pl-ico-wave');
      const muteIco = mute.querySelector('.pl-ico-mute');
      if(wave) wave.classList.toggle('hidden', state.set.muted);
      if(muteIco) muteIco.classList.toggle('hidden', !state.set.muted);
    }
  }

  /* 真正切集。所有入口（点列表、上一集/下一集、自动续播、导入后立刻播）
   * 都从这里进，避免出现「点列表和点下一集行为不一样」的分叉。 */
  function playId(id){
    const q = queueOf(allFiles(), state.folder);
    const item = q.find(f => f.id === id) || allFiles().find(f => f.id === id);
    if(!item) return false;
    const v = $('plVideo');
    if(!v) return false;
    markPos();                       // 换集前把上一集的进度落盘
    state.cur = item;
    state.queue = q;
    state.idx = q.findIndex(f => f.id === item.id);

    const url = urlOf(item);
    if(!url){ setError('这条记录没有可用的地址'); return false; }
    clearError();
    /* 空态立刻收起（不等 loadedmetadata）：解不了的文件不会有那个事件。 */
    setEmpty(null);
    v.src = url;
    v.load();
    v.playbackRate = state.set.rate;

    const rec = state.pos[item.id];
    const startAt = resumeAt(rec, rec && rec.d);
    if(startAt > 0){
      /* metadata 就绪后才能 seek；直接 currentTime 赋值在还没拿到 duration 时会被丢弃。 */
      const onMeta = () => {
        v.removeEventListener('loadedmetadata', onMeta);
        try{ v.currentTime = startAt; }catch(e){}
      };
      v.addEventListener('loadedmetadata', onMeta);
    }
    const p = v.play();
    if(p && typeof p.catch === 'function'){
      p.catch(err => {
        /* NotAllowedError = 浏览器要求先有用户手势，这个在桌面壳里不会发生；
         * NotSupportedError = 容器/编码解不了，如实说，别让用户对着黑屏猜。 */
        const name = (err && err.name) || '';
        if(name === 'NotSupportedError') setError('这个文件的封装或编码 Chromium 解不了（mkv/avi/wmv 常见）。转成 mp4(H.264+AAC) 再试。');
        else if(name === 'NotAllowedError') setError('需要先点一下播放按钮（浏览器自动播放限制）。');
        else if(name !== 'AbortError') setError((err && err.message) || '播放失败');
      });
    }
    paintPlayIcon(true);
    renderList();
    paintTime();
    return true;
  }

  function step(delta){
    const q = state.queue.length ? state.queue : queueOf(allFiles(), state.folder);
    if(!q.length) return false;
    const i = state.cur ? q.findIndex(f => f.id === state.cur.id) : -1;
    let n = i + delta;
    if(n < 0) n = 0;
    if(n >= q.length) return false;
    return playId(q[n].id);
  }

  function next(){ return step(1); }
  function prev(){ return step(-1); }

  /* ---------------- 导入 / 下载 ---------------- */

  async function refresh(keepPlaying){
    if(!hasLib) return false;
    try{
      const r = await desktop.mediaList();
      state.files = Array.isArray(r && r.files) ? r.files : [];
      state.root = (r && r.root) || '';
      state.listSig = '';             // 集合变了，签名作废（否则列表不会重绘）
      const v = $('plVideo');
      const had = state.cur;
      renderFolders();
      renderList();
      renderCount();
      /* 正在播的那一集如果被外部删了：停下来并把空态说清楚，
       * 而不是让 <video> 自己报一个看不懂的 MEDIA_ERR。 */
      if(had && !state.files.some(f => f.id === had.id) && !state.local.some(f => f.id === had.id)){
        if(v){ v.pause(); v.removeAttribute('src'); v.load(); }
        state.cur = null;
        paintPlayIcon(false);
        setError('这一集已经不在媒体库里了（可能被删或移出了目录）。');
      }
      if(keepPlaying && had && state.cur) renderList();
      return true;
    }catch(e){
      setError('读取媒体库失败：' + ((e && e.message) || e));
      return false;
    }
  }

  async function doImport(kind){
    if(!hasLib){
      /* 浏览器：只能临时播。给出明确说明，别让用户以为「导进来了但下次没了」是 bug。 */
      const inp = $('plFile');
      if(inp) inp.click();
      return;
    }
    const fn = kind === 'dir' ? desktop.mediaImportDir : desktop.mediaImport;
    try{
      const r = await fn();
      if(!r || r.cancelled) return r;
      if(r.ok === false){
        setError(r.message || '导入失败');
        return r;
      }
      await refresh();
      if(r.errors && r.errors.length) setError(r.errors[0]);
      else clearError();
      /* 只导进一集的情况下直接开播：用户点「导入」十有八九就是想看。 */
      if(r.files && r.files.length === 1) playId(r.files[0].id);
      else if(r.files && r.files.length && !state.cur) playId(r.files[0].id);
      return r;
    }catch(e){
      setError('导入失败：' + ((e && e.message) || e));
      return { ok: false };
    }
  }

  function onLocalPick(){
    const inp = $('plFile');
    if(!inp || !inp.files) return;
    state.local = Array.from(inp.files || []).map((f, i) => ({
      id: 'local:' + i + ':' + f.name,
      name: f.name,
      folder: '',
      kind: /^audio\//i.test(f.type) ? 'audio' : 'video',
      ext: (f.name.split('.').pop() || '').toLowerCase(),
      sizeMB: Math.round(f.size / 104857.6) / 10,
      playable: true,
      url: URL.createObjectURL(f)
    }));
    state.listSig = '';
    renderFolders();
    renderList();
    renderCount();
    if(state.local.length) playId(state.local[0].id);
    inp.value = '';
  }

  function paintProgress(info){
    const box = $('plProg');
    const bar = $('plProgBar');
    const txt = $('plProgTxt');
    if(!box) return;
    if(!info){ box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const pct = Math.max(0, Math.min(100, Number(info.pct) || 0));
    if(bar) bar.style.width = pct + '%';
    if(txt){
      const sp = info.speed ? (' · ' + Math.round(info.speed / 1048576) + ' MB/s') : '';
      /* ollama-download 上报的是 etaMs（不是 eta），单位毫秒 */
      const eta = (typeof info.etaMs === 'number' && info.etaMs > 0) ? (' · 剩 ' + fmtTime(info.etaMs / 1000)) : '';
      txt.textContent = pct + '%' + sp + eta;
    }
  }

  async function doDownload(){
    const urlEl = $('plDlUrl');
    const nameEl = $('plDlName');
    const url = urlEl ? String(urlEl.value || '').trim() : '';
    if(!/^https?:\/\//i.test(url)){ setError('请填一个 http/https 直链'); return; }
    if(!hasLib){
      setError('浏览器里没法把大文件写进磁盘；用桌面版（Electron）才能下载到本地。');
      return;
    }
    if(state.downloading) return;
    state.downloading = true;
    state.jobId = 'dl' + Date.now().toString(36);
    const go = $('plDlGo');
    if(go){ go.disabled = true; go.textContent = '下载中…'; }
    paintProgress({ pct: 0 });
    try{
      const r = await desktop.mediaDownload({ url, name: nameEl ? String(nameEl.value || '').trim() : '', jobId: state.jobId });
      if(r && r.ok){
        if(urlEl) urlEl.value = '';
        if(nameEl) nameEl.value = '';
        hideDl();
        await refresh();
        if(r.id) playId(r.id);
        clearError();
      }else if(r && r.cancelled){
        clearError();
      }else{
        setError((r && r.message) || '下载失败');
      }
    }catch(e){
      setError('下载失败：' + ((e && e.message) || e));
    }finally{
      state.downloading = false;
      state.jobId = '';
      if(go){ go.disabled = false; go.textContent = '下载到本地'; }
      paintProgress(null);
    }
  }

  function showDl(){
    const b = $('plDl');
    if(!b) return;
    b.classList.remove('hidden');
    const u = $('plDlUrl');
    if(u){ u.focus(); if(u.select) u.select(); }
  }
  function hideDl(){
    const b = $('plDl');
    if(b) b.classList.add('hidden');
  }

  /* ---------------- 生命周期 ---------------- */

  function open(){
    const win = $('playerWin');
    if(!win) return false;
    const meta = (typeof DESK_APP_META !== 'undefined' && DESK_APP_META.player) || { title: '播放器', sub: '本地的视频与音频' };
    /* 已经 mount 过就别再调一次：deskMountApp 内部会 deskSkelHide()，
     * 在延迟加载批次里重复调等于把骨架提前撤掉，App 页会空一下。 */
    const mounted = win.parentElement && win.parentElement.id === 'deskAppHost';
    if(!mounted && typeof deskMountApp === 'function') deskMountApp(win, meta.title, meta.sub);
    else win.classList.remove('hidden');
    state.open = true;
    ensureBind();
    applySettings();
    /* 先画已缓存的内容，再去读磁盘——第二次打开时列表就是即时的，不用等主进程。
     * 返回值是 Promise：deskSkelWatch 会等它落定才撤骨架，
     * 所以「扫目录慢」这件事对用户表现为骨架多停一会儿，而不是白板闪一下。 */
    if(hasLib && state.files.length){
      renderFolders(); renderList(); renderCount();
    }
    return refresh();
  }

  function stopPlayback(){
    const v = $('plVideo');
    if(!v) return;
    markPos(true);
    try{ v.pause(); }catch(e){}
    paintPlayIcon(false);
  }

  function close(){
    stopPlayback();
    state.open = false;
    const win = $('playerWin');
    if(!win) return;
    /* 走 desktop.js 的统一关闭入口：正显示在 App 页里的走翻页返回，
     * 否则只隐藏。自己判 parentElement 会在「刚点开就被关掉」那一瞬判错。 */
    if(typeof deskCloseWin === 'function') deskCloseWin(win);
    else win.classList.add('hidden');
  }

  function toggleFull(){
    const box = $('plScreen');
    if(!box) return;
    if(document.fullscreenElement){
      document.exitFullscreen().catch(() => {});
      return;
    }
    if(box.requestFullscreen) box.requestFullscreen().catch(() => {});
  }

  function togglePlay(){
    const v = $('plVideo');
    if(!v) return;
    if(!state.cur){
      const q = queueOf(allFiles(), state.folder);
      if(q.length){ playId(q[0].id); return; }
      return;
    }
    if(v.paused){ v.play().catch(() => {}); } else { v.pause(); }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind(){
    const v = $('plVideo');
    if(!v) return;

    v.addEventListener('play', () => paintPlayIcon(true));
    v.addEventListener('pause', () => { paintPlayIcon(false); markPos(); });
    v.addEventListener('timeupdate', () => {
      paintTime();
      /* 每 3 秒落一次进度：timeupdate 一秒好几次，每次都写 localStorage
       * 会在长片上变成持续的同步写盘（主线程卡顿）。 */
      if(++state.tick % 3 === 0) markPos();
    });
    v.addEventListener('loadedmetadata', () => {
      paintTime();
      clearError();
      setEmpty(null);
    });
    v.addEventListener('emptied', () => {
      if(!state.cur) setEmpty('empty');
    });
    v.addEventListener('ended', () => {
      markPos(true);
      if(!next()) paintPlayIcon(false);
    });
    v.addEventListener('error', () => {
      const code = v.error ? v.error.code : 0;
      const msg = code === 4 ? '这个文件的封装或编码解不了（mkv / avi / wmv / flv 常见）。转成 mp4(H.264+AAC) 就能播。'
        : code === 2 ? '读取中断，文件可能被移走或正在被其他程序占用。'
        : code === 3 ? '解码出错，文件可能不完整。'
        : '播放器报错（' + code + '）。';
      setError(msg);
      paintPlayIcon(false);
    });

    const bindClick = (id, fn) => { const el = $(id); if(el) el.addEventListener('click', fn); };
    bindClick('plPlay', togglePlay);
    bindClick('plPrev', prev);
    bindClick('plNext', next);
    bindClick('plFull', toggleFull);
    bindClick('plMute', () => {
      state.set.muted = !state.set.muted;
      saveSet(state.set);
      applySettings();
    });
    bindClick('plRate', () => {
      state.set.rate = nextRate(state.set.rate);
      saveSet(state.set);
      applySettings();
    });
    bindClick('plImport', () => doImport('file'));
    bindClick('plImportDir', () => doImport('dir'));
    bindClick('plDlOpen', () => { const b = $('plDl'); if(b && b.classList.contains('hidden')) showDl(); else hideDl(); });
    bindClick('plDlCancel', hideDl);
    bindClick('plDlGo', doDownload);
    bindClick('plProgX', () => { if(state.jobId && hasLib) desktop.mediaCancel(state.jobId); });
    bindClick('plDir', () => { if(hasLib && desktop.mediaOpenDir) desktop.mediaOpenDir(); });
    bindClick('btnPlayerWinClose', close);

    const seek = $('plSeek');
    if(seek){
      seek.addEventListener('input', () => {
        const d = v.duration;
        if(!d || !isFinite(d)) return;
        v.currentTime = Number(seek.value) / 1000 * d;
      });
    }
    const vol = $('plVol');
    if(vol){
      vol.addEventListener('input', () => {
        state.set.vol = Math.max(0, Math.min(1, Number(vol.value) / 100));
        if(state.set.vol > 0) state.set.muted = false;
        saveSet(state.set);
        applySettings();
      });
    }
    const inp = $('plFile');
    if(inp) inp.addEventListener('change', onLocalPick);

    /* 双击画面 = 全屏，和主流播放器一致 */
    const screen = $('plScreen');
    if(screen) screen.addEventListener('dblclick', toggleFull);

    /* 切走 App 就暂停：翻到别的 App 之后视频还在响、又看不到画面，
     * 最容易让人以为「关不掉了」。 */
    window.addEventListener('openagi:app-mounted', e => {
      const who = (e && e.detail && e.detail.win) || '';
      if(who !== 'playerWin' && state.open) stopPlayback();
    });
    window.addEventListener('openagi:app-restored', e => {
      const who = (e && e.detail && e.detail.win) || '';
      if(who === 'playerWin') state.open = false;
    });

    /* 键盘：只在播放器是当前 App、且焦点不在输入框里时生效。
     * 不这么做的话，在对话里按空格会同时暂停视频和输出空格。 */
    document.addEventListener('keydown', e => {
      if(!state.open) return;
      const win = $('playerWin');
      if(!win || win.classList.contains('hidden')) return;
      const t = e.target;
      const tag = t && t.tagName ? String(t.tagName).toUpperCase() : '';
      if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      const k = e.key;
      if(k === ' ' || k === 'Spacebar'){ e.preventDefault(); togglePlay(); return; }
      if(k === 'ArrowRight'){ e.preventDefault(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); return; }
      if(k === 'ArrowLeft'){ e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); return; }
      if(k === 'PageDown'){ e.preventDefault(); next(); return; }
      if(k === 'PageUp'){ e.preventDefault(); prev(); return; }
      if(k === 'f' || k === 'F'){ e.preventDefault(); toggleFull(); return; }
      if(k === 'm' || k === 'M'){
        e.preventDefault();
        state.set.muted = !state.set.muted; saveSet(state.set); applySettings(); return;
      }
    });

    /* 关窗口前把进度写盘：直接关标签页/退出时不经过 pause 事件。 */
    window.addEventListener('beforeunload', () => markPos(true));

    if(hasLib && desktop.onMediaProgress) desktop.onMediaProgress(info => paintProgress(info));
  }

  let bound = false;
  function ensureBind(){
    if(bound) return;
    bound = true;
    bind();
    /* null 必须原样保留（= 全部），别写成 `|| ''` —— 那会把「全部」静默变成「只看散文件」。 */
    if(state.set.folder === undefined) state.set.folder = null;
    state.folder = state.set.folder;
    const win = $('playerWin');
    if(win) win.dataset.bound = '1';
  }

  function ready(){
    if($('playerWin')) { ensureBind(); applySettings(); }
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  window.playerApp = {
    open, close, refresh,
    playId, next, prev, togglePlay, toggleFull,
    hasLib: () => hasLib,
    files: () => allFiles(),
    state: () => ({ cur: state.cur ? { id: state.cur.id, name: state.cur.name } : null, folder: state.folder, idx: state.idx, queue: state.queue.length }),
    /* 纯逻辑导出：测试直接调，不用去碰 DOM */
    _pure: { fmtTime, fmtSizeMB, naturalCmp, queueOf, groupsOf, resumeAt, nextRate },
    _settings: () => state.set,
    _urlOf: urlOf
  };
})();
