/* 视频库 App
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
  const SORTS = ['name', 'time', 'size'];
  const SORT_LABEL = { name: '名称', time: '时间', size: '大小' };

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
    const def = { vol: 1, rate: 1, muted: false, folder: null, sort: 'name', sub: true };
    try{
      const raw = JSON.parse(localStorage.getItem(SET_KEY) || '{}') || {};
      return {
        vol: typeof raw.vol === 'number' && raw.vol >= 0 && raw.vol <= 1 ? raw.vol : def.vol,
        rate: RATES.indexOf(Number(raw.rate)) >= 0 ? Number(raw.rate) : def.rate,
        muted: !!raw.muted,
        folder: (raw.folder === null || typeof raw.folder === 'string') ? raw.folder : def.folder,
        sort: SORTS.indexOf(raw.sort) >= 0 ? raw.sort : def.sort,
        sub: raw.sub !== false
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
    sub: null,          // 当前这一集匹配到的 .vtt（没有则为 null）
    queue: [],
    idx: -1,
    pos: loadPos(),
    set: loadSet(),
    search: '',
    sort: 'name',
    listSig: '',
    selId: '',          // F2 / Delete 的目标：右键或点过的那一行
    ctxId: '',          // 文件操作菜单指向的条目
    root: '',           // 媒体库目录（用于提示与「打开目录」）
    jobId: '',
    downloading: false,
    tick: 0,
    error: '',
    scrubbing: false,
    helpOpen: false,
    idleTimer: 0,
    osdTimer: 0,
    clickTimer: 0
  };
  state.sort = state.set.sort || 'name';

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

  /* 可见队列 = 分组 + 搜索 + 排序。next / prev / 列表都按它来，
     这样用户在搜索框里筛出三集时，「下一集」不会跳到被筛掉的那一集。 */
  function filteredQueue(){
    const q = queueOf(allFiles(), state.folder);
    const kw = String(state.search || '').trim().toLowerCase();
    let out = kw ? q.filter(f => String(f.name || '').toLowerCase().indexOf(kw) >= 0) : q;
    if(state.sort === 'time'){
      out = out.slice().sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0) || naturalCmp(a.name, b.name));
    }else if(state.sort === 'size'){
      out = out.slice().sort((a, b) => (Number(b.sizeMB) || 0) - (Number(a.sizeMB) || 0) || naturalCmp(a.name, b.name));
    }
    return out;
  }

  /* 同目录、同名的 .vtt 才算这一集的字幕。
     <track> 只认 WebVTT，.srt 挂上去是静默不显示——所以这里只挑 vtt。 */
  function subOf(item){
    if(!item) return null;
    const base = String(item.name || '').replace(/\.[^.]+$/, '').toLowerCase();
    const folder = item.folder || '';
    const list = allFiles().filter(f => f && f.kind === 'sub'
      && (f.folder || '') === folder
      && String(f.ext || '').toLowerCase() === 'vtt');
    const nameOf = f => String(f.name || '').replace(/\.[^.]+$/, '').toLowerCase();
    return list.find(f => nameOf(f) === base)
        || list.find(f => nameOf(f).indexOf(base) === 0)
        || null;
  }

  function renderList(){
    const host = $('plList');
    if(!host) return;
    const q = filteredQueue();
    state.queue = q;
    state.idx = state.cur ? q.findIndex(f => f.id === state.cur.id) : -1;
    /* 签名里必须有 cur.id 和 folder：这两样一变高亮就要动，
     * 但文件集合没变时不该整表重建（会丢滚动位置）。 */
    const sig = state.folder + '|' + state.search + '|' + state.sort + '|' + (state.cur ? state.cur.id : '') + '|' + q.map(f => f.id + ':' + f.size).join(',');
    if(sig === state.listSig) return;
    state.listSig = sig;
    if(!q.length){
      host.innerHTML = '<div class="pl-hint">'
        + (state.search ? ('没有匹配「' + esc(state.search) + '」的文件。') : '这个分组里没有可播的文件。')
        + '</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    q.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'pl-item' + (state.cur && state.cur.id === f.id ? ' is-cur' : '');
      row.dataset.id = f.id;
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      if(state.cur && state.cur.id === f.id) row.setAttribute('aria-current', 'true');
      row.title = f.name + (f.playable === false ? '（这个容器的编码浏览器一般解不了，可能黑屏）' : '');
      const pos = state.pos[f.id];
      const pct = (pos && pos.d > 5) ? Math.min(100, Math.round(pos.t / pos.d * 100)) : 0;
      row.innerHTML =
        '<span class="pl-no">' + (i + 1) + '</span>' +
        '<span class="pl-row">' +
          '<span class="pl-nm">' + esc(f.name) + (f.playable === false ? '<i class="pl-warn" title="可能不支持">!</i>' : '') + '</span>' +
          '<span class="pl-sub">' +
            '<span class="pl-tag">' + esc(String(f.ext || (f.kind === 'audio' ? 'audio' : 'video')).toUpperCase()) + '</span>' +
            '<span class="pl-meta">' + fmtSizeMB(f.sizeMB) + '</span>' +
            (pct ? '<span class="pl-state">已看 ' + pct + '%</span>' : '') +
          '</span>' +
        '</span>' +
        '<button type="button" class="pl-more" title="更多操作" aria-label="更多操作">⋯</button>' +
        (pct ? '<span class="pl-done" style="width:' + pct + '%"></span>' : '');
      row.addEventListener('click', e => {
        if(e.target.closest('.pl-more') || e.target.closest('.pl-rename-in')) return;
        state.selId = f.id;
        paintSel();
        playId(f.id);
      });
      row.addEventListener('contextmenu', e => {
        e.preventDefault();
        state.selId = f.id;
        paintSel();
        openCtx(f.id, e.clientX, e.clientY);
      });
      row.addEventListener('keydown', e => {
        if(e.key === 'Enter'){ e.preventDefault(); playId(f.id); }
      });
      const more = row.querySelector('.pl-more');
      if(more){
        more.addEventListener('click', e => {
          e.stopPropagation();
          state.selId = f.id;
          paintSel();
          const r = more.getBoundingClientRect();
          openCtx(f.id, r.left - 150, r.bottom + 4);
        });
      }
      frag.appendChild(row);
    });
    host.innerHTML = '';
    host.appendChild(frag);
    paintSel();
    /* 当前项滚进视野：换集之后列表要跟着走，否则用户看不到自己播到第几集。 */
    const cur = host.querySelector('.pl-item.is-cur');
    if(cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'nearest' });
  }

  function paintSel(){
    const host = $('plList');
    if(!host) return;
    host.querySelectorAll('.pl-item').forEach(el => {
      el.classList.toggle('is-sel', !!state.selId && el.dataset.id === state.selId);
    });
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
   * 放在同一行而不是两处。搜索时前面多一段「匹配」。 */
  function renderCount(){
    const el = $('plCount');
    if(!el) return;
    const all = allFiles().filter(f => f && (f.kind === 'video' || f.kind === 'audio'));
    const n = filteredQueue().length;
    if(!all.length){ el.textContent = ''; return; }
    const mb = all.reduce((s, f) => s + (Number(f.sizeMB) || 0), 0);
    el.textContent = (state.search ? ('匹配 ' + n + ' / ') : (n + ' / ')) + all.length + ' 个 · ' + fmtSizeMB(mb);
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
    const acts = box.querySelector('.pl-empty-acts');
    if(!mode){ box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if(acts) acts.classList.toggle('hidden', mode === 'error');
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

  /* 舞台顶栏：当前这一集叫什么、属于哪个分组、多大。
   * 播放器里最容易迷路的就是「我在看第几集」——标题只写在列表里的话，
   * 全屏之后就没有任何地方能确认了。 */
  function renderHead(){
    const t = $('plHeadTitle');
    const s = $('plHeadSub');
    const k = $('plHeadKind');
    const z = $('plHeadSize');
    const item = state.cur;
    if(t) t.textContent = item ? item.name : '未选择媒体';
    if(s){
      if(!item){
        s.textContent = '从右侧列表选一集开始播放';
      }else{
        const parts = [];
        if(item.folder) parts.push(item.folder);
        if(item.kind === 'audio') parts.push('音频');
        const pos = state.pos[item.id];
        if(pos && pos.t > 10) parts.push('上次看到 ' + fmtTime(pos.t));
        s.textContent = parts.join(' · ') || '本地媒体';
      }
    }
    if(k) k.textContent = item ? (item.kind === 'audio' ? '音频' : '视频') : '视频';
    if(z) z.textContent = item ? fmtSizeMB(item.sizeMB) : '—';
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

  function paintFull(){
    const b = $('plFull');
    if(!b) return;
    const on = !!document.fullscreenElement;
    const full = b.querySelector('.pl-ico-full');
    const exit = b.querySelector('.pl-ico-exit');
    if(full) full.classList.toggle('hidden', on);
    if(exit) exit.classList.toggle('hidden', !on);
    b.setAttribute('aria-label', on ? '退出全屏' : '全屏');
    b.title = on ? '退出全屏（F）' : '全屏（F）';
  }

  function paintSeek(t, d){
    const fill = $('plSeekFill');
    const seek = $('plSeek');
    const pct = d ? Math.max(0, Math.min(1, t / d)) : 0;
    if(fill) fill.style.width = (pct * 100).toFixed(2) + '%';
    if(seek && !state.scrubbing && document.activeElement !== seek){
      seek.value = String(Math.round(pct * 1000));
    }
  }

  function paintBuffer(){
    const v = $('plVideo');
    const buf = $('plSeekBuf');
    if(!v || !buf) return;
    const d = isFinite(v.duration) ? v.duration : 0;
    let end = 0;
    try{ if(v.buffered && v.buffered.length) end = v.buffered.end(v.buffered.length - 1); }catch(e){}
    buf.style.width = d ? (Math.min(100, end / d * 100)).toFixed(1) + '%' : '0%';
  }

  function paintTime(){
    const v = $('plVideo');
    const t = $('plTime');
    if(!v || !t) return;
    const d = isFinite(v.duration) ? v.duration : 0;
    t.textContent = fmtTime(v.currentTime) + ' / ' + (d ? fmtTime(d) : '--:--');
    paintSeek(v.currentTime, d);
  }

  function paintCc(){
    const b = $('plCc');
    if(!b) return;
    const has = !!state.sub;
    const on = has && !!state.set.sub;
    b.disabled = !has;
    b.classList.toggle('is-on', on);
    b.classList.toggle('is-off', !on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = has ? ('字幕（C）· ' + (on ? '开' : '关')) : '这一集没有 .vtt 字幕';
  }

  function paintSearch(){
    const x = $('plSearchX');
    if(x) x.classList.toggle('hidden', !state.search);
  }

  function renderSort(){
    const b = $('plSort');
    if(b) b.textContent = SORT_LABEL[state.sort] || '名称';
  }

  function applySettings(){
    const v = $('plVideo');
    if(!v) return;
    v.volume = state.set.vol;
    v.muted = state.set.muted;
    v.playbackRate = state.set.rate;
    const vol = $('plVol');
    const pct = Math.round(state.set.vol * 100);
    if(vol){
      vol.value = String(pct);
      vol.style.setProperty('--v', pct + '%');
    }
    const rate = $('plRate');
    if(rate) rate.textContent = state.set.rate + '×';
    const menu = $('plRateMenu');
    if(menu){
      menu.querySelectorAll('[data-rate]').forEach(b => {
        b.classList.toggle('is-on', Number(b.dataset.rate) === Number(state.set.rate));
      });
    }
    const mute = $('plMute');
    if(mute){
      const wave = mute.querySelector('.pl-ico-wave');
      const muteIco = mute.querySelector('.pl-ico-mute');
      const off = state.set.muted || state.set.vol <= 0;
      if(wave) wave.classList.toggle('hidden', off);
      if(muteIco) muteIco.classList.toggle('hidden', !off);
    }
    syncSubMode();
  }

  function syncSubMode(){
    const v = $('plVideo');
    if(!v) return;
    const mode = state.set.sub ? 'showing' : 'hidden';
    const tracks = v.textTracks || [];
    for(let i = 0; i < tracks.length; i++){
      try{ tracks[i].mode = mode; }catch(e){}
    }
    paintCc();
  }

  /* 把同名的 .vtt 挂到 <video> 上。这里不缓存 track 节点：
     每次换集都重建一遍，比「改了 src 却忘了换字幕」可靠得多。 */
  function attachSub(item){
    const v = $('plVideo');
    if(!v) return null;
    const old = v.querySelectorAll('track');
    for(let i = 0; i < old.length; i++) old[i].remove();
    state.sub = subOf(item);
    if(state.sub){
      const tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.label = '中文';
      tr.srclang = 'zh';
      tr.default = true;
      tr.src = urlOf({ id: state.sub.id });
      tr.addEventListener('load', () => syncSubMode());
      v.appendChild(tr);
    }
    syncSubMode();
    return state.sub;
  }

  /* OSD：倍速 / 音量 / 快进这几类「按了但画面上看不出来」的操作，
     给一个会自己消失的提示，省得用户以为没生效。 */
  function osd(txt){
    const el = $('plOsd');
    if(!el) return;
    el.textContent = txt;
    el.classList.add('show');
    clearTimeout(state.osdTimer);
    state.osdTimer = setTimeout(() => el.classList.remove('show'), 1100);
  }

  /* 全屏播放时鼠标静止两秒半就把顶栏和控制条收起来（光标也一起藏），
     动一下鼠标立刻回来。只在全屏生效：窗口形态下藏控制条只会让人找不到按钮。 */
  function armIdle(){
    const stage = $('plStage');
    if(!stage) return;
    stage.classList.remove('is-idle');
    clearTimeout(state.idleTimer);
    const v = $('plVideo');
    state.idleTimer = setTimeout(() => {
      if(document.fullscreenElement === stage && v && !v.paused && !state.scrubbing && !state.helpOpen){
        stage.classList.add('is-idle');
      }
    }, 2600);
  }

  function closeRateMenu(){
    const m = $('plRateMenu');
    const b = $('plRate');
    if(m) m.classList.add('hidden');
    if(b) b.setAttribute('aria-expanded', 'false');
  }

  function toggleRateMenu(){
    const m = $('plRateMenu');
    const b = $('plRate');
    if(!m) return;
    const on = m.classList.contains('hidden');
    m.classList.toggle('hidden', !on);
    if(b) b.setAttribute('aria-expanded', on ? 'true' : 'false');
  }

  function setRate(r){
    const n = Number(r);
    if(RATES.indexOf(n) < 0) return;
    state.set.rate = n;
    saveSet(state.set);
    applySettings();
    closeRateMenu();
    osd(n + '×');
  }

  function setSearch(v){
    state.search = String(v == null ? '' : v);
    state.listSig = '';
    paintSearch();
    renderList();
    renderCount();
  }

  function cycleSort(){
    const i = SORTS.indexOf(state.sort);
    state.sort = SORTS[(i + 1) % SORTS.length];
    state.set.sort = state.sort;
    saveSet(state.set);
    renderSort();
    renderList();
    renderCount();
    osd('按' + (SORT_LABEL[state.sort] || '名称') + '排序');
  }

  function seekBy(sec){
    const v = $('plVideo');
    if(!v || !isFinite(v.duration) || !v.duration) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + sec));
    paintTime();
    osd((sec > 0 ? '+' : '−') + Math.abs(sec) + ' 秒');
  }

  function toggleSub(){
    if(!state.sub){ osd('这一集没有 .vtt 字幕'); return; }
    state.set.sub = !state.set.sub;
    saveSet(state.set);
    syncSubMode();
    osd(state.set.sub ? '字幕开' : '字幕关');
  }

  function toggleMute(){
    state.set.muted = !state.set.muted;
    saveSet(state.set);
    applySettings();
    osd(state.set.muted ? '已静音' : '取消静音');
  }

  function changeVol(delta){
    state.set.vol = Math.max(0, Math.min(1, Math.round((state.set.vol + delta) * 100) / 100));
    if(state.set.vol > 0) state.set.muted = false;
    saveSet(state.set);
    applySettings();
    osd('音量 ' + Math.round(state.set.vol * 100) + '%');
  }

  function togglePip(){
    const v = $('plVideo');
    if(!v) return;
    if(document.pictureInPictureElement){
      if(document.exitPictureInPicture) document.exitPictureInPicture().catch(() => {});
      return;
    }
    if(v.requestPictureInPicture){
      v.requestPictureInPicture().catch(err => {
        setError('画中画启动失败：' + ((err && err.message) || err));
      });
    }
  }

  function toggleHelp(force){
    const h = $('plHelp');
    if(!h) return;
    const on = typeof force === 'boolean' ? force : h.classList.contains('hidden');
    state.helpOpen = on;
    h.classList.toggle('hidden', !on);
    if(on){
      const stage = $('plStage');
      if(stage) stage.classList.remove('is-idle');
    }
  }

  /* ---- 列表文件操作：重命名 / 定位 / 移到回收站 ----
   * 写磁盘必须走主进程，所以这些入口在浏览器降级里会自己收起来（只剩播放 / 复制名）。
   * 重命名是「同一目录内改名」：不允许借改名把文件搬出媒体库。 */
  function findById(id){
    return allFiles().find(f => f.id === id) || null;
  }
  function canWrite(item){
    return hasLib && !!item && !item.url && typeof desktop.mediaRename === 'function';
  }
  function canRemove(item){
    return hasLib && !!item && !item.url && typeof desktop.mediaRemove === 'function';
  }

  function openCtx(id, x, y){
    const el = $('plCtx');
    const item = findById(id);
    if(!el || !item) return;
    state.ctxId = id;
    const write = canWrite(item);
    const removable = canRemove(item);
    const reveal = hasLib && !item.url && typeof desktop.mediaReveal === 'function';
    el.querySelectorAll('[data-act]').forEach(b => {
      const act = b.dataset.act;
      const show = act === 'rename' ? write
        : act === 'remove' ? removable
        : act === 'reveal' ? reveal
        : true;
      b.classList.toggle('hidden', !show);
    });
    const sep = el.querySelector('.pl-ctx-sep');
    if(sep) sep.classList.toggle('hidden', !removable);
    /* 挂到 body 上：App 页有 translate 动画（#deskPageApps 带 transform），
     * 在它内部 position:fixed 会以那个变换元素为基准，坐标整体偏移、菜单跑到屏幕外。
     * 菜单是瞬时浮层，挂在 body 下才是真正相对视口定位。 */
    if(el.parentElement !== document.body) document.body.appendChild(el);
    el.classList.remove('hidden');
    /* 先显示再量宽高，贴边时往回收，别让菜单探出窗口 */
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    el.style.left = Math.round(Math.max(8, Math.min(x, vw - r.width - 8))) + 'px';
    el.style.top = Math.round(Math.max(8, Math.min(y, vh - r.height - 8))) + 'px';
    const first = el.querySelector('.pl-ctx-i:not(.hidden)');
    if(first) first.focus();
  }
  function closeCtx(){
    const el = $('plCtx');
    if(el) el.classList.add('hidden');
    state.ctxId = '';
  }

  let dialogOk = null;
  function openDialog(o){
    const box = $('plDialog');
    if(!box) return;
    dialogOk = o && typeof o.onOk === 'function' ? o.onOk : null;
    const t = $('plDialogT');
    const s = $('plDialogS');
    const ok = $('plDialogOk');
    if(t) t.textContent = (o && o.title) || '';
    if(s) s.textContent = (o && o.body) || '';
    if(ok){
      ok.textContent = (o && o.ok) || '确定';
      ok.classList.toggle('danger', !o || o.danger !== false);
    }
    box.classList.remove('hidden');
    if(ok) ok.focus();
  }
  function closeDialog(){
    const box = $('plDialog');
    if(box) box.classList.add('hidden');
    dialogOk = null;
  }
  async function runDialogOk(){
    const fn = dialogOk;
    const ok = $('plDialogOk');
    if(!fn){ closeDialog(); return; }
    if(ok && ok.disabled) return;
    if(ok){ ok.disabled = true; ok.textContent = '处理中…'; }
    try{
      const keep = await fn();
      if(keep !== false) closeDialog();
    }catch(e){
      osd('操作失败：' + ((e && e.message) || e));
    }finally{
      if(ok){ ok.disabled = false; ok.textContent = '移到回收站'; }
    }
  }

  /* 行内改名：直接把名字变成输入框，回车提交、Esc 取消、失焦也算提交。
   * 不用弹窗——文件名就在眼前，弹窗会把「改哪一个」的信息遮掉。 */
  function beginRename(id){
    const item = findById(id);
    if(!item) return;
    if(!canWrite(item)){
      osd(hasLib ? '这个条目不能改名' : '浏览器里只能播放，改名请在桌面版使用');
      return;
    }
    const host = $('plList');
    if(!host) return;
    let row = null;
    host.querySelectorAll('.pl-item').forEach(el => { if(el.dataset.id === id) row = el; });
    if(!row) return;
    const nm = row.querySelector('.pl-nm');
    if(!nm || row.querySelector('.pl-rename-in')) return;
    closeCtx();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pl-rename-in';
    input.value = item.name;
    input.setAttribute('aria-label', '重命名');
    nm.classList.add('hidden');
    nm.after(input);
    input.focus();
    /* 只选中主文件名，扩展名留着不动：改标题的人远多于改格式的人 */
    const dot = item.name.lastIndexOf('.');
    try{ input.setSelectionRange(0, dot > 0 ? dot : item.name.length); }catch(e){}
    let done = false;
    const finish = commit => {
      if(done) return;
      done = true;
      const val = input.value;
      input.remove();
      nm.classList.remove('hidden');
      if(commit) doRename(item, val);
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();          // 输入框里的空格 / Delete 不该触发全局快捷键
      if(e.key === 'Enter'){ e.preventDefault(); finish(true); }
      else if(e.key === 'Escape'){ e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function doRename(item, name){
    const val = String(name == null ? '' : name).trim();
    if(!val || val === item.name) return;
    const oldId = item.id;
    const v = $('plVideo');
    const wasCur = !!(state.cur && state.cur.id === oldId);
    const wasPlaying = !!(wasCur && v && !v.paused);
    markPos();
    let r;
    try{
      r = await desktop.mediaRename(oldId, val);
    }catch(e){
      r = { ok: false, message: (e && e.message) || String(e) };
    }
    if(!r || r.ok === false){
      osd('重命名失败：' + ((r && r.message) || '未知原因'));
      beginRename(oldId);          // 把输入框放回去，别让用户重打一遍
      return;
    }
    if(r.unchanged){ osd('文件名没有变化'); return; }
    /* 进度按 id 存，改名后必须跟着搬，否则这一集的「已看」和续播点会丢。 */
    if(r.id && r.id !== oldId && state.pos[oldId]){
      state.pos[r.id] = state.pos[oldId];
      delete state.pos[oldId];
      savePos(state.pos);
    }
    if(wasCur) state.cur = Object.assign({}, state.cur, { id: r.id, name: r.name });
    if(state.selId === oldId) state.selId = r.id || oldId;
    state.listSig = '';
    await refresh();
    if(wasCur && r.id){
      /* 路径变了，<video> 必须换 src 重开；playId 会按搬过来的进度续上。 */
      playId(r.id);
      if(!wasPlaying){
        /* 原来就是暂停态：重开之后立刻停住，别因为换了 src 自己播起来 */
        const vv = $('plVideo');
        if(vv) vv.addEventListener('loadedmetadata', () => { try{ vv.pause(); }catch(e){} }, { once: true });
      }
    }else if(state.cur){
      /* 字幕可能跟着改了名，重新匹配一次 */
      attachSub(state.cur);
    }
    osd('已重命名为 ' + r.name);
  }

  function askRemove(id){
    const item = findById(id);
    if(!item) return;
    if(!canRemove(item)){
      osd(hasLib ? '这个条目不能删除' : '浏览器里只能播放，删除请在桌面版使用');
      return;
    }
    closeCtx();
    openDialog({
      title: '移到回收站？',
      body: '「' + item.name + '」会从磁盘移入系统回收站，之后可以在回收站里还原。',
      ok: '移到回收站',
      danger: true,
      onOk: async () => {
        /* 正在播的文件先松手：Windows 上被占用的文件删不掉。 */
        if(state.cur && state.cur.id === item.id){
          stopPlayback();
          const v = $('plVideo');
          if(v){ v.removeAttribute('src'); v.load(); }
          state.cur = null;
          state.sub = null;
          paintCc();
          const stage = $('plStage');
          if(stage) stage.classList.remove('has-media');
          renderHead();
          paintPlayIcon(false);
        }
        const r = await desktop.mediaRemove([item.id]);
        if(r && r.ok === false){
          osd('删除失败：' + ((r && r.message) || '未知原因'));
          return false;
        }
        delete state.pos[item.id];
        savePos(state.pos);
        if(state.selId === item.id) state.selId = '';
        state.files = state.files.filter(f => f.id !== item.id);
        state.listSig = '';
        await refresh();
        if(state.cur) attachSub(state.cur);
        osd(r && r.trashed === false ? '已删除' : '已移到回收站');
        return true;
      }
    });
  }

  async function copyName(id){
    const item = findById(id);
    if(!item) return;
    try{
      await navigator.clipboard.writeText(item.name);
      osd('已复制文件名');
    }catch(e){
      /* 剪贴板权限在 app:// 下偶尔会被拒，退回 execCommand */
      const ta = document.createElement('textarea');
      ta.value = item.name;
      document.body.appendChild(ta);
      ta.select();
      try{ document.execCommand('copy'); osd('已复制文件名'); }
      catch(_){ osd('复制失败'); }
      ta.remove();
    }
  }

  async function revealItem(id){
    if(!(hasLib && typeof desktop.mediaReveal === 'function')) return;
    try{
      const r = await desktop.mediaReveal(id);
      if(r && r.ok === false) osd('定位失败：' + ((r && r.message) || ''));
    }catch(e){
      osd('定位失败：' + ((e && e.message) || e));
    }
  }

  /* 真正切集。所有入口（点列表、上一集/下一集、自动续播、导入后立刻播）
   * 都从这里进，避免出现「点列表和点下一集行为不一样」的分叉。 */
  function playId(id){
    const q = filteredQueue();
    const item = q.find(f => f.id === id) || allFiles().find(f => f.id === id);
    if(!item) return false;
    const v = $('plVideo');
    if(!v) return false;
    markPos();                       // 换集前把上一集的进度落盘
    state.cur = item;
    state.queue = q;
    state.idx = q.findIndex(f => f.id === item.id);
    const stage = $('plStage');
    if(stage) stage.classList.add('has-media');

    const url = urlOf(item);
    if(!url){ setError('这条记录没有可用的地址'); return false; }
    clearError();
    /* 空态立刻收起（不等 loadedmetadata）：解不了的文件不会有那个事件。 */
    setEmpty(null);
    v.src = url;
    attachSub(item);
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
    renderHead();
    renderList();
    paintTime();
    paintBuffer();
    return true;
  }

  function step(delta){
    const q = state.queue.length ? state.queue : filteredQueue();
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
      renderHead();
      /* 正在播的那一集如果被外部删了：停下来并把空态说清楚，
       * 而不是让 <video> 自己报一个看不懂的 MEDIA_ERR。 */
      if(had && !state.files.some(f => f.id === had.id) && !state.local.some(f => f.id === had.id)){
        if(v){ v.pause(); v.removeAttribute('src'); v.load(); }
        const tr = v ? v.querySelectorAll('track') : [];
        for(let i = 0; i < tr.length; i++) tr[i].remove();
        state.cur = null;
        state.sub = null;
        paintCc();
        const stage = $('plStage');
        if(stage) stage.classList.remove('has-media');
        state.listSig = '';
        renderList();
        renderCount();
        renderHead();
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
    /* 搜索框还停在上一轮的词上时，新导入的文件会被筛掉——用户看到的是「导了但没进来」。
       所以导入后清空搜索，并回到「全部」。 */
    state.search = '';
    const search = $('plSearch');
    if(search) search.value = '';
    paintSearch();
    state.folder = null;
    state.set.folder = null;
    saveSet(state.set);
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
    const meta = (typeof DESK_APP_META !== 'undefined' && DESK_APP_META.player) || { title: '视频库', sub: '本地的视频与音频' };
    /* 已经 mount 过就别再调一次：deskMountApp 内部会 deskSkelHide()，
     * 在延迟加载批次里重复调等于把骨架提前撤掉，App 页会空一下。 */
    const mounted = win.parentElement && win.parentElement.id === 'deskAppHost';
    if(!mounted && typeof deskMountApp === 'function') deskMountApp(win, meta.title, meta.sub);
    else win.classList.remove('hidden');
    state.open = true;
    ensureBind();
    applySettings();
    renderSort();
    paintSearch();
    paintFull();
    renderHead();
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
    const stage = $('plStage');
    if(stage) stage.classList.remove('is-idle');
    clearTimeout(state.idleTimer);
  }

  function close(){
    stopPlayback();
    state.open = false;
    closeRateMenu();
    toggleHelp(false);
    const win = $('playerWin');
    if(!win) return;
    /* 走 desk-shell.js 的统一关闭入口：正显示在 App 页里的走翻页返回，
     * 否则只隐藏。自己判 parentElement 会在「刚点开就被关掉」那一瞬判错。 */
    if(typeof deskCloseWin === 'function') deskCloseWin(win);
    else win.classList.add('hidden');
  }

  function toggleFull(){
    /* 全屏的是整块舞台，不是画面：这样顶栏（我在看第几集）和控制条才能一起进全屏。
       只全屏 <video> 的话，全屏之后进度条和字幕按钮全没了。 */
    const stage = $('plStage');
    if(!stage) return;
    if(document.fullscreenElement){
      document.exitFullscreen().catch(() => {});
      return;
    }
    if(stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
  }

  function togglePlay(){
    const v = $('plVideo');
    if(!v) return;
    if(!state.cur){
      const q = filteredQueue();
      if(q.length){ playId(q[0].id); return; }
      return;
    }
    if(v.paused){ v.play().catch(() => {}); } else { v.pause(); }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind(){
    const v = $('plVideo');
    if(!v) return;

    v.addEventListener('play', () => {
      paintPlayIcon(true);
      const stage = $('plStage');
      if(stage) stage.classList.remove('is-idle');
      armIdle();
    });
    v.addEventListener('pause', () => {
      paintPlayIcon(false);
      markPos();
      const stage = $('plStage');
      if(stage) stage.classList.remove('is-idle');
      clearTimeout(state.idleTimer);
    });
    v.addEventListener('timeupdate', () => {
      paintTime();
      /* 每 3 秒落一次进度：timeupdate 一秒好几次，每次都写 localStorage
       * 会在长片上变成持续的同步写盘（主线程卡顿）。 */
      if(++state.tick % 3 === 0) markPos();
    });
    v.addEventListener('progress', paintBuffer);
    v.addEventListener('loadedmetadata', () => {
      paintTime();
      paintBuffer();
      clearError();
      setEmpty(null);
      renderHead();
    });
    v.addEventListener('emptied', () => {
      if(!state.cur) setEmpty('empty');
    });
    v.addEventListener('ended', () => {
      markPos(true);
      if(!next()){ paintPlayIcon(false); osd('播放结束'); }
    });
    v.addEventListener('error', () => {
      const code = v.error ? v.error.code : 0;
      const msg = code === 4 ? '这个文件的封装或编码解不了（mkv / avi / wmv / flv 常见）。转成 mp4(H.264+AAC) 就能播。'
        : code === 2 ? '读取中断，文件可能被移走或正在被其他程序占用。'
        : code === 3 ? '解码出错，文件可能不完整。'
        : '视频库报错（' + code + '）。';
      setError(msg);
      paintPlayIcon(false);
    });
    v.addEventListener('enterpictureinpicture', () => {
      const b = $('plPip');
      if(b) b.classList.add('is-on');
    });
    v.addEventListener('leavepictureinpicture', () => {
      const b = $('plPip');
      if(b) b.classList.remove('is-on');
    });

    const bindClick = (id, fn) => { const el = $(id); if(el) el.addEventListener('click', fn); };
    bindClick('plPlay', togglePlay);
    bindClick('plPrev', prev);
    bindClick('plNext', next);
    bindClick('plBack10', () => seekBy(-10));
    bindClick('plFwd10', () => seekBy(10));
    bindClick('plFull', toggleFull);
    bindClick('plPip', togglePip);
    bindClick('plMute', toggleMute);
    bindClick('plRate', toggleRateMenu);
    bindClick('plCc', toggleSub);
    bindClick('plHelpBtn', () => toggleHelp(true));
    bindClick('plHelpX', () => toggleHelp(false));
    bindClick('plEmptyImport', () => doImport('file'));
    bindClick('plEmptyDir', () => doImport('dir'));
    bindClick('plImport', () => doImport('file'));
    bindClick('plImportDir', () => doImport('dir'));
    bindClick('plDlOpen', () => { const b = $('plDl'); if(b && b.classList.contains('hidden')) showDl(); else hideDl(); });
    bindClick('plDlCancel', hideDl);
    bindClick('plDlGo', doDownload);
    bindClick('plProgX', () => { if(state.jobId && hasLib) desktop.mediaCancel(state.jobId); });
    bindClick('plDir', () => { if(hasLib && desktop.mediaOpenDir) desktop.mediaOpenDir(); });
    bindClick('plSort', cycleSort);
    bindClick('plSearchX', () => { const s = $('plSearch'); if(s) s.value = ''; setSearch(''); });
    bindClick('plDialogCancel', closeDialog);
    bindClick('plDialogOk', runDialogOk);
    bindClick('btnPlayerWinClose', close);

    /* 文件操作菜单：点外面 / 滚动列表 / 改窗口大小都收起来 */
    const ctx = $('plCtx');
    if(ctx){
      ctx.addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if(!b) return;
        const id = state.ctxId;
        const act = b.dataset.act;
        closeCtx();
        if(!id) return;
        if(act === 'play') playId(id);
        else if(act === 'rename') beginRename(id);
        else if(act === 'remove') askRemove(id);
        else if(act === 'reveal') revealItem(id);
        else if(act === 'copy') copyName(id);
      });
      ctx.addEventListener('contextmenu', e => e.preventDefault());
    }
    const listEl = $('plList');
    if(listEl) listEl.addEventListener('scroll', closeCtx);
    window.addEventListener('resize', closeCtx);
    document.addEventListener('pointerdown', e => {
      const el = $('plCtx');
      if(!el || el.classList.contains('hidden')) return;
      if(e.target && typeof e.target.closest === 'function' && e.target.closest('#plCtx')) return;
      closeCtx();
    });

    const dlg = $('plDialog');
    if(dlg){
      dlg.addEventListener('click', e => { if(e.target === dlg) closeDialog(); });
    }

    const rateMenu = $('plRateMenu');
    if(rateMenu){
      rateMenu.querySelectorAll('[data-rate]').forEach(b => {
        b.addEventListener('click', () => setRate(b.dataset.rate));
      });
    }

    const seek = $('plSeek');
    if(seek){
      seek.addEventListener('input', () => {
        const d = v.duration;
        if(!d || !isFinite(d)) return;
        v.currentTime = Number(seek.value) / 1000 * d;
        paintSeek(v.currentTime, d);
      });
      seek.addEventListener('change', () => { state.scrubbing = false; });
      seek.addEventListener('pointerdown', () => { state.scrubbing = true; });
      window.addEventListener('pointerup', () => { state.scrubbing = false; });
    }

    /* 进度条悬停提示：先告诉你松手会跳到哪一秒，再决定要不要点。 */
    const wrap = $('plSeekWrap');
    const tip = $('plSeekTip');
    if(wrap && tip){
      const move = e => {
        const r = wrap.getBoundingClientRect();
        if(!r.width) return;
        const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const d = isFinite(v.duration) ? v.duration : 0;
        tip.textContent = fmtTime(ratio * d);
        /* 两端各留 16px，否则气泡会有一半探到舞台外面去 */
        tip.style.left = Math.round(Math.max(16, Math.min(r.width - 16, ratio * r.width))) + 'px';
        tip.classList.add('show');
      };
      wrap.addEventListener('mousemove', move);
      wrap.addEventListener('mouseleave', () => tip.classList.remove('show'));
    }

    const search = $('plSearch');
    if(search){
      search.addEventListener('input', () => setSearch(search.value));
      search.addEventListener('keydown', e => {
        if(e.key === 'Escape'){ search.value = ''; setSearch(''); search.blur(); }
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

    /* 点画面 = 播放 / 暂停，双击 = 全屏。单击必须等 220ms 再执行，
       否则双击会先触发两次「暂停 → 播放」，画面看着像没反应。 */
    const screen = $('plScreen');
    if(screen){
      screen.addEventListener('click', e => {
        if(e.target.closest('button, input, .pl-help, .pl-empty')) return;
        clearTimeout(state.clickTimer);
        state.clickTimer = setTimeout(() => { state.clickTimer = 0; togglePlay(); }, 220);
      });
      screen.addEventListener('dblclick', e => {
        if(e.target.closest('button, input, .pl-help')) return;
        clearTimeout(state.clickTimer);
        state.clickTimer = 0;
        toggleFull();
      });
    }

    const stage = $('plStage');
    if(stage){
      stage.addEventListener('mousemove', armIdle);
      stage.addEventListener('mouseleave', () => {
        if(document.fullscreenElement === stage && !v.paused) stage.classList.add('is-idle');
      });
    }

    const help = $('plHelp');
    if(help){
      help.addEventListener('click', e => {
        if(e.target === help || e.target.closest('#plHelpX')) toggleHelp(false);
      });
    }

    /* 点空白处收起倍速菜单（点在菜单自身或倍速按钮上时不收）。 */
    document.addEventListener('click', e => {
      const t = e.target;
      if(!t || typeof t.closest !== 'function' || !t.closest('.pl-pop')) closeRateMenu();
    });

    document.addEventListener('fullscreenchange', () => {
      paintFull();
      armIdle();
    });

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
      if(k === 'ArrowRight'){ e.preventDefault(); seekBy(5); return; }
      if(k === 'ArrowLeft'){ e.preventDefault(); seekBy(-5); return; }
      if(k === 'ArrowUp'){ e.preventDefault(); changeVol(0.05); return; }
      if(k === 'ArrowDown'){ e.preventDefault(); changeVol(-0.05); return; }
      if(k === 'PageDown'){ e.preventDefault(); next(); return; }
      if(k === 'PageUp'){ e.preventDefault(); prev(); return; }
      if(k === 'j' || k === 'J'){ e.preventDefault(); seekBy(-10); return; }
      if(k === 'l' || k === 'L'){ e.preventDefault(); seekBy(10); return; }
      if(k === 'f' || k === 'F'){ e.preventDefault(); toggleFull(); return; }
      if(k === 'm' || k === 'M'){ e.preventDefault(); toggleMute(); return; }
      if(k === 'c' || k === 'C'){ e.preventDefault(); toggleSub(); return; }
      if(k === '<' || k === ',' ){ e.preventDefault(); setRate(RATES[Math.max(0, RATES.indexOf(state.set.rate) - 1)] || 0.5); return; }
      if(k === '>' || k === '.'){ e.preventDefault(); setRate(nextRate(state.set.rate)); return; }
      if(k === 'F2'){
        e.preventDefault();
        const id = state.selId || (state.cur && state.cur.id);
        if(id) beginRename(id);
        else osd('先在列表里选一集');
        return;
      }
      if(k === 'Delete'){
        e.preventDefault();
        const id = state.selId || (state.cur && state.cur.id);
        if(id) askRemove(id);
        else osd('先在列表里选一集');
        return;
      }
      if(k === '?'){ e.preventDefault(); toggleHelp(); return; }
      if(k === 'Escape'){
        closeRateMenu();
        closeCtx();
        if(state.helpOpen) toggleHelp(false);
        const box = $('plDialog');
        if(box && !box.classList.contains('hidden')){ closeDialog(); return; }
        return;
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
    seekBy, toggleSub, toggleHelp, setSearch, cycleSort, setRate,
    hasLib: () => hasLib,
    files: () => allFiles(),
    state: () => ({ cur: state.cur ? { id: state.cur.id, name: state.cur.name } : null, folder: state.folder, idx: state.idx, queue: state.queue.length }),
    /* 纯逻辑导出：测试直接调，不用去碰 DOM */
    _pure: { fmtTime, fmtSizeMB, naturalCmp, queueOf, groupsOf, resumeAt, nextRate, subOf },
    _settings: () => state.set,
    _urlOf: urlOf
  };
})();
