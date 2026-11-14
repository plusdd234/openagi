/* 剪辑台 —— 对标万兴喵影的时间线视频剪辑器。
 *
 * 定位：把「视频库」攒下来的素材，按时间线剪成一条能导出的片子。
 * 结构：素材池（导入 / 视频库）→ 四条轨道（主视频 / 画中画 / 文字 / 音频）
 *      → 预览（所见即所得）→ 导出（Canvas + MediaRecorder 实时渲染 WebM）。
 *
 * 三条要守的：
 *   ① 预览与导出共用同一份 project 数据，不做两套渲染逻辑；
 *   ② 所有拖拽都先快照再改，松手才落历史，撤销一次能整步回退；
 *   ③ 文件素材用 objectURL，只活在当前会话；重开项目时自动剔除，
 *      视频库素材走 openagi-media:// 才能跨会话恢复。
 *
 * 与视频库的关系：只通过 window.playerApp.files() / _urlOf() 读它的媒体清单，
 * 不碰 window.openagiDesktop（AGENTS.md 6.1 禁令）。
 */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  const SAVE_KEY = 'hf_studio_project_v1';
  const SNAP_KEY = 'hf_studio_snaps_v1';
  const SAVE_VER = 2;
  const SNAP_MAX = 5;
  const SNAP_MS = 5 * 60 * 1000;
  const RULER_H = 26;
  const MIN_CLIP = 0.1;
  const MAX_HIST = 80;
  const TRACK_ICON = {
    video: '<rect x="2.8" y="5.2" width="18.4" height="13.6" rx="2.4"/><path d="M6.6 5.2v13.6M17.4 5.2v13.6"/><path d="M10.2 9.8 14.8 12l-4.6 2.2V9.8Z" fill="currentColor" stroke="none"/>',
    text: '<path d="M5 5.4h14"/><path d="M12 5.4v13.2"/><path d="M9 18.6h6"/>',
    audio: '<path d="M4 10.2v3.6M7.2 7.6v8.8M10.4 5.4v13.2M13.6 8.4v7.2M16.8 6.4v11.2M20 9.4v5.2"/>'
  };
  const TRACK_PREFIX = { video: 'v', text: 't', audio: 'a' };
  const DEFAULT_TRACKS = [
    { id: 'v2', kind: 'video', name: '画中画' },
    { id: 'v1', kind: 'video', name: '主视频' },
    { id: 't1', kind: 'text', name: '文字' },
    { id: 'a1', kind: 'audio', name: '音频' }
  ];
  const KF_PROPS = ['opacity', 'scale', 'x', 'y', 'rot', 'volume'];
  const EASES = ['linear', 'easeIn', 'easeOut', 'easeInOut'];
  const FILTERS = [
    { id: 'none', name: '原片', css: 'none' },
    { id: 'warm', name: '暖阳', css: 'sepia(0.32) saturate(1.25) contrast(1.02)' },
    { id: 'cool', name: '冷调', css: 'hue-rotate(-10deg) saturate(1.15) brightness(1.02)' },
    { id: 'bw', name: '黑白', css: 'grayscale(1) contrast(1.06)' },
    { id: 'film', name: '胶片', css: 'sepia(0.38) contrast(1.14) saturate(0.88)' },
    { id: 'vivid', name: '鲜艳', css: 'saturate(1.45) contrast(1.1)' },
    { id: 'soft', name: '柔光', css: 'brightness(1.08) saturate(0.9) contrast(0.92)' },
    { id: 'high', name: '高反差', css: 'contrast(1.3) saturate(1.05)' }
  ];
  const TEXT_PRESETS = [
    { id: 'title', name: '大标题', note: '居中 · 64px · 白字', style: { size: 78, color: '#ffffff', bg: 'rgba(0,0,0,0)', bold: true, align: 'center' } },
    { id: 'sub', name: '副标题', note: '居中 · 40px · 半透明底', style: { size: 40, color: '#f2f5fa', bg: 'rgba(0,0,0,.45)', bold: false, align: 'center' } },
    { id: 'caption', name: '字幕条', note: '底部 · 36px · 深底', style: { size: 36, color: '#ffffff', bg: 'rgba(0,0,0,.62)', bold: false, align: 'center', y: 32 } },
    { id: 'quote', name: '金句', note: '居中 · 56px · 金色', style: { size: 56, color: '#f0b429', bg: 'rgba(0,0,0,.3)', bold: true, align: 'center' } }
  ];
  const RES_PRESETS = [
    { id: '1920x1080', name: '1920 × 1080（横屏 16:9）' },
    { id: '1280x720', name: '1280 × 720（横屏 16:9）' },
    { id: '1080x1920', name: '1080 × 1920（竖屏 9:16）' },
    { id: '1080x1080', name: '1080 × 1080（方形 1:1）' }
  ];

  /* ---------------- 小工具 ---------------- */
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round2 = (v) => Math.round(v * 100) / 100;
  let seq = 0;
  const uid = (p) => p + Date.now().toString(36) + (seq++).toString(36);
  const svgWrap = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  /* 统一的小图标库：24×24、currentColor，供轨道头 / 检查器 / 关键帧按钮复用。 */
  const ICON = {
    lock: '<rect x="5" y="10.2" width="14" height="9.8" rx="2.4"/><path d="M8.2 10.2V7.6a3.8 3.8 0 0 1 7.6 0v2.6"/>',
    mute: '<path d="M4 9.4h3.2L11 6.2v11.6L7.2 14.6H4z"/><path d="m15.2 10 4.4 4.4M19.6 10l-4.4 4.4"/>',
    sound: '<path d="M4 9.4h3.2L11 6.2v11.6L7.2 14.6H4z"/><path d="M14.6 9.4a4 4 0 0 1 0 5.2M17.2 7.2a7.4 7.4 0 0 1 0 9.6"/>',
    solo: '<path d="M4.4 13.2v-1a7.6 7.6 0 0 1 15.2 0v1"/><rect x="3.2" y="12.8" width="4" height="6.6" rx="2"/><rect x="16.8" y="12.8" width="4" height="6.6" rx="2"/>',
    eye: '<path d="M3.6 12S7 6.8 12 6.8 20.4 12 20.4 12 17 17.2 12 17.2 3.6 12 3.6 12Z"/><circle cx="12" cy="12" r="2.6"/>',
    eyeOff: '<path d="M3.6 12S7 6.8 12 6.8c1.2 0 2.3.3 3.3.8M20.4 12s-3.4 5.2-8.4 5.2c-1.2 0-2.3-.3-3.3-.8"/><path d="m4.4 4.4 15.2 15.2"/><path d="M10.4 10.4a2.3 2.3 0 0 0 3.2 3.2"/>',
    copy: '<rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2.2"/><path d="M15.6 5.4H6.6a2.2 2.2 0 0 0-2.2 2.2v9"/>',
    trash: '<path d="M4.8 6.8h14.4"/><path d="M9.6 6.8V4.6h4.8v2.2"/><path d="m6.6 6.8.9 12.4a1.8 1.8 0 0 0 1.8 1.7h5.4a1.8 1.8 0 0 0 1.8-1.7l.9-12.4"/><path d="M10.4 10.4v6.6M13.6 10.4v6.6"/>',
    rippleDel: '<path d="M4.8 6.8h11"/><path d="M9.6 6.8V4.6h4.8v2.2"/><path d="m6.4 6.8.8 12.4a1.8 1.8 0 0 0 1.8 1.7h3.2"/><path d="M19.4 14.4h-5.6M16.6 11.6v5.6"/>',
    eraser: '<path d="m4.6 14.6 7.2-8.2a2 2 0 0 1 3-.1l3.2 2.8a2 2 0 0 1 .1 3L11.4 20H7.2z"/><path d="M8.4 17.2h11.2"/>',
    film: '<rect x="2.8" y="5.2" width="12.4" height="13.6" rx="2.2"/><path d="M6.6 5.2v13.6M11.2 5.2v13.6"/><path d="M19 8.8v6.8M15.6 12.2H22"/>',
    text: '<path d="M4.6 5.4h9.6M9.4 5.4v13.2M7 18.6h4.8"/><path d="M19 8.8v6.8M15.6 12.2H22"/>',
    audio: '<path d="M3.2 10.4v3.2M6.4 8v8M9.6 5.6v12.8M12.8 8.8v6.4"/><path d="M19 8.8v6.8M15.6 12.2H22"/>',
    kfOpacity: '<circle cx="12" cy="12" r="7.4"/><path d="M12 4.6a7.4 7.4 0 0 1 0 14.8z" fill="currentColor" stroke="none"/>',
    kfScale: '<path d="M14 4.6h5.4V10M19.4 4.6 13.8 10.2M10 19.4H4.6V14M4.6 19.4l5.6-5.6"/>',
    kfX: '<path d="M4 12h16"/><path d="m7.4 8.4-3.4 3.6 3.4 3.6M16.6 8.4l3.4 3.6-3.4 3.6"/>',
    kfY: '<path d="M12 4v16"/><path d="m8.4 7.4 3.6-3.4 3.6 3.4M8.4 16.6l3.6 3.4 3.6-3.4"/>',
    kfRot: '<path d="M19 12a7 7 0 1 1-2.6-5.4"/><path d="M19.4 4.6v4.6h-4.6"/>',
    kfVolume: '<path d="M4 9.4h3.2L11 6.2v11.6L7.2 14.6H4z"/><path d="M14.6 9.4a4 4 0 0 1 0 5.2M17.2 7.2a7.4 7.4 0 0 1 0 9.6"/>'
  };
  const ico = (name) => svgWrap(ICON[name] || '');

  function fmtTc(sec, fps) {
    const t = Math.max(0, Number(sec) || 0);
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const f = Math.floor((t - Math.floor(t)) * (fps || 30));
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0') + '.' + String(f).padStart(2, '0');
  }
  function fmtMmss(sec) {
    const t = Math.max(0, Math.round(Number(sec) || 0));
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }
  function fmtDur(sec) {
    const t = Math.max(0, Number(sec) || 0);
    if (t < 60) return t.toFixed(1) + 's';
    return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
  }
  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
    if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
    return v + ' B';
  }
  function cssFilter(id) {
    const f = FILTERS.find((x) => x.id === id);
    return (f && f.css) || 'none';
  }

  /* ---------------- 项目模型（v2） ---------------- */
  function defaultTracks() {
    return DEFAULT_TRACKS.map(function (t) {
      return {
        id: t.id,
        kind: t.kind,
        name: t.name,
        locked: false,
        muted: false,
        solo: false,
        hidden: false,
        height: 46
      };
    });
  }

  function blankProject() {
    return {
      v: SAVE_VER,
      name: '未命名项目',
      w: 1920,
      h: 1080,
      fps: 30,
      sampleRate: 48000,
      media: [],
      tracks: defaultTracks(),
      clips: [],
      markers: [],
      meta: { createdAt: Date.now(), updatedAt: Date.now(), app: 'studio' }
    };
  }

  function normalizeKf(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    KF_PROPS.forEach(function (prop) {
      const arr = Array.isArray(raw[prop]) ? raw[prop] : [];
      const pts = arr.filter(function (k) {
        return k && isFinite(Number(k.t)) && isFinite(Number(k.v));
      }).map(function (k) {
        return {
          t: Math.max(0, round2(Number(k.t))),
          v: Number(k.v),
          ease: EASES.indexOf(k.ease) >= 0 ? k.ease : 'linear'
        };
      }).sort(function (a, b) { return a.t - b.t; });
      const uniq = [];
      pts.forEach(function (p) {
        if (uniq.length && Math.abs(uniq[uniq.length - 1].t - p.t) < 0.001) uniq[uniq.length - 1] = p;
        else uniq.push(p);
      });
      if (uniq.length) out[prop] = uniq.slice(0, 200);
    });
    return out;
  }

  function normalizeTracks(raw) {
    const src = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const out = [];
    src.forEach(function (t) {
      if (!t || !t.id) return;
      const id = String(t.id);
      const kind = t.kind === 'video' || t.kind === 'text' || t.kind === 'audio' ? t.kind : '';
      if (!kind || seen.has(id)) return;
      seen.add(id);
      out.push({
        id: id,
        kind: kind,
        name: String(t.name || ({ video: '视频', text: '文字', audio: '音频' })[kind]),
        locked: !!t.locked,
        muted: !!t.muted,
        solo: !!t.solo,
        hidden: !!t.hidden,
        height: clamp(Number(t.height) || 46, 32, 120)
      });
    });
    return out.length ? out : defaultTracks();
  }

  function normalizeMarkers(raw) {
    return (Array.isArray(raw) ? raw : []).filter(function (m) {
      return m && isFinite(Number(m.t));
    }).map(function (m, i) {
      return {
        t: Math.max(0, round2(Number(m.t))),
        name: String(m.name || ('标记 ' + (i + 1))),
        color: /^#[0-9a-f]{6}$/i.test(String(m.color || '')) ? String(m.color) : '#f0b429'
      };
    }).sort(function (a, b) { return a.t - b.t; });
  }

  /* v1 → v2：补齐轨道、标记、关键帧容器。对 v2 是恒等操作，可重复调用。 */
  function migrateProject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ver = Number(raw.v) || 1;
    if (ver >= SAVE_VER) return raw;
    const out = JSON.parse(JSON.stringify(raw));
    out.v = SAVE_VER;
    out.sampleRate = 48000;
    out.tracks = defaultTracks();
    out.markers = [];
    out.meta = { createdAt: 0, updatedAt: 0, app: 'studio' };
    out.clips = (Array.isArray(out.clips) ? out.clips : []).map(function (c) {
      if (!c || typeof c !== 'object') return c;
      if (!c.kf) c.kf = {};
      return c;
    });
    return out;
  }

  function makeClip(opt) {
    const c = opt || {};
    return {
      id: c.id || uid('c'),
      track: c.track || 'v1',
      kind: c.kind || 'video',
      mediaId: c.mediaId || '',
      name: c.name || '片段',
      start: Number(c.start) || 0,
      dur: Math.max(MIN_CLIP, Number(c.dur) || 5),
      in: Math.max(0, Number(c.in) || 0),
      speed: Number(c.speed) || 1,
      x: Number(c.x) || 0,
      y: Number(c.y) || 0,
      scale: c.scale == null ? 1 : Number(c.scale),
      rot: Number(c.rot) || 0,
      opacity: c.opacity == null ? 1 : Number(c.opacity),
      volume: c.volume == null ? 1 : Number(c.volume),
      muted: !!c.muted,
      fadeIn: c.fadeIn == null ? 0 : Number(c.fadeIn),
      fadeOut: c.fadeOut == null ? 0 : Number(c.fadeOut),
      filter: c.filter || 'none',
      kf: normalizeKf(c.kf),
      text: {
        content: (c.text && c.text.content) || '标题文字',
        size: (c.text && c.text.size) || 64,
        color: (c.text && c.text.color) || '#ffffff',
        bg: (c.text && c.text.bg) || 'rgba(0,0,0,0)',
        bold: !(c.text && c.text.bold === false),
        align: (c.text && c.text.align) || 'center'
      }
    };
  }

  function normalizeProject(raw) {
    const p = blankProject();
    const src = migrateProject(raw);
    if (!src) return p;
    p.name = String(src.name || p.name);
    p.w = Math.max(320, Number(src.w) || 1920);
    p.h = Math.max(180, Number(src.h) || 1080);
    p.fps = [24, 25, 30, 50, 60].indexOf(Number(src.fps)) >= 0 ? Number(src.fps) : 30;
    p.sampleRate = [44100, 48000].indexOf(Number(src.sampleRate)) >= 0 ? Number(src.sampleRate) : 48000;
    p.tracks = normalizeTracks(src.tracks);
    p.markers = normalizeMarkers(src.markers);
    p.meta = {
      createdAt: Number(src.meta && src.meta.createdAt) || 0,
      updatedAt: Number(src.meta && src.meta.updatedAt) || 0,
      app: 'studio'
    };
    p.media = (Array.isArray(src.media) ? src.media : []).filter(function (m) {
      return m && m.id && (m.kind === 'video' || m.kind === 'audio' || m.kind === 'image');
    }).map(function (m) {
      return {
        id: String(m.id),
        name: String(m.name || '素材'),
        kind: m.kind,
        url: String(m.url || ''),
        dur: Math.max(0, Number(m.dur) || 0),
        source: m.source === 'library' ? 'library' : 'file',
        libId: m.libId ? String(m.libId) : ''
      };
    });
    const ids = new Set(p.media.map(function (m) { return m.id; }));
    const trackMap = {};
    p.tracks.forEach(function (t) { trackMap[t.id] = t; });
    p.clips = (Array.isArray(src.clips) ? src.clips : []).filter(function (c) {
      if (!c || !c.id || !trackMap[c.track]) return false;
      const tk = trackMap[c.track].kind;
      const want = c.kind === 'text' ? 'text' : c.kind === 'audio' ? 'audio' : 'video';
      if (tk !== want) return false;
      return c.kind === 'text' || ids.has(c.mediaId);
    }).map(function (c) { return makeClip(c); });
    return p;
  }

  /* ---------------- 关键帧采样（纯函数） ---------------- */
  function easeVal(t, ez) {
    if (ez === 'easeIn') return t * t;
    if (ez === 'easeOut') return 1 - (1 - t) * (1 - t);
    if (ez === 'easeInOut') return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    return t;
  }

  function sampleTrack(keys, localT) {
    if (!Array.isArray(keys) || !keys.length) return null;
    if (!isFinite(localT)) return keys[0].v;
    if (localT <= keys[0].t) return keys[0].v;
    const last = keys[keys.length - 1];
    if (localT >= last.t) return last.v;
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (localT >= a.t && localT <= b.t) {
        const span = b.t - a.t;
        const f = span > 0 ? (localT - a.t) / span : 1;
        return a.v + (b.v - a.v) * easeVal(f, a.ease || 'linear');
      }
    }
    return last.v;
  }

  function propAt(c, prop, t) {
    const base = { opacity: c.opacity, scale: c.scale, x: c.x, y: c.y, rot: c.rot, volume: c.volume }[prop];
    const k = c.kf && c.kf[prop];
    if (!k || !k.length) return base;
    const v = sampleTrack(k, t - c.start);
    return v == null ? base : v;
  }

  function projectDuration(p) {
    let d = 0;
    for (const c of p.clips) d = Math.max(d, c.start + c.dur);
    return round2(d);
  }

  /* ---------------- 状态 ---------------- */
  const S = {
    inited: false,
    project: blankProject(),
    time: 0,
    playing: false,
    sel: '',
    multi: new Set(),
    mediaSel: '',
    pps: 80,
    vol: 1,
    muted: false,
    snap: true,
    tool: 'select',
    loop: false,
    panel: 'media',
    hist: [],
    future: [],
    inspSnap: '',
    raf: 0,
    last: 0,
    exportSession: null,
    exportUrl: '',
    pool: {},
    textNodes: new Map(),
    textSig: '',
    toastTimer: 0,
    saveTimer: 0,
    libFiles: [],
    libPick: new Set(),
    libTimer: 0,
    frameW: 0,
    frameH: 0,
    drag: null,
    drop: null,
    pressed: false,
    lsOk: true,
    steps: 0,
    snapshots: [],
    lastSnapAt: 0,
    snapStep: 0,
    trackSig: ''
  };

  function tracks() { return S.project.tracks; }
  function trackOf(id) {
    for (const t of S.project.tracks) if (t.id === id) return t;
    return null;
  }
  function tracksOfKind(kind) {
    return S.project.tracks.filter(function (t) { return t.kind === kind; });
  }
  function anySolo() {
    return S.project.tracks.some(function (t) { return t.solo; });
  }
  function trackActive(t) {
    if (!t || t.hidden) return false;
    return !anySolo() || t.solo;
  }
  function clipKindTrack(kind) {
    return kind === 'text' ? 'text' : kind === 'audio' ? 'audio' : 'video';
  }

  function winEl() { return $('studioWin'); }
  function isShown() {
    const w = winEl();
    return !!w && !w.classList.contains('hidden') && w.offsetParent !== null;
  }
  function mediaOf(id) {
    for (const m of S.project.media) if (m.id === id) return m;
    return null;
  }
  function clipOf(id) {
    for (const c of S.project.clips) if (c.id === id) return c;
    return null;
  }
  function selected() { return S.sel ? clipOf(S.sel) : null; }
  function sortedClips() {
    return S.project.clips.slice().sort(function (a, b) { return a.start - b.start; });
  }
  function trackEnd(track) {
    let d = 0;
    for (const c of S.project.clips) if (c.track === track) d = Math.max(d, c.start + c.dur);
    return d;
  }

  /* ---------------- 本地存档 / 快照 ---------------- */
  function cleanForStore(p) {
    const copy = JSON.parse(JSON.stringify(p));
    /* 只存视频库素材：文件素材的 objectURL 在下次启动必定失效 */
    copy.media = copy.media.filter(function (m) { return m.source === 'library'; });
    const keep = new Set(copy.media.map(function (m) { return m.id; }));
    copy.clips = copy.clips.filter(function (c) { return c.kind === 'text' || keep.has(c.mediaId); });
    return copy;
  }

  function readSnaps() {
    try {
      const arr = JSON.parse(localStorage.getItem(SNAP_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function snapshotProject() {
    /* 快照保留完整项目（含本会话的 blob/objectURL），用于崩溃后当场恢复；
       跨会话读取时 loadSaved 仍会剔除失效的文件素材。 */
    return { at: Date.now(), time: S.time, name: S.project.name, project: JSON.parse(JSON.stringify(S.project)) };
  }

  function saveSnapshot() {
    S.snapshots.push(snapshotProject());
    if (S.snapshots.length > SNAP_MAX) S.snapshots = S.snapshots.slice(-SNAP_MAX);
    S.lastSnapAt = Date.now();
    S.snapStep = S.steps;
    if (typeof STORE_SYNC_OFF !== 'undefined' && STORE_SYNC_OFF) return;
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(S.snapshots)); } catch (e) { /* 配额满就只留内存 */ }
  }

  function maybeSnapshot() {
    if (!S.lastSnapAt) { S.lastSnapAt = Date.now(); S.snapStep = S.steps; return; }
    if (Date.now() - S.lastSnapAt >= SNAP_MS || S.steps - S.snapStep >= 50) saveSnapshot();
  }

  function restoreSnapshot(i) {
    const s = S.snapshots[i];
    if (!s || !s.project) return false;
    S.project = normalizeProject(s.project);
    S.time = clamp(Number(s.time) || 0, 0, Math.max(0, projectDuration(S.project)));
    S.sel = '';
    S.multi.clear();
    S.hist = [];
    S.future = [];
    afterRestore();
    toast('已恢复快照：' + (s.name || '未命名项目'));
    return true;
  }

  function loadSaved() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); }
    catch (e) { raw = null; }
    S.snapshots = readSnaps();
    if (!raw || !raw.project) {
      /* 主存档缺失时用最近一份快照兜底（崩溃恢复） */
      const last = S.snapshots[S.snapshots.length - 1];
      if (!last || !last.project) return null;
      raw = { project: last.project, time: last.time };
    }
    const p = normalizeProject(raw.project);
    /* 文件素材的 objectURL 跨刷新必然失效：剔除素材，同时剔除引用它的片段，
       而不是留一堆播不出来的黑片段。 */
    const keep = new Set(p.media.map(function (m) { return m.id; }));
    p.clips = p.clips.filter(function (c) { return c.kind === 'text' || keep.has(c.mediaId); });
    return { project: p, time: Math.max(0, Number(raw.time) || 0) };
  }

  function markSaveState(text, busy) {
    const el = $('stSaveState');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  function saveNow() {
    clearTimeout(S.saveTimer);
    S.saveTimer = 0;
    /* ?nostore=1 是测试模式：只禁写不禁读（js/config.js 的 STORE_SYNC_OFF） */
    if (typeof STORE_SYNC_OFF !== 'undefined' && STORE_SYNC_OFF) {
      markSaveState('测试模式 · 不落盘', false);
      return;
    }
    try {
      S.project.meta = S.project.meta || {};
      S.project.meta.updatedAt = Date.now();
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        v: SAVE_VER, project: cleanForStore(S.project), time: S.time, at: Date.now()
      }));
      markSaveState('已保存', false);
      maybeSnapshot();
    } catch (e) {
      S.lsOk = false;
      markSaveState('未存档', false);
    }
  }

  function scheduleSave() {
    markSaveState('保存中…', true);
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(saveNow, 650);
  }

  /* ---------------- 历史 ---------------- */
  function snap() { return JSON.stringify(S.project); }
  function pushHistory() {
    S.hist.push(snap());
    if (S.hist.length > MAX_HIST) S.hist.shift();
    S.future.length = 0;
    S.steps += 1;
    paintUndo();
  }
  function dropHistory() {
    if (S.hist.length) S.hist.pop();
    paintUndo();
  }
  function undo() {
    if (!S.hist.length) return false;
    S.future.push(snap());
    S.project = normalizeProject(JSON.parse(S.hist.pop()));
    afterRestore();
    return true;
  }
  function redo() {
    if (!S.future.length) return false;
    S.hist.push(snap());
    S.project = normalizeProject(JSON.parse(S.future.pop()));
    afterRestore();
    return true;
  }
  function afterRestore() {
    if (S.sel && !clipOf(S.sel)) S.sel = '';
    const alive = new Set(S.project.clips.map(function (c) { return c.id; }));
    Array.from(S.multi).forEach(function (id) {
      if (!alive.has(id)) S.multi.delete(id);
    });
    S.time = clamp(S.time, 0, Math.max(0, projectDuration(S.project)));
    renderAll();
    applyTime();
    scheduleSave();
    paintUndo();
  }
  function paintUndo() {
    const u = $('stUndo');
    const r = $('stRedo');
    if (u) u.disabled = !S.hist.length;
    if (r) r.disabled = !S.future.length;
  }

  /* ---------------- 提示 ---------------- */
  function toast(msg) {
    const el = $('stToast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    el.classList.add('show');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.classList.add('hidden'); }, 180);
    }, 2200);
  }

  function askConfirm(title, msg, onYes) {
    const m = $('stConfirmModal');
    if (!m) { onYes(); return; }
    $('stConfirmT').textContent = title;
    $('stConfirmS').textContent = msg;
    m.classList.remove('hidden');
    m.dataset.on = '1';
    S._confirmYes = onYes;
  }

  /* ---------------- 初始化 ---------------- */
  function init(body) {
    if (S.inited) {
      /* 幂等：再次翻到本 App 只刷新素材与画面，不重建 DOM，保住滚动与选中 */
      refreshPreviewLayout();
      renderMedia();
      applyTime();
      return;
    }
    S.inited = true;

    const saved = loadSaved();
    if (saved) {
      S.project = saved.project;
      S.time = clamp(saved.time, 0, Math.max(0, projectDuration(S.project)));
    }

    buildTextPresets();
    buildFilters();
    bindAll();
    fitFrame();

    renderAll();
    applyTime();
    paintUndo();
    saveNow();

    /* 首次打开时，如果本地存档被过滤空了素材，给一句说明 */
    if (saved && !saved.project.media.length && saved.project.clips.length === 0) {
      /* 什么都不提示：空项目是正常初态 */
    }
    void body;
  }

  function buildPools() {
    const app = $('stApp');
    const frame = $('stFrame');
    const textHost = $('stTexts');
    if (!app || !frame || !textHost) return;
    frame.querySelectorAll('.st-layer[data-track]').forEach(function (n) { n.remove(); });
    Object.keys(S.pool).forEach(function (id) {
      const p = S.pool[id];
      if (p.video) p.video.remove();
      if (p.img) p.img.remove();
      if (p.audio) p.audio.remove();
      if (p.layer) p.layer.remove();
    });
    S.pool = {};
    tracks().forEach(function (t, i) {
      if (t.kind === 'video') {
        const layer = document.createElement('div');
        layer.className = 'st-layer';
        layer.dataset.track = t.id;
        layer.style.zIndex = String(50 - i);
        frame.insertBefore(layer, textHost);
        const v = document.createElement('video');
        v.playsInline = true;
        v.preload = 'auto';
        v.className = 'st-media-el';
        v.muted = false;
        layer.appendChild(v);
        const img = document.createElement('img');
        img.className = 'st-media-el hidden';
        img.alt = '';
        layer.appendChild(img);
        S.pool[t.id] = { layer: layer, video: v, img: img, clipId: '', kind: '' };
      } else if (t.kind === 'audio') {
        const a = document.createElement('audio');
        a.preload = 'auto';
        a.className = 'st-hidden-el';
        a.style.display = 'none';
        app.appendChild(a);
        S.pool[t.id] = { audio: a, clipId: '', kind: '' };
      }
    });
  }

  function headButtons(t) {
    const defs = [
      ['lock', 'lock', '锁定轨道', t.locked],
      ['mute', t.muted ? 'mute' : 'sound', '静音轨道', t.muted],
      ['solo', 'solo', '独奏轨道', t.solo],
      ['hidden', t.hidden ? 'eyeOff' : 'eye', '隐藏轨道', t.hidden]
    ];
    return defs.map(function (d) {
      return '<button type="button" class="st-thb' + (d[3] ? ' on' : '') + '" data-tt="' + d[0] +
        '" data-track="' + t.id + '" title="' + d[2] + '" aria-pressed="' + (d[3] ? 'true' : 'false') + '">' + ico(d[1]) + '</button>';
    }).join('');
  }

  function buildTrackHeads() {
    const heads = $('stHeads');
    if (!heads) return;
    heads.innerHTML = '<div class="st-head-ruler"></div><div class="st-heads-inner" id="stHeadsInner">' +
      tracks().map(function (t) {
        const count = S.project.clips.filter(function (c) { return c.track === t.id; }).length;
        const del = count === 0 && tracks().length > 1 ?
          '<button type="button" class="st-thdel" data-del="' + t.id + '" title="删除空轨道" aria-label="删除空轨道">' + ico('trash') + '</button>' :
          '<i class="st-th-count" data-count="' + t.id + '">' + count + '</i>';
        return '<div class="st-th" data-track="' + t.id + '" data-kind="' + t.kind + '"' +
          ' data-locked="' + (t.locked ? 1 : 0) + '" data-hidden="' + (t.hidden ? 1 : 0) + '"' +
          ' style="height:' + t.height + 'px">' + svgWrap(TRACK_ICON[t.kind]) +
          '<b title="' + escHtml(t.name) + '">' + escHtml(t.name) + '</b>' +
          '<span class="st-th-btns">' + headButtons(t) + '</span>' + del +
          '<span class="st-th-grip" data-grip="' + t.id + '" title="拖动调整轨道高度"></span></div>';
      }).join('') + '</div>';
  }

  function buildTextPresets() {
    const box = $('stTextPresets');
    if (!box) return;
    box.innerHTML = TEXT_PRESETS.map(function (p) {
      return '<button type="button" class="st-preset" data-preset="' + p.id + '">' +
        '<i style="color:' + (p.style.color === '#ffffff' ? '#e9edf5' : p.style.color) + '">Aa</i>' +
        '<div><b>' + p.name + '</b><span>' + p.note + '</span></div></button>';
    }).join('');
  }

  function buildFilters() {
    const box = $('stFxGrid');
    if (!box) return;
    box.innerHTML = FILTERS.map(function (f) {
      return '<div class="st-fxcard" data-fx="' + f.id + '"><div class="st-fxprev"></div>' +
        '<div class="st-fxname">' + f.name + '</div></div>';
    }).join('');
  }

  function fitFrame() {
    const prev = document.querySelector('.st-prev');
    const frame = $('stFrame');
    if (!prev || !frame) return;
    const aw = Math.max(120, prev.clientWidth - 32);
    const ah = Math.max(80, prev.clientHeight - 22);
    const p = S.project;
    const k = Math.min(aw / p.w, ah / p.h);
    const w = Math.max(120, Math.round(p.w * k));
    const h = Math.max(68, Math.round(p.h * k));
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    S.frameW = w;
    S.frameH = h;
    S.textSig = '';
    paintTexts(true);
  }

  function refreshPreviewLayout() {
    fitFrame();
  }

  /* ---------------- 音频图（预览与导出共用） -----------------
   * 元素一旦被 createMediaElementSource 接管，声音就走 WebAudio：
   *   element.volume → master → monitor → 扬声器
   *                          └→ recDest → MediaRecorder
   * 导出时把 monitor 拉 0（否则会一边录一边外放），但 recDest 仍拿到完整声音。 */
  const AUD = { ctx: null, master: null, monitor: null, recDest: null, srcMap: new Map() };

  function ensureAudio() {
    if (AUD.ctx) return AUD.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const master = ctx.createGain();
      const monitor = ctx.createGain();
      master.connect(monitor);
      monitor.connect(ctx.destination);
      let dest = null;
      try {
        dest = ctx.createMediaStreamDestination();
        master.connect(dest);
      } catch (e) { dest = null; }
      AUD.ctx = ctx;
      AUD.master = master;
      AUD.monitor = monitor;
      AUD.recDest = dest;
    } catch (e) { return null; }
    return AUD.ctx;
  }
  function resumeAudio() {
    if (AUD.ctx && AUD.ctx.state === 'suspended') {
      const p = AUD.ctx.resume();
      if (p && p.catch) p.catch(function () {});
    }
  }
  function hookEl(el) {
    if (!el) return;
    if (!ensureAudio()) return;
    if (AUD.srcMap.has(el)) return;
    try {
      const src = AUD.ctx.createMediaElementSource(el);
      src.connect(AUD.master);
      AUD.srcMap.set(el, src);
    } catch (e) { /* 已经被别的图接管过时忽略 */ }
  }
  function applyMonitorGain() {
    if (!AUD.monitor) return;
    AUD.monitor.gain.value = (S.muted || S.exportSession) ? 0 : 1;
  }

  /* ---------------- 预览同步 ---------------- */
  function activeClipOn(track, t) {
    let best = null;
    for (const c of S.project.clips) {
      if (c.track !== track) continue;
      if (t >= c.start - 1e-4 && t < c.start + c.dur - 1e-4) {
        if (!best || c.start >= best.start) best = c;
      }
    }
    return best;
  }

  function fadeFactor(c, t) {
    let f = 1;
    if (c.fadeIn > 0) f = Math.min(f, (t - c.start) / c.fadeIn);
    if (c.fadeOut > 0) f = Math.min(f, (c.start + c.dur - t) / c.fadeOut);
    return clamp(f, 0, 1);
  }

  function visualOf(c, t) {
    return {
      x: propAt(c, 'x', t),
      y: propAt(c, 'y', t),
      scale: propAt(c, 'scale', t),
      rot: propAt(c, 'rot', t),
      opacity: propAt(c, 'opacity', t)
    };
  }

  function applyVisual(el, c, t) {
    if (!el) return;
    const v = visualOf(c, t);
    const dx = (v.x / 100) * S.frameW;
    const dy = (v.y / 100) * S.frameH;
    el.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' +
      v.scale.toFixed(3) + ') rotate(' + v.rot + 'deg)';
    el.style.opacity = String(clamp(v.opacity * fadeFactor(c, t), 0, 1));
    el.style.filter = cssFilter(c.filter);
  }

  function hideVisual(pool) {
    if (!pool) return;
    if (pool.video) {
      pool.video.classList.add('hidden');
      try { pool.video.pause(); } catch (e) {}
    }
    if (pool.img) pool.img.classList.add('hidden');
    pool.clipId = '';
    pool.kind = '';
  }

  function syncVisual(trackId, t, playing) {
    const pool = S.pool[trackId];
    if (!pool || !pool.video) return;
    const tk = trackOf(trackId);
    const c = trackActive(tk) ? activeClipOn(trackId, t) : null;
    if (!c) { hideVisual(pool); return; }
    const m = mediaOf(c.mediaId);
    if (!m || !m.url) { hideVisual(pool); return; }
    const mediaKind = m.kind === 'image' ? 'image' : 'video';

    if (pool.clipId !== c.id || pool.kind !== mediaKind) {
      pool.clipId = c.id;
      pool.kind = mediaKind;
      if (mediaKind === 'image') {
        pool.video.classList.add('hidden');
        try { pool.video.pause(); } catch (e) {}
        pool.video.removeAttribute('src');
        try { pool.video.load(); } catch (e) {}
        pool.img.src = m.url;
        pool.img.classList.remove('hidden');
      } else {
        pool.img.classList.add('hidden');
        pool.img.removeAttribute('src');
        pool.video.classList.remove('hidden');
        pool.video.src = m.url;
        try { pool.video.load(); } catch (e) {}
        hookEl(pool.video);
      }
    }

    const fade = fadeFactor(c, t);
    if (mediaKind === 'video') {
      const v = pool.video;
      const mediaDur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      let srcT = (t - c.start) * c.speed + c.in;
      if (mediaDur) srcT = clamp(srcT, 0, Math.max(0, mediaDur - 0.03));
      else srcT = Math.max(0, srcT);
      const vol = propAt(c, 'volume', t);
      v.playbackRate = clamp(c.speed, 0.25, 4);
      v.volume = clamp(vol * S.vol * fade, 0, 1);
      v.muted = !!c.muted || !!tk.muted || vol <= 0;
      if (playing) {
        if (v.readyState >= 1 && Math.abs(v.currentTime - srcT) > 0.3) {
          try { v.currentTime = srcT; } catch (e) {}
        }
        if (v.paused) {
          const pr = v.play();
          if (pr && pr.catch) pr.catch(function () {});
        }
      } else {
        if (!v.paused) v.pause();
        if (v.readyState >= 1 && Math.abs(v.currentTime - srcT) > 0.04) {
          try { v.currentTime = srcT; } catch (e) {}
        }
      }
      applyVisual(v, c, t);
    } else {
      applyVisual(pool.img, c, t);
    }
  }

  function syncAudio(trackId, t, playing) {
    const pool = S.pool[trackId];
    if (!pool || !pool.audio) return;
    const a = pool.audio;
    const tk = trackOf(trackId);
    const c = trackActive(tk) ? activeClipOn(trackId, t) : null;
    if (!c) {
      if (pool.clipId) {
        try { a.pause(); } catch (e) {}
        pool.clipId = '';
      }
      return;
    }
    const m = mediaOf(c.mediaId);
    if (!m || !m.url) { try { a.pause(); } catch (e) {} pool.clipId = ''; return; }
    if (pool.clipId !== c.id) {
      pool.clipId = c.id;
      a.src = m.url;
      try { a.load(); } catch (e) {}
      hookEl(a);
    }
    const fade = fadeFactor(c, t);
    const vol = propAt(c, 'volume', t);
    const mediaDur = isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    let srcT = (t - c.start) * c.speed + c.in;
    if (mediaDur) srcT = clamp(srcT, 0, Math.max(0, mediaDur - 0.03));
    a.playbackRate = clamp(c.speed, 0.25, 4);
    a.volume = clamp(vol * S.vol * fade, 0, 1);
    a.muted = !!c.muted || !!tk.muted || vol <= 0;
    if (playing) {
      if (a.readyState >= 1 && Math.abs(a.currentTime - srcT) > 0.3) {
        try { a.currentTime = srcT; } catch (e) {}
      }
      if (a.paused) {
        const pr = a.play();
        if (pr && pr.catch) pr.catch(function () {});
      }
    } else {
      if (!a.paused) a.pause();
      if (a.readyState >= 1 && Math.abs(a.currentTime - srcT) > 0.04) {
        try { a.currentTime = srcT; } catch (e) {}
      }
    }
  }

  /* ---------------- 文字层 ---------------- */
  function textSigOf(active) {
    return active.map(function (c) {
      return [c.id, c.track, c.text.content, c.text.size, c.text.color, c.text.bg,
        c.text.bold ? 1 : 0, c.text.align, c.x, c.y, c.rot, c.scale].join('|');
    }).join('~') + '@' + S.frameW + 'x' + S.frameH + '@' + S.project.w + 'x' + S.project.h;
  }

  function activeTextsAt(t) {
    const out = [];
    S.project.tracks.forEach(function (tk) {
      if (tk.kind !== 'text' || !trackActive(tk)) return;
      S.project.clips.forEach(function (c) {
        if (c.track === tk.id && t >= c.start - 1e-4 && t < c.start + c.dur - 1e-4) out.push(c);
      });
    });
    return out.sort(function (a, b) { return a.start - b.start; });
  }

  function paintTexts(force) {
    const host = $('stTexts');
    if (!host) return;
    const t = S.time;
    const active = activeTextsAt(t);
    const sig = textSigOf(active);
    if (force) S.textSig = '';
    if (sig !== S.textSig) {
      S.textSig = sig;
      host.innerHTML = '';
      S.textNodes.clear();
      active.forEach(function (c) {
        const d = document.createElement('div');
        d.className = 'st-text-item';
        d.textContent = c.text.content;
        d.style.color = c.text.color;
        d.style.background = c.text.bg;
        d.style.fontWeight = c.text.bold ? '700' : '400';
        d.style.textAlign = c.text.align;
        d.style.fontSize = Math.max(6, c.text.size * (S.frameW || 640) / S.project.w).toFixed(2) + 'px';
        d.style.left = (50 + propAt(c, 'x', t)) + '%';
        d.style.top = (50 + propAt(c, 'y', t)) + '%';
        d.style.transform = 'translate(-50%,-50%) rotate(' + propAt(c, 'rot', t) + 'deg) scale(' + propAt(c, 'scale', t) + ')';
        host.appendChild(d);
        S.textNodes.set(c.id, d);
      });
    }
    active.forEach(function (c) {
      const d = S.textNodes.get(c.id);
      if (!d) return;
      d.style.left = (50 + propAt(c, 'x', t)) + '%';
      d.style.top = (50 + propAt(c, 'y', t)) + '%';
      d.style.transform = 'translate(-50%,-50%) rotate(' + propAt(c, 'rot', t) + 'deg) scale(' + propAt(c, 'scale', t) + ')';
      d.style.opacity = String(clamp(propAt(c, 'opacity', t) * fadeFactor(c, t), 0, 1));
    });
    S.textNodes.forEach(function (node, id) {
      if (!active.some(function (c) { return c.id === id; })) {
        node.remove();
        S.textNodes.delete(id);
      }
    });
  }

  /* ---------------- 播放 / 定位 ---------------- */
  function paintPlayIcon() {
    const btn = $('stPlay');
    if (!btn) return;
    const play = btn.querySelector('.st-ico-play');
    const pause = btn.querySelector('.st-ico-pause');
    if (play) play.classList.toggle('hidden', S.playing);
    if (pause) pause.classList.toggle('hidden', !S.playing);
    btn.setAttribute('aria-label', S.playing ? '暂停' : '播放');
  }

  function updateEmpty() {
    const box = $('stPrevEmpty');
    if (!box) return;
    const t = S.time;
    let any = false;
    for (const c of S.project.clips) {
      if (t >= c.start - 1e-4 && t < c.start + c.dur - 1e-4) { any = true; break; }
    }
    box.classList.toggle('hidden', any);
  }

  function paintPlayhead() {
    const ph = $('stPlayhead');
    if (!ph) return;
    ph.style.left = (S.time * S.pps).toFixed(1) + 'px';
    const sc = $('stScroll');
    if (sc && S.playing) {
      const x = S.time * S.pps;
      if (x > sc.scrollLeft + sc.clientWidth - 70) {
        sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.45);
      }
    }
  }

  function paintTc() {
    const tc = $('stTc');
    if (tc) tc.textContent = fmtTc(S.time, S.project.fps);
    const d = $('stDur');
    if (d) d.textContent = fmtMmss(projectDuration(S.project));
  }

  function applyTime() {
    tracks().forEach(function (t) {
      if (t.kind === 'video') syncVisual(t.id, S.time, S.playing);
      else if (t.kind === 'audio') syncAudio(t.id, S.time, S.playing);
    });
    paintTexts(false);
    paintPlayhead();
    paintTc();
    updateEmpty();
  }

  function seek(t) {
    S.time = clamp(Number(t) || 0, 0, Math.max(0, projectDuration(S.project)));
    S.last = 0;
    applyTime();
  }

  function seekBy(d) { seek(S.time + d); }

  function play() {
    const dur = projectDuration(S.project);
    if (dur <= 0.05) { toast('时间线还是空的，先把素材拖进轨道'); return; }
    if (S.time >= dur - 0.02) S.time = 0;
    ensureAudio();
    resumeAudio();
    applyMonitorGain();
    S.playing = true;
    S.last = 0;
    paintPlayIcon();
    cancelAnimationFrame(S.raf);
    S.raf = requestAnimationFrame(tick);
    applyTime();
  }

  function pause() {
    S.playing = false;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    S.last = 0;
    paintPlayIcon();
    tracks().forEach(function (t) {
      const p = S.pool[t.id];
      if (p && p.video) { try { p.video.pause(); } catch (e) {} }
      if (p && p.audio) { try { p.audio.pause(); } catch (e) {} }
    });
    applyTime();
  }

  function togglePlay() { if (S.playing) pause(); else play(); }

  function tick(now) {
    if (!S.playing) { S.raf = 0; return; }
    if (!S.last) S.last = now;
    let dt = (now - S.last) / 1000;
    S.last = now;
    if (dt > 0.3) dt = 0.3;
    const dur = projectDuration(S.project);
    S.time += dt;
    if (S.time >= dur) {
      if (S.loop && !S.exportSession) {
        S.time = 0;
        S.last = 0;
        applyTime();
        S.raf = requestAnimationFrame(tick);
        return;
      }
      S.time = dur;
      applyTime();
      if (S.exportSession) { finishExportTick(); return; }
      pause();
      toast('已播放到结尾');
      return;
    }
    applyTime();
    if (S.exportSession) {
      drawExportFrame();
      paintExportProgress();
    }
    S.raf = requestAnimationFrame(tick);
  }

  /* ---------------- 时间线渲染 ---------------- */
  function innerWidth() {
    const sc = $('stScroll');
    const view = sc ? sc.clientWidth : 800;
    const need = Math.max(projectDuration(S.project) + 2.4, view / S.pps);
    return Math.max(320, Math.ceil(need * S.pps) + 60);
  }

  function fmtTick(t, step) {
    if (step < 1) return t.toFixed(1) + 's';
    return fmtMmss(t);
  }

  function renderRuler() {
    const inner = $('stInner');
    const ruler = $('stRuler');
    if (!inner || !ruler) return;
    const W = innerWidth();
    inner.style.width = W + 'px';
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    let major = steps[steps.length - 1];
    for (const s of steps) { if (s * S.pps >= 72) { major = s; break; } }
    const minor = major / 5;
    /* 超长项目 × 最大缩放时，整条标尺可能有几万像素；刻度只画到 24000px
       （足够覆盖任何可视窗口），避免一次生成上万个节点把窗口卡住。 */
    const paintW = Math.min(W, 24000);
    const total = paintW / S.pps;
    let html = '';
    const count = Math.floor(total / minor) + 1;
    for (let i = 0; i < count; i++) {
      const t = i * minor;
      const x = t * S.pps;
      if (x > W) break;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      html += '<i class="st-rtick' + (isMajor ? ' major' : '') + '" style="left:' + x.toFixed(1) + 'px"></i>';
      if (isMajor) {
        html += '<span class="st-rlabel" style="left:' + (x + 4).toFixed(1) + 'px">' + fmtTick(t, major) + '</span>';
      }
    }
    S.project.markers.forEach(function (m) {
      const x = m.t * S.pps;
      if (x > W) return;
      html += '<b class="st-mk" data-mk="' + m.t + '" title="' + escHtml(m.name) + '（Alt+点击删除）"' +
        ' style="left:' + x.toFixed(1) + 'px;background:' + m.color + '"></b>';
    });
    ruler.innerHTML = html;
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function kindLabel(k) {
    return k === 'audio' ? '音频' : k === 'text' ? '文字' : k === 'image' ? '图片' : '视频';
  }

  function isSelClip(c) {
    return S.sel === c.id || S.multi.has(c.id);
  }

  function clipEl(c) {
    const left = c.start * S.pps;
    const width = Math.max(14, c.dur * S.pps);
    const showMeta = width > 78;
    const kfCount = Object.keys(c.kf || {}).length;
    const meta = showMeta ? '<span class="st-clip-meta">' + fmtDur(c.dur) +
      (c.speed !== 1 ? ' · ' + c.speed.toFixed(2) + 'x' : '') +
      (kfCount ? ' · ◆' + kfCount : '') + '</span>' : '';
    return '<div class="st-clip' + (isSelClip(c) ? ' sel' : '') + '" data-id="' + c.id +
      '" data-kind="' + c.kind + '" style="left:' + left.toFixed(1) + 'px;width:' + width.toFixed(1) + 'px" title="' +
      escHtml(c.name) + '">' +
      '<b class="st-clip-pattern"></b>' +
      '<span class="st-clip-name">' + escHtml(c.name) + '</span>' + meta +
      '<b class="st-trim" data-edge="l"></b><b class="st-trim" data-edge="r"></b></div>';
  }

  function renderRows() {
    const box = $('stRows');
    if (!box) return;
    box.innerHTML = tracks().map(function (t) {
      return '<div class="st-row" data-track="' + t.id + '" data-kind="' + t.kind +
        '" style="height:' + t.height + 'px"></div>';
    }).join('');
    tracks().forEach(function (t) {
      const row = box.querySelector('.st-row[data-track="' + t.id + '"]');
      if (!row) return;
      S.project.clips.filter(function (c) { return c.track === t.id; })
        .sort(function (a, b) { return a.start - b.start; })
        .forEach(function (c) { row.insertAdjacentHTML('beforeend', clipEl(c)); });
    });
    updateCounts();
  }

  function updateCounts() {
    tracks().forEach(function (t) {
      const el = document.querySelector('.st-th[data-track="' + t.id + '"] [data-count]');
      if (!el) return;
      el.textContent = String(S.project.clips.filter(function (c) { return c.track === t.id; }).length);
    });
  }

  function renderTimeline() {
    renderRuler();
    renderRows();
  }

  function liveClipEl(c) {
    const node = document.querySelector('.st-clip[data-id="' + c.id + '"]');
    if (!node) return;
    node.style.left = (c.start * S.pps).toFixed(1) + 'px';
    node.style.width = Math.max(14, c.dur * S.pps).toFixed(1) + 'px';
    const meta = node.querySelector('.st-clip-meta');
    if (meta) meta.textContent = fmtDur(c.dur) + (c.speed !== 1 ? ' · ' + c.speed.toFixed(2) + 'x' : '');
  }

  function selectedIds() {
    if (S.multi.size) return Array.from(S.multi);
    return S.sel ? [S.sel] : [];
  }

  function paintSel() {
    document.querySelectorAll('#stRows .st-clip').forEach(function (n) {
      const c = clipOf(n.dataset.id);
      n.classList.toggle('sel', !!c && isSelClip(c));
    });
  }

  function selectClip(id, additive) {
    if (additive) {
      if (!id) {
        S.multi.clear();
        S.sel = '';
      } else {
        if (!S.multi.size && S.sel) S.multi.add(S.sel);
        if (S.multi.has(id)) {
          S.multi.delete(id);
          if (S.sel === id) S.sel = Array.from(S.multi).pop() || '';
        } else {
          S.multi.add(id);
          S.sel = id;
        }
        if (S.multi.size < 2) S.multi.clear();
      }
    } else {
      S.multi.clear();
      S.sel = id || '';
    }
    paintSel();
    renderInspector();
    paintFxSel();
  }

  function timeAtX(clientX) {
    const base = $('stRows') || $('stInner');
    if (!base) return 0;
    const rect = base.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / S.pps);
  }

  function trackAtY(clientY) {
    const rows = $('stRows');
    if (!rows) return '';
    const rect = rows.getBoundingClientRect();
    let y = clientY - rect.top;
    const list = tracks();
    for (const t of list) {
      if (y < t.height) return t.id;
      y -= t.height;
    }
    return list.length ? list[list.length - 1].id : '';
  }

  function rowTopOf(trackId) {
    let top = 0;
    for (const t of tracks()) {
      if (t.id === trackId) return top;
      top += t.height;
    }
    return 0;
  }

  function trackCompat(kind, trackId) {
    const tk = trackOf(trackId);
    if (!tk) return false;
    return tk.kind === clipKindTrack(kind);
  }

  function trackLocked(trackId) {
    const tk = trackOf(trackId);
    return !!(tk && tk.locked);
  }

  function snapValue(v, ignoreId, dur) {
    if (!S.snap) return v;
    const th = 8 / S.pps;
    const cands = [0, S.time];
    S.project.markers.forEach(function (m) { cands.push(m.t); });
    S.project.clips.forEach(function (c) {
      if (c.id === ignoreId) return;
      cands.push(c.start, c.start + c.dur);
    });
    let best = v;
    let bestD = th;
    cands.forEach(function (t) {
      const d1 = Math.abs(v - t);
      if (d1 < bestD) { bestD = d1; best = t; }
      if (dur) {
        const d2 = Math.abs(v + dur - t);
        if (d2 < bestD) { bestD = d2; best = t - dur; }
      }
    });
    return Math.max(0, best);
  }

  function maxDurFor(c, inPoint) {
    if (c.kind === 'text') return 3600;
    const m = mediaOf(c.mediaId);
    if (!m || m.kind === 'image' || !m.dur) return 3600;
    return Math.max(MIN_CLIP, (m.dur - inPoint) / (c.speed || 1));
  }

  /* ---------------- 时间线标记 ---------------- */
  function addMarker(atT) {
    const t = clamp(atT == null ? S.time : Number(atT) || 0, 0, Math.max(0, projectDuration(S.project)));
    if (S.project.markers.some(function (m) { return Math.abs(m.t - t) < 0.02; })) {
      toast('这里已经有标记');
      return null;
    }
    pushHistory();
    const m = { t: round2(t), name: '标记 ' + (S.project.markers.length + 1), color: '#f0b429' };
    S.project.markers.push(m);
    S.project.markers.sort(function (a, b) { return a.t - b.t; });
    renderRuler();
    renderInspector();
    scheduleSave();
    toast('已添加标记：' + fmtMmss(t));
    return m;
  }

  function removeMarker(t) {
    const hit = S.project.markers.some(function (m) { return Math.abs(m.t - Number(t)) < 0.02; });
    if (!hit) return false;
    pushHistory();
    S.project.markers = S.project.markers.filter(function (m) {
      return Math.abs(m.t - Number(t)) >= 0.02;
    });
    renderRuler();
    renderInspector();
    scheduleSave();
    toast('已删除标记');
    return true;
  }

  /* ---------------- 轨道管理 ---------------- */
  function insertTrack(kind) {
    const prefix = TRACK_PREFIX[kind] || 'v';
    let n = 1;
    while (trackOf(prefix + n)) n++;
    const id = prefix + n;
    const label = kind === 'video' ? '视频' : kind === 'text' ? '文字' : '音频';
    const t = {
      id: id, kind: kind, name: label + ' ' + n,
      locked: false, muted: false, solo: false, hidden: false, height: 46
    };
    if (kind === 'video') {
      S.project.tracks.unshift(t);
    } else {
      let idx = -1;
      S.project.tracks.forEach(function (x, i) { if (x.kind === kind) idx = i; });
      if (idx >= 0) S.project.tracks.splice(idx + 1, 0, t);
      else S.project.tracks.push(t);
    }
    return t;
  }

  function ensureTrackOfKind(kind) {
    const found = tracksOfKind(kind)[0];
    return found ? found.id : insertTrack(kind).id;
  }

  function preferredTrack(kind) {
    const pref = kind === 'video' ? 'v1' : kind === 'audio' ? 'a1' : 't1';
    const t = trackOf(pref);
    if (t && t.kind === kind) return pref;
    const list = tracksOfKind(kind);
    return list.length ? list[0].id : '';
  }

  function rebuildTracks() {
    S.textSig = '';
    S.textNodes.clear();
    S.trackSig = '';
    renderAll();
    applyTime();
    scheduleSave();
  }

  function addTrack(kind) {
    pushHistory();
    const t = insertTrack(kind);
    rebuildTracks();
    toast('已新增轨道：' + t.name);
    return t;
  }

  function removeTrack(id) {
    const t = trackOf(id);
    if (!t) return false;
    if (tracks().length <= 1) { toast('至少保留一条轨道'); return false; }
    if (S.project.clips.some(function (c) { return c.track === id; })) {
      toast('轨道上还有片段，先删掉片段'); return false;
    }
    pushHistory();
    S.project.tracks = S.project.tracks.filter(function (x) { return x.id !== id; });
    if (S.sel && !clipOf(S.sel)) S.sel = '';
    rebuildTracks();
    toast('已删除空轨道');
    return true;
  }

  function setTrackFlag(id, key) {
    const t = trackOf(id);
    if (!t || ['locked', 'muted', 'solo', 'hidden'].indexOf(key) < 0) return;
    pushHistory();
    t[key] = !t[key];
    buildTrackHeads();
    applyTime();
    scheduleSave();
  }

  function setTrackHeight(id, h) {
    const t = trackOf(id);
    if (!t) return;
    t.height = clamp(Math.round(h), 32, 120);
    const head = document.querySelector('.st-th[data-track="' + id + '"]');
    const row = document.querySelector('.st-row[data-track="' + id + '"]');
    if (head) head.style.height = t.height + 'px';
    if (row) row.style.height = t.height + 'px';
  }

  /* ---------------- 片段增删改 ---------------- */
  function addMediaClip(mediaId, track, start, silent) {
    const m = mediaOf(mediaId);
    if (!m) return null;
    const wantKind = clipKindTrack(m.kind);
    let tr = track && trackCompat(m.kind, track) ? track : '';
    if (!tr) tr = preferredTrack(wantKind);
    if (tr && trackLocked(tr)) {
      if (!silent) toast('轨道已锁定，先解锁');
      return null;
    }
    const needTrack = !tr;
    const dur = m.kind === 'image' ? 5 : Math.max(MIN_CLIP, m.dur || 5);
    pushHistory();
    if (needTrack) tr = insertTrack(wantKind).id;
    const at = start == null ? trackEnd(tr) : Math.max(0, start);
    const c = makeClip({
      track: tr,
      kind: m.kind,
      mediaId: m.id,
      name: m.name,
      start: at,
      dur: Math.min(dur, maxDurFor({ kind: m.kind, mediaId: m.id, speed: 1 }, 0)),
      volume: m.kind === 'audio' ? 0.9 : 1
    });
    S.project.clips.push(c);
    S.sel = c.id;
    S.multi.clear();
    if (needTrack) rebuildTracks();
    else { renderTimeline(); renderInspector(); applyTime(); scheduleSave(); }
    if (!silent) toast('已加入时间线：' + m.name);
    return c;
  }

  function addTextClip(presetId, opts) {
    const p = TEXT_PRESETS.find(function (x) { return x.id === presetId; }) || TEXT_PRESETS[0];
    const st = p.style;
    const at = opts && opts.start != null ? opts.start : S.time;
    const needTrack = !tracksOfKind('text').length;
    pushHistory();
    const trackId = needTrack ? insertTrack('text').id : tracksOfKind('text')[0].id;
    if (trackLocked(trackId)) { dropHistory(); toast('文字轨道已锁定'); return null; }
    const c = makeClip({
      track: trackId,
      kind: 'text',
      name: (opts && opts.name) || p.name,
      start: Math.max(0, at),
      dur: (opts && opts.dur) || 4,
      text: {
        content: (opts && opts.content) || (p.id === 'caption' ? '这是一句字幕' : '输入标题文字'),
        size: st.size,
        color: st.color,
        bg: st.bg,
        bold: st.bold,
        align: st.align
      }
    });
    c.y = st.y || 0;
    S.project.clips.push(c);
    S.sel = c.id;
    S.multi.clear();
    if (needTrack) rebuildTracks();
    else { renderTimeline(); renderInspector(); applyTime(); scheduleSave(); }
    toast('已添加文字，可在右侧改内容');
    return c;
  }

  function splitAt(t) {
    t = t == null ? S.time : t;
    let target = null;
    if (S.sel) {
      const c = clipOf(S.sel);
      if (c && t > c.start + 0.04 && t < c.start + c.dur - 0.04) target = c;
    }
    if (!target) {
      for (const c of S.project.clips) {
        if (t > c.start + 0.04 && t < c.start + c.dur - 0.04) {
          if (!target || c.start > target.start) target = c;
        }
      }
    }
    if (!target) { toast('把播放头放在片段中间再分割'); return null; }
    return splitClip(target, t);
  }

  /* 把指定片段在时间 t 处切成两段（播放头分割与剃刀工具共用）。 */
  function splitClip(target, t) {
    if (!target) return null;
    if (t <= target.start + 0.04 || t >= target.start + target.dur - 0.04) return null;
    if (trackLocked(target.track)) { toast('轨道已锁定，先解锁'); return null; }
    pushHistory();
    const leftDur = t - target.start;
    const right = JSON.parse(JSON.stringify(target));
    right.id = uid('c');
    right.start = t;
    right.dur = target.dur - leftDur;
    right.in = round2(target.in + leftDur * target.speed);
    /* 关键帧按分割点切成两段，右段的时间轴归零 */
    right.kf = {};
    Object.keys(target.kf || {}).forEach(function (prop) {
      const arr = target.kf[prop];
      const left = arr.filter(function (k) { return k.t <= leftDur + 0.001; });
      const rightPts = arr.map(function (k) {
        return { t: round2(k.t - leftDur), v: k.v, ease: k.ease };
      }).filter(function (k) { return k.t >= -0.001; });
      if (left.length) target.kf[prop] = left;
      else delete target.kf[prop];
      if (rightPts.length) right.kf[prop] = rightPts;
    });
    target.dur = round2(leftDur);
    S.project.clips.push(right);
    S.sel = right.id;
    S.multi.clear();
    renderTimeline();
    renderInspector();
    applyTime();
    scheduleSave();
    toast('已在 ' + fmtMmss(t) + ' 处分割');
    return right;
  }

  function duplicateSelected() {
    const ids = selectedIds();
    const group = ids.map(clipOf).filter(Boolean);
    if (!group.length) { toast('先选中片段'); return null; }
    pushHistory();
    const end = Math.max.apply(null, group.map(function (c) { return c.start + c.dur; }));
    const minStart = Math.min.apply(null, group.map(function (c) { return c.start; }));
    const made = [];
    group.forEach(function (c) {
      const copy = JSON.parse(JSON.stringify(c));
      copy.id = uid('c');
      copy.start = round2(end + (c.start - minStart));
      copy.name = c.name + ' 副本';
      S.project.clips.push(copy);
      made.push(copy);
    });
    S.multi = new Set(made.map(function (c) { return c.id; }));
    S.sel = made[made.length - 1].id;
    if (S.multi.size < 2) S.multi.clear();
    renderTimeline();
    renderInspector();
    applyTime();
    scheduleSave();
    toast(made.length > 1 ? '已复制 ' + made.length + ' 个片段' : '已复制片段');
    return made[made.length - 1];
  }

  function shiftTrackAfter(trackId, fromT, delta, exceptId) {
    if (!delta) return;
    S.project.clips.forEach(function (x) {
      if (x.track !== trackId || x.id === exceptId) return;
      if (x.start >= fromT - 1e-4) x.start = round2(Math.max(0, x.start + delta));
    });
  }

  function deleteSelected(ripple) {
    const ids = selectedIds();
    if (!ids.length) { toast('先选中片段'); return false; }
    const group = ids.map(clipOf).filter(Boolean);
    if (group.some(function (c) { return trackLocked(c.track); })) {
      toast('选中片段所在轨道已锁定');
      return false;
    }
    pushHistory();
    const removedByTrack = {};
    group.forEach(function (c) {
      (removedByTrack[c.track] = removedByTrack[c.track] || []).push(c);
    });
    const drop = new Set(ids);
    S.project.clips = S.project.clips.filter(function (c) { return !drop.has(c.id); });
    if (ripple) {
      S.project.clips.forEach(function (c) {
        const rs = removedByTrack[c.track] || [];
        let shift = 0;
        rs.forEach(function (r) { if (r.start + r.dur <= c.start + 1e-4) shift += r.dur; });
        if (shift) c.start = round2(Math.max(0, c.start - shift));
      });
    }
    S.sel = '';
    S.multi.clear();
    renderTimeline();
    renderInspector();
    applyTime();
    scheduleSave();
    toast(ripple ? '已波纹删除 ' + group.length + ' 个片段' : '已删除 ' + group.length + ' 个片段');
    return true;
  }

  /* ---------------- 右键菜单 / 分离音频 ---------------- */
  function canDetachAudio(c) {
    if (!c || c.kind !== 'video') return false;
    const m = mediaOf(c.mediaId);
    return !!(m && m.kind === 'video' && m.url);
  }

  function audioDetachedFor(c) {
    return S.project.clips.some(function (x) {
      return x.kind === 'audio' && x.mediaId === c.mediaId &&
        Math.abs(x.start - c.start) < 0.02 && Math.abs(x.dur - c.dur) < 0.02;
    });
  }

  /* 把视频片段的音轨分离到音频轨：原片段静音，音频片段共用同一素材与入点。 */
  function detachAudio(id) {
    const c = clipOf(id);
    if (!canDetachAudio(c)) { toast('这条片段没有可分离的音频'); return null; }
    if (trackLocked(c.track)) { toast('轨道已锁定，先解锁'); return null; }
    if (audioDetachedFor(c)) { toast('这条片段的音频已经分离过'); return null; }
    let tr = preferredTrack('audio');
    if (tr && trackLocked(tr)) { toast('音频轨道已锁定，先解锁'); return null; }
    const needTrack = !tr;
    pushHistory();
    if (needTrack) tr = insertTrack('audio').id;
    const a = makeClip({
      track: tr,
      kind: 'audio',
      mediaId: c.mediaId,
      name: c.name + ' · 音频',
      start: c.start,
      dur: c.dur,
      in: c.in,
      speed: c.speed,
      volume: c.volume,
      muted: c.muted,
      fadeIn: c.fadeIn,
      fadeOut: c.fadeOut
    });
    if (c.kf && c.kf.volume) a.kf.volume = JSON.parse(JSON.stringify(c.kf.volume));
    S.project.clips.push(a);
    c.muted = true;
    S.sel = a.id;
    S.multi.clear();
    if (needTrack) rebuildTracks();
    else { renderTimeline(); renderInspector(); applyTime(); scheduleSave(); }
    toast('已分离音频到「' + trackOf(tr).name + '」');
    return a;
  }

  function clipMenuItems(c) {
    const lock = trackLocked(c.track);
    const inClip = S.time > c.start + 0.04 && S.time < c.start + c.dur - 0.04;
    const detached = audioDetachedFor(c);
    return [
      {
        id: 'split', label: '在播放头处分割', hint: 'S', disabled: !inClip || lock,
        run: function () { splitAt(S.time); }
      },
      {
        id: 'detach', label: detached ? '音频已分离' : '分离音频轨道',
        disabled: lock || !canDetachAudio(c) || detached,
        run: function () { detachAudio(c.id); }
      },
      {
        id: 'mute', label: c.muted ? '取消静音' : '静音', disabled: lock,
        run: function () { setClipProps(c.id, { muted: !c.muted }); }
      },
      { sep: true },
      { id: 'dup', label: '复制片段', hint: 'Ctrl+D', run: duplicateSelected },
      { id: 'del', label: '删除', hint: 'Del', run: function () { deleteSelected(false); } },
      { id: 'rdel', label: '波纹删除', hint: 'Shift+Del', run: function () { deleteSelected(true); } }
    ];
  }

  function closeClipMenu() {
    const el = $('stCtx');
    if (el) el.remove();
  }

  function openClipMenu(c, x, y) {
    closeClipMenu();
    if (!c) return;
    if (!isSelClip(c)) selectClip(c.id);
    const menu = document.createElement('div');
    menu.className = 'st-ctx';
    menu.id = 'stCtx';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = clipMenuItems(c).map(function (it) {
      if (it.sep) return '<span class="st-ctx-sep"></span>';
      return '<button type="button" role="menuitem" data-mi="' + it.id + '"' +
        (it.disabled ? ' disabled' : '') + '>' + escHtml(it.label) +
        (it.hint ? '<span class="st-ctx-hint">' + it.hint + '</span>' : '') + '</button>';
    }).join('');
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
    const items = clipMenuItems(c);
    menu.addEventListener('click', function (e) {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      const it = items.filter(function (x) { return x.id === b.dataset.mi; })[0];
      closeClipMenu();
      if (it && !it.disabled && it.run) it.run();
    });
  }

  function setClipProps(id, patch) {
    const c = clipOf(id);
    if (!c) return null;
    if (trackLocked(c.track)) { toast('轨道已锁定，先解锁'); return c; }
    Object.keys(patch || {}).forEach(function (k) {
      if (k === 'text') {
        Object.keys(patch.text || {}).forEach(function (tk) { c.text[tk] = patch.text[tk]; });
      } else if (k === 'kf') {
        c.kf = normalizeKf(patch.kf);
      } else if (k in c) {
        c[k] = patch[k];
      }
    });
    c.dur = Math.max(MIN_CLIP, Number(c.dur) || MIN_CLIP);
    c.start = Math.max(0, Number(c.start) || 0);
    renderRows();
    renderInspector();
    applyTime();
    scheduleSave();
    return c;
  }

  /* ---------------- 关键帧写入 ---------------- */
  function addKeyframe(id, prop, atT) {
    const c = clipOf(id);
    if (!c || KF_PROPS.indexOf(prop) < 0) return null;
    if (trackLocked(c.track)) { toast('轨道已锁定，先解锁'); return null; }
    const local = clamp((atT == null ? S.time : atT) - c.start, 0, c.dur);
    const v = propAt(c, prop, c.start + local);
    pushHistory();
    c.kf = c.kf || {};
    const arr = (c.kf[prop] || []).filter(function (k) { return Math.abs(k.t - local) > 0.02; });
    arr.push({ t: round2(local), v: Math.round(v * 1000) / 1000, ease: 'linear' });
    arr.sort(function (a, b) { return a.t - b.t; });
    c.kf[prop] = arr;
    renderRows();
    renderInspector();
    applyTime();
    scheduleSave();
    toast('已在 ' + fmtDur(local) + ' 处打点：' + prop);
    return c.kf[prop];
  }

  function clearKeyframes(id, prop) {
    const c = clipOf(id);
    if (!c) return false;
    pushHistory();
    if (prop) delete c.kf[prop];
    else c.kf = {};
    renderRows();
    renderInspector();
    applyTime();
    scheduleSave();
    return true;
  }

  /* ---------------- 剪辑手势（预览与测试共用） ---------------- */
  function trimClip(c, edge, dx, base, ripple) {
    const speed = c.speed || 1;
    if (edge === 'l') {
      if (ripple) {
        const d = clamp(dx, -base.in / speed, base.dur - MIN_CLIP);
        c.in = round2(Math.max(0, base.in + d * speed));
        c.dur = round2(base.dur - d);
        shiftTrackAfter(c.track, base.start + base.dur, -d, c.id);
      } else {
        let ns = clamp(base.start + dx, 0, base.start + base.dur - MIN_CLIP);
        ns = snapValue(ns, c.id, 0);
        const d = clamp(ns - base.start, -base.in / speed, base.dur - MIN_CLIP);
        c.start = round2(Math.max(0, base.start + d));
        c.in = round2(Math.max(0, base.in + d * speed));
        c.dur = round2(Math.max(MIN_CLIP, base.dur - d));
      }
    } else {
      let end = base.start + base.dur + dx;
      end = snapValue(end, c.id, 0);
      const dur = clamp(end - base.start, MIN_CLIP, maxDurFor(c, base.in));
      const d = dur - base.dur;
      c.dur = round2(dur);
      if (ripple) shiftTrackAfter(c.track, base.start + base.dur, d, c.id);
    }
    return c;
  }

  function rollClip(c, edge, dx, base) {
    const speed = c.speed || 1;
    if (edge === 'r') {
      const endT = base.start + base.dur;
      const next = S.project.clips.filter(function (x) {
        return x.track === c.track && x.id !== c.id && Math.abs(x.start - endT) < 0.06;
      })[0];
      if (!next) return trimClip(c, 'r', dx, base, false);
      const lo = Math.max(-base.dur + MIN_CLIP, -next.in / speed);
      const hi = Math.min(maxDurFor(c, base.in) - base.dur, next.dur - MIN_CLIP);
      const d = clamp(dx, lo, hi);
      c.dur = round2(base.dur + d);
      next.start = round2(next.start + d);
      next.in = round2(Math.max(0, next.in + d * speed));
      next.dur = round2(Math.max(MIN_CLIP, next.dur - d));
    } else {
      const prev = S.project.clips.filter(function (x) {
        return x.track === c.track && x.id !== c.id && Math.abs(x.start + x.dur - base.start) < 0.06;
      })[0];
      if (!prev) return trimClip(c, 'l', dx, base, false);
      const lo = Math.max(-prev.dur + MIN_CLIP, -base.in / speed);
      const hi = Math.min(base.dur - MIN_CLIP, maxDurFor(prev, prev.in) - prev.dur);
      const d = clamp(dx, lo, hi);
      c.start = round2(base.start + d);
      c.in = round2(Math.max(0, base.in + d * speed));
      c.dur = round2(base.dur - d);
      prev.dur = round2(prev.dur + d);
    }
    return c;
  }

  function slipClip(c, dx, baseIn) {
    if (c.kind === 'text') return c;
    const m = mediaOf(c.mediaId);
    if (!m || m.kind === 'image' || !m.dur) return c;
    const speed = c.speed || 1;
    const maxIn = Math.max(0, m.dur - c.dur * speed);
    c.in = round2(clamp((baseIn == null ? c.in : baseIn) + dx * speed, 0, maxIn));
    return c;
  }

  function slideClip(c, dx) {
    const speed = c.speed || 1;
    const start = c.start;
    const end = c.start + c.dur;
    const next = S.project.clips.filter(function (x) {
      return x.track === c.track && x.id !== c.id && Math.abs(x.start - end) < 0.06;
    })[0];
    const prev = S.project.clips.filter(function (x) {
      return x.track === c.track && x.id !== c.id && Math.abs(x.start + x.dur - start) < 0.06;
    })[0];
    let lo = -start;
    let hi = Infinity;
    if (prev) lo = Math.max(lo, -(prev.dur - MIN_CLIP));
    if (next) {
      lo = Math.max(lo, -next.in / speed);
      hi = Math.min(hi, next.dur - MIN_CLIP);
    }
    const d = clamp(dx, lo, hi);
    c.start = round2(start + d);
    if (prev) prev.dur = round2(prev.dur + d);
    if (next) {
      next.start = round2(next.start + d);
      next.in = round2(Math.max(0, next.in + d * speed));
      next.dur = round2(next.dur - d);
    }
    return c;
  }

  /* ---------------- 时间线拖拽 ---------------- */
  function onTimelineDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const trim = e.target.closest('.st-trim');
    const clipNode = e.target.closest('.st-clip');
    const row = e.target.closest('.st-row');
    if (!clipNode) {
      if (!row) return;
      selectClip('');
      S.drag = { mode: 'scrub', pointerId: e.pointerId };
      seek(timeAtX(e.clientX));
      e.preventDefault();
      return;
    }
    const c = clipOf(clipNode.dataset.id);
    if (!c) return;
    if (trackLocked(c.track)) { toast('轨道已锁定，先解锁'); return; }
    if (S.tool === 'blade') {
      const at = timeAtX(e.clientX);
      if (at <= c.start + 0.04 || at >= c.start + c.dur - 0.04) {
        toast('点在片段中间才能切割');
      } else {
        splitClip(c, at);
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const additive = e.shiftKey || ((e.ctrlKey || e.metaKey) && !isSelClip(c));
    if (additive) selectClip(c.id, true);
    else if (!isSelClip(c)) selectClip(c.id);
    else { S.sel = c.id; paintSel(); renderInspector(); }

    const edge = trim ? trim.dataset.edge : '';
    let mode = 'move';
    if (edge) {
      if (e.altKey) mode = edge === 'l' ? 'rippleL' : 'rippleR';
      else if (e.ctrlKey || e.metaKey) mode = edge === 'l' ? 'rollL' : 'rollR';
      else mode = edge === 'l' ? 'trimL' : 'trimR';
    } else if (e.altKey) mode = 'slip';
    else if ((e.ctrlKey || e.metaKey) && !additive) mode = 'slide';

    const group = selectedIds().map(clipOf).filter(Boolean);
    pushHistory();
    S.drag = {
      mode: mode,
      id: c.id,
      x0: e.clientX,
      y0: e.clientY,
      start0: c.start,
      dur0: c.dur,
      in0: c.in,
      track0: c.track,
      items: group.map(function (x) { return { id: x.id, start: x.start, track: x.track }; }),
      changed: false,
      pointerId: e.pointerId
    };
    try { $('stRows').setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e) {
    const d = S.drag;
    if (!d) return;
    if (d.mode === 'scrub') { seek(timeAtX(e.clientX)); return; }
    if (d.mode === 'height') {
      setTrackHeight(d.id, d.h0 + (e.clientY - d.y0));
      d.changed = true;
      return;
    }
    const c = clipOf(d.id);
    if (!c) { S.drag = null; return; }
    const dx = (e.clientX - d.x0) / S.pps;

    if (d.mode === 'move') {
      if (d.items.length > 1) {
        const anchor = snapValue(d.start0 + dx, c.id, c.dur);
        const delta = anchor - d.start0;
        d.items.forEach(function (it) {
          const x = clipOf(it.id);
          if (x) x.start = round2(Math.max(0, it.start + delta));
        });
      } else {
        const tr = trackAtY(e.clientY);
        if (tr && tr !== c.track && trackCompat(c.kind, tr) && !trackLocked(tr) &&
          Math.abs(e.clientY - d.y0) > 12) {
          c.track = tr;
        }
        c.start = round2(Math.max(0, snapValue(d.start0 + dx, c.id, c.dur)));
      }
    } else if (d.mode === 'trimL' || d.mode === 'trimR') {
      trimClip(c, d.mode === 'trimL' ? 'l' : 'r', dx,
        { start: d.start0, dur: d.dur0, in: d.in0 }, false);
    } else if (d.mode === 'rippleL' || d.mode === 'rippleR') {
      trimClip(c, d.mode === 'rippleL' ? 'l' : 'r', dx,
        { start: d.start0, dur: d.dur0, in: d.in0 }, true);
    } else if (d.mode === 'rollL' || d.mode === 'rollR') {
      rollClip(c, d.mode === 'rollL' ? 'l' : 'r', dx,
        { start: d.start0, dur: d.dur0, in: d.in0 });
    } else if (d.mode === 'slip') {
      slipClip(c, dx, d.in0);
    } else if (d.mode === 'slide') {
      slideClip(c, dx);
    }
    d.changed = true;
    if (d.mode === 'move' && d.items.length > 1) {
      renderRows();
    } else {
      liveClipEl(c);
    }
    applyTime();
  }

  function onPointerUp() {
    const d = S.drag;
    if (!d) return;
    S.drag = null;
    if (d.mode === 'scrub') return;
    if (!d.changed) { dropHistory(); return; }
    renderRows();
    renderInspector();
    applyTime();
    scheduleSave();
  }

  /* ---------------- 从素材池拖进轨道 ---------------- */
  function clearDrop() {
    S.drop = null;
    const line = $('stDrop');
    if (line) line.classList.add('hidden');
    document.querySelectorAll('.st-row.dragover,.st-row.dropbad').forEach(function (r) {
      r.classList.remove('dragover', 'dropbad');
    });
  }

  function onTimelineDragOver(e) {
    if (!S.dragMediaId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    const m = mediaOf(S.dragMediaId);
    const tr = trackAtY(e.clientY);
    const tk = trackOf(tr);
    const ok = !!m && trackCompat(m.kind, tr) && !trackLocked(tr);
    S.drop = { track: tr, time: timeAtX(e.clientX), ok: ok };
    document.querySelectorAll('.st-row').forEach(function (r) {
      r.classList.toggle('dragover', ok && r.dataset.track === tr);
      r.classList.toggle('dropbad', !ok && r.dataset.track === tr);
    });
    const line = $('stDrop');
    if (line) {
      line.classList.remove('hidden');
      line.style.left = (S.drop.time * S.pps).toFixed(1) + 'px';
      line.style.top = (RULER_H + rowTopOf(tr)) + 'px';
      line.style.height = (tk ? tk.height : 46) + 'px';
      line.style.background = ok ? '' : '#d9534f';
    }
  }

  function onTimelineDrop(e) {
    if (!S.dragMediaId) return;
    e.preventDefault();
    const id = S.dragMediaId;
    const drop = S.drop;
    S.dragMediaId = '';
    clearDrop();
    if (!drop) return;
    if (!drop.ok) { toast('这条轨道放不下该素材'); return; }
    addMediaClip(id, drop.track, drop.time);
  }

  /* ---------------- 素材池 ---------------- */
  function mediaCard(m) {
    const kindTxt = m.kind === 'video' ? 'VIDEO' : m.kind === 'audio' ? 'AUDIO' : 'IMAGE';
    let thumb;
    if (m.kind === 'image') {
      thumb = '<img src="' + escHtml(m.url) + '" alt="">';
    } else if (m.kind === 'video') {
      thumb = '<video src="' + escHtml(m.url) + '" muted preload="metadata"></video>';
    } else {
      thumb = '<span class="st-mico">' + svgWrap('<path d="M4 10.2v3.6M7.2 7.6v8.8M10.4 5.4v13.2M13.6 8.4v7.2M16.8 6.4v11.2M20 9.4v5.2"/>') + '</span>';
    }
    return '<div class="st-mcard' + (S.mediaSel === m.id ? ' sel' : '') + '" draggable="true" data-id="' + m.id +
      '" title="双击加入时间线">' +
      '<div class="st-mthumb">' + thumb + '<span class="st-mkind">' + kindTxt + '</span>' +
      '<button type="button" class="st-madd" data-add="' + m.id + '" title="加入时间线">＋</button></div>' +
      '<div class="st-mname">' + escHtml(m.name) + '</div>' +
      '<div class="st-mmeta">' + (m.kind === 'image' ? '图片 · 默认 5 秒' : fmtDur(m.dur)) +
      (m.source === 'library' ? ' · 视频库' : '') + '</div></div>';
  }

  function renderMedia() {
    const grid = $('stMediaGrid');
    const empty = $('stMediaEmpty');
    if (!grid) return;
    const q = ($('stMediaSearch') && $('stMediaSearch').value || '').trim().toLowerCase();
    const list = S.project.media.filter(function (m) {
      return !q || m.name.toLowerCase().indexOf(q) >= 0;
    });
    grid.innerHTML = list.map(mediaCard).join('');
    if (empty) empty.classList.toggle('hidden', list.length > 0);
    grid.querySelectorAll('video').forEach(function (v) {
      v.addEventListener('loadedmetadata', function () {
        try { v.currentTime = Math.min(0.8, Math.max(0.1, v.duration * 0.15)); } catch (e) {}
      }, { once: true });
    });
    const ag = $('stAudioGrid');
    if (ag) {
      const auds = S.project.media.filter(function (m) { return m.kind === 'audio'; });
      ag.innerHTML = auds.map(mediaCard).join('');
      if (!auds.length) ag.innerHTML = '<div class="st-empty"><b>还没有音频</b><span>导入音频后，会出现在这里和「媒体」面板</span></div>';
    }
  }

  function probeDuration(url, kind) {
    return new Promise(function (resolve) {
      if (kind === 'image' || !url) { resolve(0); return; }
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
      let done = false;
      const finish = function (v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { el.removeAttribute('src'); el.load(); } catch (e) {}
        resolve(Math.max(0, Number(v) || 0));
      };
      const timer = setTimeout(function () { finish(0); }, 6000);
      el.preload = 'metadata';
      el.onloadedmetadata = function () { finish(isFinite(el.duration) ? el.duration : 0); };
      el.onerror = function () { finish(0); };
      el.src = url;
    });
  }

  function kindOfFile(file) {
    const t = String(file.type || '');
    if (/^video\//.test(t)) return 'video';
    if (/^audio\//.test(t)) return 'audio';
    if (/^image\//.test(t)) return 'image';
    const n = String(file.name || '').toLowerCase();
    if (/\.(mp4|webm|mov|m4v|ogv|mkv)$/.test(n)) return 'video';
    if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(n)) return 'audio';
    if (/\.(png|jpe?g|webp|gif|bmp)$/.test(n)) return 'image';
    return '';
  }

  async function importFiles(files) {
    const arr = Array.prototype.slice.call(files || []);
    const usable = arr.map(function (f) { return { f: f, kind: kindOfFile(f) }; })
      .filter(function (x) { return !!x.kind; });
    if (!usable.length) { toast('没有可用的视频 / 音频 / 图片文件'); return []; }
    toast('正在导入 ' + usable.length + ' 个素材…');
    pushHistory();
    const out = [];
    for (const item of usable) {
      const url = URL.createObjectURL(item.f);
      const dur = item.kind === 'image' ? 5 : (await probeDuration(url, item.kind)) || 5;
      const m = {
        id: uid('m'),
        name: item.f.name || ('素材' + (out.length + 1)),
        kind: item.kind,
        url: url,
        dur: round2(dur),
        source: 'file',
        libId: ''
      };
      S.project.media.push(m);
      out.push(m);
    }
    renderAll();
    scheduleSave();
    toast('已导入 ' + out.length + ' 个素材，双击可加入时间线（文件素材不会写进项目存档）');
    return out;
  }

  /* ---------------- 视频库 ---------------- */
  async function openLibrary() {
    const modal = $('stLibModal');
    const list = $('stLibList');
    if (!modal || !list) return;
    S.libPick = new Set();
    modal.classList.remove('hidden');
    list.innerHTML = '<div class="st-modal-empty">正在读取视频库…</div>';
    const pa = window.playerApp;
    let files = [];
    if (!pa) {
      list.innerHTML = '<div class="st-modal-empty">当前页面没有加载视频库模块，请直接「导入文件」。</div>';
      return;
    }
    try {
      if (typeof pa.hasLib === 'function' && !pa.hasLib()) {
        list.innerHTML = '<div class="st-modal-empty">浏览器环境读不到视频库。<br>请用桌面版，或直接用「导入文件」。</div>';
        return;
      }
      if (typeof pa.refresh === 'function') await pa.refresh();
      if (typeof pa.files === 'function') files = pa.files() || [];
    } catch (e) { files = []; }
    S.libFiles = files.filter(function (f) {
      return f && (f.kind === 'video' || f.kind === 'audio' || f.kind === 'image');
    });
    renderLibList('');
  }

  function libUrl(f) {
    const pa = window.playerApp;
    if (pa && typeof pa._urlOf === 'function') return pa._urlOf(f);
    return '';
  }

  function renderLibList(q) {
    const list = $('stLibList');
    if (!list) return;
    const query = String(q || '').trim().toLowerCase();
    const files = S.libFiles.filter(function (f) {
      return !query || String(f.name || '').toLowerCase().indexOf(query) >= 0;
    });
    const cnt = $('stLibCount');
    if (cnt) cnt.textContent = '共 ' + files.length + ' 条';
    if (!files.length) {
      list.innerHTML = '<div class="st-modal-empty">视频库里还没有素材。<br>先到「视频库」导入文件，再回来挑。</div>';
      updateLibAdd();
      return;
    }
    list.innerHTML = files.map(function (f) {
      const added = S.project.media.some(function (m) { return m.libId === String(f.id); });
      const on = S.libPick.has(String(f.id));
      return '<div class="st-librow' + (on ? ' on' : '') + (added ? ' added' : '') + '" data-lib="' + escHtml(String(f.id)) + '">' +
        '<span class="st-libico">' + (f.kind === 'video' ? 'VID' : f.kind === 'audio' ? 'AUD' : 'IMG') + '</span>' +
        '<span class="st-libname">' + escHtml(f.name || '素材') + '</span>' +
        '<span class="st-libmeta">' + (added ? '已在素材库' : '点击选择') + '</span></div>';
    }).join('');
    updateLibAdd();
  }

  function updateLibAdd() {
    const btn = $('stLibAdd');
    if (!btn) return;
    const n = S.libPick.size;
    btn.disabled = n === 0;
    btn.textContent = n ? '加入素材库（' + n + '）' : '加入素材库';
  }

  async function addFromLibrary() {
    if (!S.libPick.size) return;
    const pa = window.playerApp;
    const picks = S.libFiles.filter(function (f) { return S.libPick.has(String(f.id)); });
    toast('正在加入 ' + picks.length + ' 个素材…');
    const newMedia = [];
    for (const f of picks) {
      const libId = String(f.id);
      if (S.project.media.some(function (m) { return m.libId === libId; })) continue;
      const url = libUrl(f);
      if (!url) continue;
      const kind = f.kind;
      const dur = kind === 'image' ? 5 : (await probeDuration(url, kind)) || 5;
      newMedia.push({
        id: 'lib:' + libId,
        name: String(f.name || '素材'),
        kind: kind,
        url: url,
        dur: round2(dur),
        source: 'library',
        libId: libId
      });
    }
    if (newMedia.length) {
      S.project.media = S.project.media.concat(newMedia);
      renderAll();
      scheduleSave();
    }
    $('stLibModal').classList.add('hidden');
    toast(newMedia.length ? ('已加入 ' + newMedia.length + ' 个视频库素材') : '这些素材已经在素材库里了');
    void pa;
  }

  /* ---------------- 检查器 ---------------- */
  function rng(label, prop, val, min, max, step, display) {
    return '<label class="st-field"><span>' + label + '</span>' +
      '<input type="range" data-prop="' + prop + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">' +
      '<i class="st-fval" data-fval="' + prop + '">' + display + '</i></label>';
  }
  function num(label, prop, val, min, max, step, unit) {
    return '<label class="st-field"><span>' + label + '</span>' +
      '<input type="number" data-prop="' + prop + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">' +
      '<i class="st-fval">' + (unit || '') + '</i></label>';
  }

  function trackPanel() {
    return '<div class="st-insp-sec"><h4>轨道<em>' + tracks().length + ' 条</em></h4>' +
      tracks().map(function (t) {
        return '<div class="st-tkrow" data-tk="' + t.id + '"><b>' + escHtml(t.name) + '</b>' +
          ['locked', 'muted', 'solo', 'hidden'].map(function (k) {
            const icon = k === 'locked' ? 'lock' :
              k === 'muted' ? (t.muted ? 'mute' : 'sound') :
                k === 'solo' ? 'solo' : (t.hidden ? 'eyeOff' : 'eye');
            const label = { locked: '锁定轨道', muted: '静音轨道', solo: '独奏轨道', hidden: '隐藏轨道' }[k];
            return '<button type="button" class="st-tkb' + (t[k] ? ' on' : '') + '" data-tkf="' + k +
              '" data-tk="' + t.id + '" title="' + label + '" aria-label="' + label + '">' + ico(icon) + '</button>';
          }).join('') +
          '<button type="button" class="st-tkb del" data-tkdel="' + t.id + '" title="删除空轨道" aria-label="删除空轨道">' + ico('trash') + '</button></div>';
      }).join('') +
      '<div class="st-tkadd"><button type="button" class="st-ghost st-tkbtn" data-addtk="video" title="新增视频轨" aria-label="新增视频轨">' + ico('film') + '</button>' +
      '<button type="button" class="st-ghost st-tkbtn" data-addtk="text" title="新增文字轨" aria-label="新增文字轨">' + ico('text') + '</button>' +
      '<button type="button" class="st-ghost st-tkbtn" data-addtk="audio" title="新增音频轨" aria-label="新增音频轨">' + ico('audio') + '</button></div></div>';
  }

  function snapshotPanel() {
    if (!S.snapshots.length) {
      return '<div class="st-insp-sec"><h4>快照<em>0</em></h4>' +
        '<div class="st-insp-empty">编辑过程中每 5 分钟自动留一份快照，用于崩溃恢复。</div></div>';
    }
    const list = S.snapshots.map(function (s, i) { return { s: s, i: i }; }).slice(-3).reverse();
    return '<div class="st-insp-sec"><h4>快照<em>' + S.snapshots.length + '</em></h4>' +
      list.map(function (x) {
        const d = new Date(x.s.at);
        const hm = String(d.getMinutes()).padStart(2, '0');
        const label = d.getMonth() + 1 + '/' + d.getDate() + ' ' + d.getHours() + ':' + hm;
        return '<button type="button" class="st-ghost st-wide" data-snap="' + x.i + '">恢复 ' + label +
          ' · ' + fmtMmss(projectDuration(normalizeProject(x.s.project))) + '</button>';
      }).join('') + '</div>';
  }

  function projectPanel() {
    const resId = S.project.w + 'x' + S.project.h;
    const opts = RES_PRESETS.map(function (r) {
      return '<option value="' + r.id + '"' + (r.id === resId ? ' selected' : '') + '>' + r.name + '</option>';
    }).join('') + (RES_PRESETS.some(function (r) { return r.id === resId; }) ? '' :
      '<option value="' + resId + '" selected>' + S.project.w + ' × ' + S.project.h + '</option>');
    const fps = [24, 25, 30, 50, 60].map(function (f) {
      return '<option value="' + f + '"' + (f === S.project.fps ? ' selected' : '') + '>' + f + ' fps</option>';
    }).join('');
    return '<div class="st-insp-sec"><h4>项目<em>' + fmtMmss(projectDuration(S.project)) + '</em></h4>' +
      '<label class="st-field wide"><span>名称</span><input type="text" data-proj="name" value="' + escHtml(S.project.name) + '"></label>' +
      '<label class="st-field wide"><span>画布</span><select data-proj="res">' + opts + '</select></label>' +
      '<label class="st-field wide"><span>帧率</span><select data-proj="fps">' + fps + '</select></label>' +
      '<div class="st-insp-empty">素材 ' + S.project.media.length + ' 个 · 片段 ' + S.project.clips.length +
      ' 条 · 标记 ' + S.project.markers.length + ' 个</div></div>' +
      trackPanel() + snapshotPanel() +
      '<div class="st-insp-sec"><h4>操作提示</h4><div class="st-insp-empty"><ul>' +
      '<li>拖素材到轨道，或双击素材自动追加</li>' +
      '<li>Alt+拖边缘＝波纹裁剪，Ctrl+拖边缘＝滚动剪辑</li>' +
      '<li>Alt+拖片段＝滑移，Ctrl+拖片段＝滑动</li>' +
      '<li>Shift/Ctrl+点选多选，拖任意一个整体移动</li>' +
      '<li>空格播放，S 分割，M 打标记，Delete 删除</li>' +
      '<li>Shift+Delete 波纹删除，Ctrl+Z / Ctrl+Shift+Z 撤销重做</li>' +
      '</ul></div></div>';
  }

  function kfPanel(c) {
    const labels = { opacity: '透明', scale: '缩放', x: '水平', y: '垂直', rot: '旋转', volume: '音量' };
    const props = KF_PROPS.filter(function (p) { return c.kind !== 'text' || p !== 'volume'; });
    const sum = props.filter(function (p) { return c.kf && c.kf[p] && c.kf[p].length; })
      .map(function (p) { return labels[p] + ' ' + c.kf[p].length; }).join(' · ');
    return '<div class="st-insp-sec"><h4>关键帧</h4>' +
      '<div class="st-kfrow">' + props.map(function (p) {
        const icon = { opacity: 'kfOpacity', scale: 'kfScale', x: 'kfX', y: 'kfY', rot: 'kfRot', volume: 'kfVolume' }[p];
        return '<button type="button" class="st-kfbtn" data-kf="' + p +
          '" title="在播放头为「' + labels[p] + '」打关键帧" aria-label="为' + labels[p] + '打关键帧">' + ico(icon) + '</button>';
      }).join('') + '</div>' +
      '<div class="st-kfsum">' + (sum || '暂无关键帧，打点后可做补间动画') +
      (sum ? ' <button type="button" class="st-kfclear" data-act="kfclear" title="清除关键帧" aria-label="清除关键帧">' + ico('eraser') + '</button>' : '') + '</div></div>';
  }

  function renderInspector() {
    const box = $('stInspector');
    if (!box) return;
    const c = selected();
    if (!c) { box.innerHTML = projectPanel(); return; }
    const isText = c.kind === 'text';
    const isVisual = c.kind === 'video' || c.kind === 'image';
    const m = c.mediaId ? mediaOf(c.mediaId) : null;
    const multiN = S.multi.size;
    let html = '<div class="st-insp-sec"><h4>片段<em>' + kindLabel(c.kind) + (m ? ' · ' + escHtml(m.name) : '') +
      (multiN > 1 ? ' · 已选 ' + multiN + ' 个' : '') + '</em></h4>' +
      '<label class="st-field wide"><span>名称</span><input type="text" data-prop="name" value="' + escHtml(c.name) + '"></label>' +
      num('起点', 'start', c.start.toFixed(2), 0, 3600, 0.1, 's') +
      num('时长', 'dur', c.dur.toFixed(2), MIN_CLIP, 3600, 0.1, 's');
    if (!isText) html += num('入点', 'in', c.in.toFixed(2), 0, 3600, 0.1, 's');
    html += '</div>';

    if (isText) {
      html += '<div class="st-insp-sec"><h4>文字</h4>' +
        '<textarea data-prop="textContent" placeholder="输入文字…">' + escHtml(c.text.content) + '</textarea>' +
        '<label class="st-field"><span>字号</span><input type="range" data-prop="textSize" min="10" max="220" step="1" value="' + c.text.size + '"><i class="st-fval" data-fval="textSize">' + c.text.size + 'px</i></label>' +
        '<div class="st-colorfield"><input type="color" data-prop="textColor" value="' + (/^#[0-9a-f]{6}$/i.test(c.text.color) ? c.text.color : '#ffffff') + '"><input type="text" data-prop="textColor" value="' + escHtml(c.text.color) + '"></div>' +
        '<label class="st-field wide"><span>底色</span><select data-prop="textBg">' +
        ['rgba(0,0,0,0)', 'rgba(0,0,0,.45)', 'rgba(0,0,0,.62)', 'rgba(255,255,255,.82)'].map(function (bg) {
          return '<option value="' + bg + '"' + (bg === c.text.bg ? ' selected' : '') + '>' +
            (bg === 'rgba(0,0,0,0)' ? '透明' : bg === 'rgba(255,255,255,.82)' ? '浅色底' : '深色底') + '</option>';
        }).join('') + '</select></label>' +
        '<label class="st-field wide"><span>对齐</span><select data-prop="textAlign">' +
        [['center', '居中'], ['left', '左对齐'], ['right', '右对齐']].map(function (a) {
          return '<option value="' + a[0] + '"' + (a[0] === c.text.align ? ' selected' : '') + '>' + a[1] + '</option>';
        }).join('') + '</select></label>' +
        '<label class="st-checkrow"><input type="checkbox" data-prop="textBold"' + (c.text.bold ? ' checked' : '') + '> 加粗</label>' +
        '</div>';
    }

    if (isVisual || isText) {
      html += '<div class="st-insp-sec"><h4>画面</h4>' +
        rng('缩放', 'scalePct', Math.round(c.scale * 100), 20, 300, 1, Math.round(c.scale * 100) + '%') +
        rng('水平', 'x', Math.round(c.x), -50, 50, 1, Math.round(c.x) + '%') +
        rng('垂直', 'y', Math.round(c.y), -50, 50, 1, Math.round(c.y) + '%') +
        rng('旋转', 'rot', Math.round(c.rot), -180, 180, 1, Math.round(c.rot) + '°') +
        rng('透明', 'opacityPct', Math.round(c.opacity * 100), 0, 100, 1, Math.round(c.opacity * 100) + '%');
      if (isVisual) {
        html += '<label class="st-field wide"><span>滤镜</span><select data-prop="filter">' +
          FILTERS.map(function (f) {
            return '<option value="' + f.id + '"' + (f.id === c.filter ? ' selected' : '') + '>' + f.name + '</option>';
          }).join('') + '</select></label>';
      }
      html += '</div>';
    }

    if (!isText) {
      html += '<div class="st-insp-sec"><h4>声音与速度</h4>' +
        rng('音量', 'volumePct', Math.round(c.volume * 100), 0, 100, 1, Math.round(c.volume * 100) + '%') +
        '<label class="st-checkrow"><input type="checkbox" data-prop="muted"' + (c.muted ? ' checked' : '') + '> 静音本片段</label>' +
        rng('速度', 'speed', c.speed, 0.25, 4, 0.05, c.speed.toFixed(2) + 'x') +
        '</div>';
    }

    html += '<div class="st-insp-sec"><h4>动画</h4>' +
      rng('淡入', 'fadeIn', c.fadeIn, 0, 5, 0.1, c.fadeIn.toFixed(1) + 's') +
      rng('淡出', 'fadeOut', c.fadeOut, 0, 5, 0.1, c.fadeOut.toFixed(1) + 's') +
      '</div>';

    html += kfPanel(c);

    html += '<div class="st-insp-act"><button type="button" class="st-ghost st-icobtn" data-act="dup" title="复制片段" aria-label="复制片段">' + ico('copy') + '</button>' +
      '<button type="button" class="st-ghost st-icobtn" data-act="del" title="删除片段" aria-label="删除片段">' + ico('trash') + '</button>' +
      '<button type="button" class="st-ghost st-icobtn" data-act="rdel" title="波纹删除" aria-label="波纹删除">' + ico('rippleDel') + '</button></div>';
    box.innerHTML = html;
    paintFxSel();
  }

  function paintFxSel() {
    const c = selected();
    document.querySelectorAll('#stFxGrid .st-fxcard').forEach(function (n) {
      n.classList.toggle('on', !!c && c.filter === n.dataset.fx);
    });
  }

  function setFVal(prop, target, c) {
    const out = document.querySelector('[data-fval="' + prop + '"]');
    if (!out) return;
    if (prop === 'scalePct') out.textContent = Math.round(c.scale * 100) + '%';
    else if (prop === 'opacityPct') out.textContent = Math.round(c.opacity * 100) + '%';
    else if (prop === 'volumePct') out.textContent = Math.round(c.volume * 100) + '%';
    else if (prop === 'rot') out.textContent = Math.round(c.rot) + '°';
    else if (prop === 'x' || prop === 'y') out.textContent = Math.round(prop === 'x' ? c.x : c.y) + '%';
    else if (prop === 'speed') out.textContent = c.speed.toFixed(2) + 'x';
    else if (prop === 'fadeIn') out.textContent = c.fadeIn.toFixed(1) + 's';
    else if (prop === 'fadeOut') out.textContent = c.fadeOut.toFixed(1) + 's';
    else if (prop === 'textSize') out.textContent = c.text.size + 'px';
    void target;
  }

  function onInspectorInput(e) {
    const target = e.target;
    if (!target || !target.dataset) return;
    if (target.dataset.proj) { onProjectInput(target); return; }
    const prop = target.dataset.prop;
    if (!prop) return;
    const c = selected();
    if (!c) return;
    const v = target.type === 'checkbox' ? !!target.checked : target.value;
    switch (prop) {
      case 'name': c.name = String(v).trim() || '片段'; break;
      case 'start': c.start = Math.max(0, Number(v) || 0); break;
      case 'dur': c.dur = clamp(Number(v) || MIN_CLIP, MIN_CLIP, maxDurFor(c, c.in)); break;
      case 'in': c.in = clamp(Number(v) || 0, 0, Math.max(0, (mediaOf(c.mediaId) || {}).dur || 0)); break;
      case 'scalePct': c.scale = clamp(Number(v), 20, 300) / 100; break;
      case 'x': c.x = clamp(Number(v) || 0, -50, 50); break;
      case 'y': c.y = clamp(Number(v) || 0, -50, 50); break;
      case 'rot': c.rot = clamp(Number(v) || 0, -180, 180); break;
      case 'opacityPct': c.opacity = clamp(Number(v), 0, 100) / 100; break;
      case 'volumePct': c.volume = clamp(Number(v), 0, 100) / 100; break;
      case 'muted': c.muted = !!v; break;
      case 'speed': c.speed = clamp(Number(v) || 1, 0.25, 4); break;
      case 'fadeIn': c.fadeIn = clamp(Number(v) || 0, 0, 5); break;
      case 'fadeOut': c.fadeOut = clamp(Number(v) || 0, 0, 5); break;
      case 'filter': c.filter = String(v); break;
      case 'textContent': c.text.content = String(v); break;
      case 'textSize': c.text.size = clamp(Number(v) || 64, 10, 220); break;
      case 'textColor': c.text.color = String(v); break;
      case 'textBg': c.text.bg = String(v); break;
      case 'textBold': c.text.bold = !!v; break;
      case 'textAlign': c.text.align = String(v); break;
    }
    setFVal(prop, target, c);
    if (prop === 'name' || prop === 'start' || prop === 'dur' || prop === 'in' || prop === 'speed') {
      renderRows();
      liveClipEl(c);
    }
    applyTime();
    scheduleSave();
  }

  function onInspectorChange(e) {
    const target = e.target;
    if (!target || !target.dataset) return;
    if (S.inspSnap && snap() !== S.inspSnap) {
      S.hist.push(S.inspSnap);
      if (S.hist.length > MAX_HIST) S.hist.shift();
      S.future.length = 0;
      paintUndo();
    }
    S.inspSnap = '';
    if (target.dataset.prop === 'name') renderInspector();
    scheduleSave();
  }

  function onProjectInput(el) {
    const key = el.dataset.proj;
    if (key === 'name') {
      S.project.name = String(el.value).trim() || '未命名项目';
      $('stProjName').textContent = S.project.name;
    } else if (key === 'res') {
      const parts = String(el.value).split('x');
      S.project.w = Math.max(320, Number(parts[0]) || 1920);
      S.project.h = Math.max(180, Number(parts[1]) || 1080);
      fitFrame();
      S.textSig = '';
      applyTime();
    } else if (key === 'fps') {
      S.project.fps = Number(el.value) || 30;
      paintTc();
    }
    scheduleSave();
  }

  /* ---------------- 统一渲染 ---------------- */
  function trackSig() {
    return tracks().map(function (t) { return t.id + ':' + t.kind + ':' + t.height; }).join('|');
  }

  function ensureTrackDom() {
    const sig = trackSig();
    if (sig === S.trackSig) return;
    S.trackSig = sig;
    buildPools();
    buildTrackHeads();
  }

  function renderAll() {
    ensureTrackDom();
    const pn = $('stProjName');
    if (pn) pn.textContent = S.project.name || '未命名项目';
    setTool(S.tool);
    const zv = $('stZoomVal');
    if (zv) zv.textContent = String(Math.round(S.pps));
    const lb = $('stLoop');
    if (lb) lb.classList.toggle('on', S.loop);
    renderMedia();
    renderTimeline();
    renderInspector();
    paintUndo();
    paintTc();
    updateEmpty();
  }

  /* ---------------- 交互绑定 ---------------- */
  function setZoom(v) {
    const sc = $('stScroll');
    const center = sc ? (sc.scrollLeft + sc.clientWidth / 2) / S.pps : 0;
    S.pps = clamp(Number(v) || 80, 32, 240);
    const z = $('stZoom');
    if (z) z.value = S.pps;
    const zv = $('stZoomVal');
    if (zv) zv.textContent = String(Math.round(S.pps));
    renderTimeline();
    if (sc) sc.scrollLeft = Math.max(0, center * S.pps - sc.clientWidth / 2);
    applyTime();
  }

  /* 适配时间线：把整条片子的时长铺满时间线可视宽度。 */
  function fitTimeline() {
    const sc = $('stScroll');
    const dur = Math.max(1, projectDuration(S.project));
    const w = Math.max(240, (sc ? sc.clientWidth : 800) - 32);
    setZoom(w / (dur + 0.6));
    if (sc) sc.scrollLeft = 0;
  }

  function setTool(name) {
    S.tool = name === 'blade' ? 'blade' : 'select';
    const a = $('stToolSelect');
    const b = $('stToolBlade');
    if (a) a.classList.toggle('on', S.tool === 'select');
    if (b) b.classList.toggle('on', S.tool === 'blade');
    const rows = $('stRows');
    if (rows) rows.classList.toggle('blade', S.tool === 'blade');
  }

  function selectAllClips() {
    if (!S.project.clips.length) { toast('时间线上还没有片段'); return 0; }
    S.multi = new Set(S.project.clips.map(function (c) { return c.id; }));
    S.sel = '';
    paintSel();
    renderInspector();
    toast('已全选 ' + S.multi.size + ' 个片段');
    return S.multi.size;
  }

  function stepFrame(dir) {
    seek(S.time + (Number(dir) || 1) / S.project.fps);
  }

  function setLoop(on) {
    S.loop = !!on;
    const b = $('stLoop');
    if (b) {
      b.classList.toggle('on', S.loop);
      b.setAttribute('aria-pressed', S.loop ? 'true' : 'false');
    }
    toast(S.loop ? '循环播放已开启' : '循环播放已关闭');
  }

  function setTab(name) {
    S.panel = name;
    document.querySelectorAll('#stTabs .st-tab').forEach(function (b) {
      const on = b.dataset.panel === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.st-panel').forEach(function (p) {
      p.classList.toggle('hidden', p.dataset.panel !== name);
    });
  }

  function bindMediaGrid(grid) {
    if (!grid) return;
    grid.addEventListener('click', function (e) {
      const add = e.target.closest('[data-add]');
      if (add) {
        e.stopPropagation();
        addMediaClip(add.dataset.add, null, null);
        return;
      }
      const card = e.target.closest('.st-mcard');
      if (!card) return;
      S.mediaSel = card.dataset.id;
      grid.querySelectorAll('.st-mcard').forEach(function (n) {
        n.classList.toggle('sel', n === card);
      });
    });
    grid.addEventListener('dblclick', function (e) {
      const card = e.target.closest('.st-mcard');
      if (!card) return;
      const m = mediaOf(card.dataset.id);
      if (!m) return;
      addMediaClip(m.id, null, null);
    });
    grid.addEventListener('dragstart', function (e) {
      const card = e.target.closest('.st-mcard');
      if (!card) return;
      S.dragMediaId = card.dataset.id;
      if (e.dataTransfer) {
        e.dataTransfer.setData('text/plain', 'stm:' + card.dataset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }
    });
    grid.addEventListener('dragend', function () {
      S.dragMediaId = '';
      clearDrop();
    });
  }

  function onKey(e) {
    if (!isShown()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === 'Escape') {
      if ($('stCtx')) { closeClipMenu(); return; }
      if ($('stMenuPop')) { closeMenuPop(); return; }
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelected(); return; }
    if (mod && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); selectAllClips(); return; }
    if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveNow(); toast('项目已保存到本机'); return; }
    if (mod) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
    if (e.key === 'v' || e.key === 'V') { e.preventDefault(); setTool('select'); return; }
    if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setTool('blade'); return; }
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fitTimeline(); return; }
    if (e.key === ',') { e.preventDefault(); stepFrame(-1); return; }
    if (e.key === '.') { e.preventDefault(); stepFrame(1); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected(!!e.shiftKey);
      return;
    }
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); splitAt(); return; }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); addMarker(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(e.shiftKey ? -1 : -1 / S.project.fps); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(e.shiftKey ? 1 : 1 / S.project.fps); return; }
    if (e.key === 'Home') { e.preventDefault(); seek(0); return; }
    if (e.key === 'End') { e.preventDefault(); seek(projectDuration(S.project)); return; }
    if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(S.pps * 1.2); return; }
    if (e.key === '-') { e.preventDefault(); setZoom(S.pps / 1.2); return; }
    if (e.key === 'Escape') {
      const open = document.querySelector('.st-modal:not(.hidden)');
      if (open) { open.classList.add('hidden'); return; }
      selectClip('');
    }
  }

  function closeModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.add('hidden');
  }

  /* ---------------- 菜单栏 / 快捷键面板 ---------------- */
  const SHORTCUTS = [
    ['空格', '播放 / 暂停'],
    ['V / B', '选择工具 / 剃刀工具'],
    ['S', '在播放头处分割'],
    ['Ctrl+Z / Ctrl+Shift+Z', '撤销 / 重做'],
    ['Ctrl+D', '复制片段'],
    ['Delete / Shift+Delete', '删除 / 波纹删除'],
    ['Ctrl+A', '全选片段'],
    ['M', '在播放头打标记'],
    ['← / →', '逐帧后退 / 前进'],
    ['Shift+← / Shift+→', '后退 / 前进 1 秒'],
    [', / .', '上一帧 / 下一帧'],
    ['Home / End', '回到开头 / 结尾'],
    ['+ / −', '放大 / 缩小时间线'],
    ['F', '适配时间线'],
    ['Alt+边缘 / Ctrl+边缘', '波纹裁剪 / 滚动剪辑'],
    ['Alt+片段 / Ctrl+片段', '滑移 / 滑动'],
    ['Shift+点击 / Ctrl+点击', '多选片段'],
    ['Esc', '关闭菜单 / 取消选中']
  ];

  function closeMenuPop() {
    const el = $('stMenuPop');
    if (el) el.remove();
    document.querySelectorAll('#stMenuBar .st-menu-btn').forEach(function (b) {
      b.classList.remove('on');
    });
  }

  function menuDefs() {
    return [
      { id: 'file', items: [
        { label: '新建项目', run: function () { $('stNew').click(); } },
        { label: '导入项目…', run: function () { $('stProjImport').click(); } },
        { label: '导出项目', run: function () { $('stProjExport').click(); } },
        { sep: true },
        { label: '导入素材…', run: function () { $('stImport').click(); } },
        { label: '导出视频…', run: function () { $('stExport').click(); } }
      ] },
      { id: 'edit', items: [
        { label: '撤销', hint: 'Ctrl+Z', disabled: !S.hist.length, run: undo },
        { label: '重做', hint: 'Ctrl+Shift+Z', disabled: !S.future.length, run: redo },
        { sep: true },
        { label: '在播放头处分割', hint: 'S', run: function () { splitAt(); } },
        { label: '复制片段', hint: 'Ctrl+D', run: duplicateSelected },
        { label: '删除', hint: 'Del', run: function () { deleteSelected(false); } },
        { label: '波纹删除', hint: 'Shift+Del', run: function () { deleteSelected(true); } },
        { sep: true },
        { label: '全选片段', hint: 'Ctrl+A', run: selectAllClips }
      ] },
      { id: 'view', items: [
        { label: '适配时间线', hint: 'F', run: fitTimeline },
        { label: '放大时间线', hint: '+', run: function () { setZoom(S.pps * 1.25); } },
        { label: '缩小时间线', hint: '−', run: function () { setZoom(S.pps / 1.25); } },
        { sep: true },
        { label: '磁吸对齐', hint: '开 / 关', checked: S.snap, run: function () { $('stSnap').click(); } },
        { label: '循环播放', checked: S.loop, run: function () { setLoop(!S.loop); } }
      ] },
      { id: 'help', items: [
        { label: '快捷键一览', run: openHelp },
        { label: '关于剪辑台', run: function () { toast('剪辑台 · 本地时间线剪辑器'); } }
      ] }
    ];
  }

  function openMenuBar(btn) {
    const id = btn.dataset.menu;
    const def = menuDefs().filter(function (m) { return m.id === id; })[0];
    if (!def) return;
    const already = $('stMenuPop');
    if (already) {
      const same = already.dataset.menu === id;
      closeMenuPop();
      if (same) return;
    }
    document.querySelectorAll('#stMenuBar .st-menu-btn').forEach(function (b) {
      b.classList.toggle('on', b === btn);
    });
    const pop = document.createElement('div');
    pop.className = 'st-mpop';
    pop.id = 'stMenuPop';
    pop.dataset.menu = id;
    pop.setAttribute('role', 'menu');
    pop.innerHTML = def.items.map(function (it, i) {
      if (it.sep) return '<span class="st-mpop-sep"></span>';
      return '<button type="button" role="menuitem" data-mi="' + i + '"' +
        (it.disabled ? ' disabled' : '') + '>' +
        '<span class="st-mpop-check">' + (it.checked ? '✓' : '') + '</span>' +
        '<span class="st-mpop-label">' + escHtml(it.label) + '</span>' +
        (it.hint ? '<span class="st-mpop-hint">' + it.hint + '</span>' : '') +
        '</button>';
    }).join('');
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.left = Math.max(6, Math.min(r.left, window.innerWidth - pr.width - 8)) + 'px';
    pop.style.top = Math.min(r.bottom + 4, window.innerHeight - pr.height - 8) + 'px';
    pop.addEventListener('click', function (e) {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      const it = def.items[Number(b.dataset.mi)];
      closeMenuPop();
      if (it && !it.disabled && it.run) it.run();
    });
  }

  function openHelp() {
    closeMenuPop();
    let m = $('stHelpModal');
    if (!m) {
      m = document.createElement('div');
      m.className = 'st-modal hidden';
      m.id = 'stHelpModal';
      m.innerHTML = '<div class="st-modal-card wide" role="dialog" aria-modal="true" aria-label="快捷键">' +
        '<div class="st-modal-h"><b>快捷键与操作</b>' +
        '<button type="button" class="st-modal-x" data-help-close aria-label="关闭">×</button></div>' +
        '<div class="st-modal-body"><div class="st-keys">' +
        SHORTCUTS.map(function (row) {
          return '<div class="st-keyrow"><kbd>' + escHtml(row[0]) + '</kbd><span>' + escHtml(row[1]) + '</span></div>';
        }).join('') +
        '</div></div>' +
        '<div class="st-modal-f"><button type="button" class="st-ghost" data-help-close>知道了</button></div></div>';
      m.addEventListener('click', function (e) {
        if (e.target.closest('[data-help-close]')) m.classList.add('hidden');
      });
      $('stApp').appendChild(m);
    }
    m.classList.remove('hidden');
  }

  function bindAll() {
    $('stPlay').addEventListener('click', togglePlay);
    $('stGoStart').addEventListener('click', function () { seek(0); });
    $('stGoEnd').addEventListener('click', function () { seek(projectDuration(S.project)); });
    $('stBack1s').addEventListener('click', function () { seekBy(-1); });
    $('stFwd1s').addEventListener('click', function () { seekBy(1); });
    $('stPrevFrame').addEventListener('click', function () { stepFrame(-1); });
    $('stNextFrame').addEventListener('click', function () { stepFrame(1); });
    $('stLoop').addEventListener('click', function () { setLoop(!S.loop); });
    $('stToolSelect').addEventListener('click', function () { setTool('select'); });
    $('stToolBlade').addEventListener('click', function () { setTool('blade'); });
    $('stZoomFit').addEventListener('click', fitTimeline);
    $('stMute').addEventListener('click', function () {
      S.muted = !S.muted;
      const wave = document.querySelector('#stMute .st-ico-wave');
      const mute = document.querySelector('#stMute .st-ico-mute');
      if (wave) wave.classList.toggle('hidden', S.muted);
      if (mute) mute.classList.toggle('hidden', !S.muted);
      applyMonitorGain();
      toast(S.muted ? '预览已静音' : '预览已恢复声音');
    });
    $('stVol').addEventListener('input', function (e) {
      S.vol = clamp(Number(e.target.value) / 100, 0, 1);
      applyTime();
    });

    $('stUndo').addEventListener('click', undo);
    $('stRedo').addEventListener('click', redo);
    $('stSplit').addEventListener('click', function () { splitAt(); });
    $('stDup').addEventListener('click', duplicateSelected);
    $('stDel').addEventListener('click', function () { deleteSelected(false); });

    [['stAddV', 'video'], ['stAddT', 'text'], ['stAddA', 'audio']].forEach(function (pair) {
      const btn = $(pair[0]);
      if (btn) btn.addEventListener('click', function () { addTrack(pair[1]); });
    });

    $('stHeads').addEventListener('click', function (e) {
      const b = e.target.closest('[data-tt]');
      if (b) { setTrackFlag(b.dataset.track, b.dataset.tt); return; }
      const del = e.target.closest('[data-del]');
      if (del) removeTrack(del.dataset.del);
    });
    $('stHeads').addEventListener('pointerdown', function (e) {
      const grip = e.target.closest('[data-grip]');
      if (!grip) return;
      const t = trackOf(grip.dataset.grip);
      if (!t) return;
      pushHistory();
      S.drag = { mode: 'height', id: t.id, y0: e.clientY, h0: t.height, changed: false, pointerId: e.pointerId };
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });

    const projOut = $('stProjExport');
    if (projOut) projOut.addEventListener('click', exportProjectFile);
    const projIn = $('stProjImport');
    if (projIn) projIn.addEventListener('click', function () { $('stProjFile').click(); });
    const projFile = $('stProjFile');
    if (projFile) projFile.addEventListener('change', function (e) {
      importProjectFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    });

    $('stNew').addEventListener('click', function () {
      askConfirm('新建项目', '当前时间线会被清空，素材池里的导入素材也会移除（视频库原文件不受影响）。确定新建？', function () {
        S.project = blankProject();
        S.sel = '';
        S.multi.clear();
        S.time = 0;
        S.hist = [];
        S.future = [];
        S.textSig = '';
        S.mediaSel = '';
        renderAll();
        applyTime();
        saveNow();
        toast('已新建项目');
      });
    });

    $('stExport').addEventListener('click', openExport);

    $('stTabs').addEventListener('click', function (e) {
      const b = e.target.closest('.st-tab');
      if (b) setTab(b.dataset.panel);
    });

    const search = $('stMediaSearch');
    if (search) search.addEventListener('input', renderMedia);

    $('stImport').addEventListener('click', function () { $('stFile').click(); });
    $('stImportAudio').addEventListener('click', function () { $('stFileAudio').click(); });
    $('stFile').addEventListener('change', function (e) {
      importFiles(e.target.files);
      e.target.value = '';
    });
    $('stFileAudio').addEventListener('change', function (e) {
      importFiles(e.target.files);
      e.target.value = '';
    });

    bindMediaGrid($('stMediaGrid'));
    bindMediaGrid($('stAudioGrid'));

    $('stTextPresets').addEventListener('click', function (e) {
      const b = e.target.closest('[data-preset]');
      if (b) addTextClip(b.dataset.preset);
    });

    $('stFxGrid').addEventListener('click', function (e) {
      const card = e.target.closest('.st-fxcard');
      if (!card) return;
      const c = selected();
      if (!c || (c.kind !== 'video' && c.kind !== 'image')) {
        toast('先选中一个视频 / 图片片段');
        return;
      }
      pushHistory();
      c.filter = card.dataset.fx;
      renderInspector();
      applyTime();
      scheduleSave();
    });

    $('stRows').addEventListener('pointerdown', onTimelineDown);
    $('stRows').addEventListener('contextmenu', function (e) {
      const node = e.target.closest('.st-clip');
      if (!node) return;
      const c = clipOf(node.dataset.id);
      if (!c) return;
      e.preventDefault();
      openClipMenu(c, e.clientX, e.clientY);
    });
    document.addEventListener('pointerdown', function (e) {
      const menu = $('stCtx');
      if (menu && !menu.contains(e.target)) closeClipMenu();
      const pop = $('stMenuPop');
      if (pop && !pop.contains(e.target) && !e.target.closest('#stMenuBar')) closeMenuPop();
    }, true);
    window.addEventListener('blur', function () { closeClipMenu(); closeMenuPop(); });
    const mb = $('stMenuBar');
    if (mb) {
      mb.addEventListener('click', function (e) {
        const b = e.target.closest('[data-menu]');
        if (b) openMenuBar(b);
      });
      mb.addEventListener('mouseover', function (e) {
        if (!$('stMenuPop')) return;
        const b = e.target.closest('[data-menu]');
        if (b && !b.classList.contains('on')) openMenuBar(b);
      });
    }
    const scrollBox = $('stScroll');
    if (scrollBox) {
      scrollBox.addEventListener('scroll', function () {
        closeClipMenu();
        closeMenuPop();
        const hi = $('stHeadsInner');
        if (hi) hi.style.transform = 'translateY(' + (-scrollBox.scrollTop) + 'px)';
      });
    }
    $('stRuler').addEventListener('pointerdown', function (e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const mk = e.target.closest('.st-mk');
      if (mk) {
        const t = Number(mk.dataset.mk) || 0;
        if (e.altKey) removeMarker(t);
        else seek(t);
        e.preventDefault();
        return;
      }
      S.drag = { mode: 'scrub', pointerId: e.pointerId };
      seek(timeAtX(e.clientX));
      e.preventDefault();
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      $('stRows').addEventListener(ev, onTimelineDragOver);
    });
    $('stRows').addEventListener('dragleave', function (e) {
      if (e.target === $('stRows')) clearDrop();
    });
    $('stRows').addEventListener('drop', onTimelineDrop);

    $('stSnap').addEventListener('click', function () {
      S.snap = !S.snap;
      $('stSnap').classList.toggle('on', S.snap);
      toast(S.snap ? '磁吸已开启' : '磁吸已关闭');
    });
    $('stZoom').addEventListener('input', function (e) { setZoom(e.target.value); });
    $('stZoomIn').addEventListener('click', function () { setZoom(S.pps * 1.2); });
    $('stZoomOut').addEventListener('click', function () { setZoom(S.pps / 1.2); });

    const sc = $('stScroll');
    sc.addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom(S.pps * (e.deltaY < 0 ? 1.12 : 0.9));
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        sc.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    $('stInspector').addEventListener('focusin', function (e) {
      if (e.target.matches('input,select,textarea')) S.inspSnap = snap();
    });
    $('stInspector').addEventListener('input', onInspectorInput);
    $('stInspector').addEventListener('change', onInspectorChange);
    $('stInspector').addEventListener('click', function (e) {
      const kf = e.target.closest('[data-kf]');
      if (kf) {
        const c = selected();
        if (c) addKeyframe(c.id, kf.dataset.kf);
        return;
      }
      const snapBtn = e.target.closest('[data-snap]');
      if (snapBtn) { restoreSnapshot(Number(snapBtn.dataset.snap)); return; }
      const addTk = e.target.closest('[data-addtk]');
      if (addTk) { addTrack(addTk.dataset.addtk); return; }
      const tkf = e.target.closest('[data-tkf]');
      if (tkf) { setTrackFlag(tkf.dataset.tk, tkf.dataset.tkf); return; }
      const tkdel = e.target.closest('[data-tkdel]');
      if (tkdel) { removeTrack(tkdel.dataset.tkdel); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'dup') duplicateSelected();
      else if (b.dataset.act === 'del') deleteSelected(false);
      else if (b.dataset.act === 'rdel') deleteSelected(true);
      else if (b.dataset.act === 'kfclear' && S.sel) clearKeyframes(S.sel);
    });

    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (S.exportSession && b.dataset.close === 'stExportModal') {
          cancelExport();
          return;
        }
        closeModal(b.dataset.close);
      });
    });

    $('stLibOpen').addEventListener('click', openLibrary);
    $('stLibSearch').addEventListener('input', function (e) { renderLibList(e.target.value); });
    $('stLibList').addEventListener('click', function (e) {
      const row = e.target.closest('.st-librow');
      if (!row || row.classList.contains('added')) return;
      const id = row.dataset.lib;
      if (S.libPick.has(id)) S.libPick.delete(id);
      else S.libPick.add(id);
      row.classList.toggle('on', S.libPick.has(id));
      updateLibAdd();
    });
    $('stLibAdd').addEventListener('click', addFromLibrary);

    $('stConfirmNo').addEventListener('click', function () { closeModal('stConfirmModal'); });
    $('stConfirmYes').addEventListener('click', function () {
      const fn = S._confirmYes;
      S._confirmYes = null;
      closeModal('stConfirmModal');
      if (fn) fn();
    });

    bindExport();

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', fitFrame);

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(function () { fitFrame(); });
      const prev = document.querySelector('.st-prev');
      if (prev) ro.observe(prev);
    }

    setTab('media');
  }

  /* ---------------- 项目文件导入 / 导出 ---------------- */
  function exportProjectJSON() {
    S.project.meta = S.project.meta || {};
    S.project.meta.updatedAt = Date.now();
    return JSON.stringify(S.project, null, 2);
  }

  function safeFileName(name) {
    return String(name || '未命名项目').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || '项目';
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 800);
  }

  function exportProjectFile() {
    const blob = new Blob([exportProjectJSON()], { type: 'application/json' });
    downloadBlob(blob, safeFileName(S.project.name) + '.hfstudio');
    toast('项目文件已导出');
  }

  function importProjectJSON(text, fileName) {
    let raw = null;
    try { raw = JSON.parse(String(text || '')); }
    catch (e) { toast('项目文件不是合法 JSON'); return false; }
    const p = normalizeProject(raw);
    /* 文件素材的 blob: 地址跨会话必失效，导入时只保留视频库素材与文字 */
    p.media = p.media.filter(function (m) { return m.source === 'library'; });
    const keep = new Set(p.media.map(function (m) { return m.id; }));
    p.clips = p.clips.filter(function (c) { return c.kind === 'text' || keep.has(c.mediaId); });
    if (fileName && (!raw.name || p.name === '未命名项目')) p.name = String(fileName).replace(/\.(hfstudio|json)$/i, '');
    S.project = p;
    S.time = 0;
    S.sel = '';
    S.multi.clear();
    S.hist = [];
    S.future = [];
    S.textSig = '';
    rebuildTracks();
    renderAll();
    applyTime();
    saveNow();
    toast('已导入项目：' + p.name);
    return true;
  }

  function importProjectFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = function () { importProjectJSON(r.result, file.name); };
    r.onerror = function () { toast('读取项目文件失败'); };
    r.readAsText(file);
  }

  /* ---------------- 导出（Canvas + MediaRecorder） ---------------- */
  function pickMime() {
    const list = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    if (window.MediaRecorder && typeof MediaRecorder.isTypeSupported === 'function') {
      for (const m of list) {
        try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
      }
    }
    return 'video/webm';
  }

  function readExportOpts() {
    const res = String(($('stExRes') || {}).value || '1920x1080').split('x');
    let w = clamp(Number(res[0]) || 1920, 320, 3840);
    let h = clamp(Number(res[1]) || 1080, 180, 3840);
    if (w % 2) w += 1;
    if (h % 2) h += 1;
    const fps = Number(($('stExFps') || {}).value) || 30;
    const mb = Number(($('stExBr') || {}).value) || 8;
    const name = String(($('stExName') || {}).value || '').trim() || S.project.name || '未命名项目';
    return { w: w, h: h, fps: fps, bitrate: mb * 1000 * 1000, name: name };
  }

  function openExport() {
    const modal = $('stExportModal');
    if (!modal) return;
    $('stExName').value = (S.project.name || '未命名项目') + '-' + new Date().toISOString().slice(0, 10);
    $('stExProg').classList.add('hidden');
    $('stExResult').classList.add('hidden');
    $('stExStart').disabled = false;
    $('stExStart').textContent = '开始导出';
    $('stExCancel').textContent = '取消';
    modal.classList.remove('hidden');
  }

  function waitForPreview() {
    return new Promise(function (resolve) {
      const t0 = Date.now();
      const check = function () {
        const els = [];
        Object.keys(S.pool).forEach(function (id) {
          const p = S.pool[id];
          if (!p) return;
          if (p.video && p.video.src) els.push(p.video);
          if (p.audio && p.audio.src) els.push(p.audio);
        });
        const ok = els.every(function (el) { return el.readyState >= 2; });
        if (ok || Date.now() - t0 > 2600) resolve();
        else setTimeout(check, 90);
      };
      check();
    });
  }

  async function startExport() {
    if (S.exportSession) return;
    const dur = projectDuration(S.project);
    if (dur <= 0.05) { toast('时间线还是空的，先加一段素材'); return; }
    if (!window.MediaRecorder || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
      toast('当前环境不支持视频编码（缺少 MediaRecorder）');
      return;
    }
    const opts = readExportOpts();
    const canvas = document.createElement('canvas');
    canvas.width = opts.w;
    canvas.height = opts.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) { toast('无法创建导出画布'); return; }

    ensureAudio();
    resumeAudio();
    S.playing = false;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    S.time = 0;
    S.last = 0;
    applyTime();
    $('stExProg').classList.remove('hidden');
    $('stExResult').classList.add('hidden');
    $('stExBar').style.width = '0%';
    $('stExTxt').textContent = '准备渲染…';
    $('stExStart').disabled = true;
    $('stExStart').textContent = '导出中…';
    $('stExCancel').textContent = '取消导出';

    await waitForPreview();

    const stream = canvas.captureStream(opts.fps);
    if (AUD.recDest) {
      try {
        AUD.recDest.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
      } catch (e) {}
    }
    let rec = null;
    try {
      rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: opts.bitrate });
    } catch (e) {
      try { rec = new MediaRecorder(stream); }
      catch (err) { toast('无法创建编码器：' + (err.message || err)); resetExportUI(); return; }
    }

    const view = {
      opts: opts,
      ctx: ctx,
      canvas: canvas,
      dur: dur,
      chunks: [],
      rec: rec,
      stream: stream,
      lastPaint: 0,
      cancelled: false,
      finalized: false
    };
    S.exportSession = view;
    rec.ondataavailable = function (e) {
      if (e.data && e.data.size) view.chunks.push(e.data);
    };
    rec.onstop = function () { finalizeExport(view); };
    try { rec.start(200); } catch (e) { toast('录制启动失败：' + (e.message || e)); S.exportSession = null; resetExportUI(); return; }

    applyMonitorGain();
    S.time = 0;
    applyTime();
    S.playing = true;
    S.last = 0;
    paintPlayIcon();
    cancelAnimationFrame(S.raf);
    S.raf = requestAnimationFrame(tick);
    toast('开始导出，期间请不要切走页面');
  }

  function resetExportUI() {
    const start = $('stExStart');
    if (start) { start.disabled = false; start.textContent = '开始导出'; }
    const cancel = $('stExCancel');
    if (cancel) cancel.textContent = '取消';
  }

  function drawEl(ctx, el, c, W, H, kind) {
    if (!el) return;
    if (kind === 'image') {
      if (!el.complete || !el.naturalWidth) return;
    } else if (el.readyState < 2 || !el.videoWidth) {
      return;
    }
    const mw = kind === 'image' ? el.naturalWidth : el.videoWidth;
    const mh = kind === 'image' ? el.naturalHeight : el.videoHeight;
    if (!mw || !mh) return;
    const fit = Math.min(W / mw, H / mh);
    const view = visualOf(c, S.time);
    const dw = mw * fit * view.scale;
    const dh = mh * fit * view.scale;
    ctx.save();
    ctx.globalAlpha = clamp(view.opacity * fadeFactor(c, S.time), 0, 1);
    const f = cssFilter(c.filter);
    if (f && f !== 'none') ctx.filter = f;
    ctx.translate(W / 2 + (view.x / 100) * W, H / 2 + (view.y / 100) * H);
    ctx.rotate((view.rot * Math.PI) / 180);
    try { ctx.drawImage(el, -dw / 2, -dh / 2, dw, dh); } catch (e) {}
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function wrapText(ctx, text, maxW) {
    const out = [];
    String(text || '').split('\n').forEach(function (line) {
      let cur = '';
      const chars = Array.from(line);
      for (const ch of chars) {
        const test = cur + ch;
        if (ctx.measureText(test).width > maxW && cur) { out.push(cur); cur = ch; }
        else cur = test;
      }
      out.push(cur);
    });
    return out;
  }

  function drawExportTexts(ctx, W, H) {
    const t = S.time;
    activeTextsAt(t).forEach(function (c) {
      const view = visualOf(c, t);
      const fs = c.text.size * (W / S.project.w) * view.scale;
      if (fs <= 0.5) return;
      ctx.save();
      ctx.globalAlpha = clamp(view.opacity * fadeFactor(c, t), 0, 1);
      ctx.font = (c.text.bold ? '700 ' : '400 ') + fs + 'px "Microsoft YaHei","PingFang SC",Arial,sans-serif';
      ctx.textBaseline = 'middle';
      const lines = wrapText(ctx, c.text.content, W * 0.86);
      const lh = fs * 1.28;
      const cx = W / 2 + (view.x / 100) * W;
      const cy = H / 2 + (view.y / 100) * H;
      const blockH = lines.length * lh;
      let maxLineW = 0;
      lines.forEach(function (l) { maxLineW = Math.max(maxLineW, ctx.measureText(l).width); });
      const padX = fs * 0.32;
      const padY = fs * 0.16;
      ctx.translate(cx, cy);
      ctx.rotate((view.rot * Math.PI) / 180);
      if (c.text.bg && c.text.bg !== 'rgba(0,0,0,0)' && c.text.bg !== 'transparent') {
        ctx.fillStyle = c.text.bg;
        roundRect(ctx, -maxLineW / 2 - padX, -blockH / 2 - padY,
          maxLineW + padX * 2, blockH + padY * 2, fs * 0.12);
        ctx.fill();
      }
      ctx.fillStyle = c.text.color;
      lines.forEach(function (ln, i) {
        let x = 0;
        if (c.text.align === 'left') { ctx.textAlign = 'left'; x = -maxLineW / 2; }
        else if (c.text.align === 'right') { ctx.textAlign = 'right'; x = maxLineW / 2; }
        else { ctx.textAlign = 'center'; }
        ctx.fillText(ln, x, -blockH / 2 + lh / 2 + i * lh);
      });
      ctx.restore();
    });
  }

  function drawExportFrame() {
    const v = S.exportSession;
    if (!v) return;
    const W = v.opts.w;
    const H = v.opts.h;
    const ctx = v.ctx;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    /* 轨道数组自上而下是「上层 → 下层」，绘制时反过来：下层先画、上层后盖 */
    const visualTracks = tracksOfKind('video').slice().reverse();
    visualTracks.forEach(function (tk) {
      if (!trackActive(tk)) return;
      const c = activeClipOn(tk.id, S.time);
      if (!c) return;
      const m = mediaOf(c.mediaId);
      const pool = S.pool[tk.id];
      if (!m || !pool) return;
      const el = m.kind === 'image' ? pool.img : pool.video;
      drawEl(ctx, el, c, W, H, m.kind);
    });
    drawExportTexts(ctx, W, H);
    ctx.restore();
  }

  function paintExportProgress() {
    const v = S.exportSession;
    if (!v) return;
    const now = performance.now();
    if (now - v.lastPaint < 120) return;
    v.lastPaint = now;
    const pct = clamp((S.time / v.dur) * 100, 0, 100);
    const bar = $('stExBar');
    if (bar) bar.style.width = pct.toFixed(1) + '%';
    const txt = $('stExTxt');
    if (txt) {
      txt.textContent = '正在渲染 ' + fmtMmss(S.time) + ' / ' + fmtMmss(v.dur) + ' · ' + pct.toFixed(0) + '%';
    }
  }

  function finishExportTick() {
    const v = S.exportSession;
    if (!v) return;
    S.playing = false;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    S.last = 0;
    paintPlayIcon();
    drawExportFrame();
    try {
      if (v.rec && v.rec.state !== 'inactive') v.rec.stop();
      else finalizeExport(v);
    } catch (e) { finalizeExport(v); }
  }

  function finalizeExport(v) {
    if (!v || v.finalized) return;
    v.finalized = true;
    if (S.exportSession === v) S.exportSession = null;
    applyMonitorGain();
    if (v.stream) {
      try { v.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    }
    const blob = new Blob(v.chunks, { type: (v.rec && v.rec.mimeType) || 'video/webm' });
    if (v.cancelled) {
      $('stExTxt').textContent = '已取消导出';
      resetExportUI();
      toast('已取消导出');
      S.time = 0;
      applyTime();
      return;
    }
    if (!blob.size) {
      $('stExTxt').textContent = '导出失败：编码器没有返回数据';
      resetExportUI();
      toast('导出失败，当前环境可能不支持 WebM 编码');
      S.time = 0;
      applyTime();
      return;
    }
    if (S.exportUrl) {
      try { URL.revokeObjectURL(S.exportUrl); } catch (e) {}
    }
    S.exportUrl = URL.createObjectURL(blob);
    const safeName = String(v.opts.name || '导出视频').replace(/[\\/:*?"<>|]+/g, '_');
    const link = $('stExLink');
    if (link) {
      link.href = S.exportUrl;
      link.download = safeName + '.webm';
    }
    $('stExResultT').textContent = '导出完成：' + safeName + '.webm';
    $('stExResultS').textContent = fmtBytes(blob.size) + ' · ' + fmtMmss(v.dur) + ' · ' +
      v.opts.w + '×' + v.opts.h + ' · ' + v.opts.fps + ' fps';
    $('stExResult').classList.remove('hidden');
    $('stExBar').style.width = '100%';
    $('stExTxt').textContent = '已完成 100%';
    resetExportUI();
    $('stExStart').textContent = '再导一次';
    $('stExCancel').textContent = '关闭';
    S.time = 0;
    applyTime();
    toast('导出完成，点「下载到本机」保存');
  }

  function cancelExport() {
    const v = S.exportSession;
    if (!v) { closeModal('stExportModal'); return; }
    if (v.cancelled) return;
    v.cancelled = true;
    S.playing = false;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    S.last = 0;
    paintPlayIcon();
    try {
      if (v.rec && v.rec.state !== 'inactive') v.rec.stop();
      else finalizeExport(v);
    } catch (e) { finalizeExport(v); }
  }

  function bindExport() {
    $('stExStart').addEventListener('click', startExport);
  }

  /* ---------------- 注册 ---------------- */
  const APP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.6" y="4.6" width="18.8" height="14.8" rx="2.4"/><path d="M8.2 4.6v14.8M15.8 4.6v14.8"/><path d="m5.2 9.4 3.2 4.2M5.2 15.4l3.2-4.2"/></svg>';

  if (typeof registerApp === 'function') {
    registerApp({
      id: 'studio',
      name: '剪辑台',
      title: '剪辑台',
      sub: '时间线视频剪辑',
      order: 11,
      cls: 'studio',
      icon: APP_ICON,
      body: window.STUDIO_BODY,
      css: ['apps/studio/app.css'],
      mount: function (body) { init(body); }
    });
  }

  /* ---------------- 供探针使用 ---------------- */
  window.studioApp = {
    __test: {
      state: function () {
        return {
          time: S.time,
          playing: S.playing,
          tool: S.tool,
          loop: S.loop,
          sel: S.sel,
          multi: Array.from(S.multi),
          pps: S.pps,
          duration: projectDuration(S.project),
          media: S.project.media.length,
          clips: S.project.clips.length,
          tracks: S.project.tracks.length,
          markers: S.project.markers.length,
          snaps: S.snapshots.length,
          steps: S.steps,
          hist: S.hist.length,
          future: S.future.length,
          exporting: !!S.exportSession,
          frameW: S.frameW,
          frameH: S.frameH
        };
      },
      project: function () { return JSON.parse(JSON.stringify(S.project)); },
      tracks: function () { return JSON.parse(JSON.stringify(S.project.tracks)); },
      addMedia: function (m) {
        const item = {
          id: m.id || uid('m'),
          name: m.name || '测试素材',
          kind: m.kind || 'image',
          url: m.url || '',
          dur: Number(m.dur) || 5,
          source: 'file',
          libId: ''
        };
        pushHistory();
        S.project.media.push(item);
        renderAll();
        scheduleSave();
        return item;
      },
      addClip: function (mediaId, track, start) {
        return addMediaClip(mediaId, track, start, true);
      },
      addText: function (opts) {
        return addTextClip((opts && opts.preset) || 'title', opts || {});
      },
      seek: function (t) { seek(t); return S.time; },
      select: function (id) { selectClip(id || ''); return S.sel; },
      selectMany: function (ids) {
        S.multi = new Set((ids || []).filter(function (id) { return !!clipOf(id); }));
        S.sel = (ids && ids.length) ? ids[ids.length - 1] : '';
        if (S.multi.size < 2) S.multi.clear();
        paintSel();
        renderInspector();
        return selectedIds();
      },
      split: function (t) { return splitAt(t); },
      undo: function () { return undo(); },
      redo: function () { return redo(); },
      duplicate: function () { return duplicateSelected(); },
      remove: function (ripple) { return deleteSelected(!!ripple); },
      setClip: function (id, patch) { return setClipProps(id, patch); },
      clipEls: function () { return document.querySelectorAll('#stRows .st-clip').length; },
      textEls: function () { return document.querySelectorAll('#stTexts .st-text-item').length; },
      previewEl: function () {
        const ids = tracksOfKind('video').map(function (t) { return t.id; });
        const p = S.pool['v1'] || S.pool[ids[0]];
        if (!p) return null;
        return {
          video: !!p.video && !p.video.classList.contains('hidden') && !!p.video.src,
          img: !!p.img && !p.img.classList.contains('hidden') && !!p.img.src,
          ready: p.video ? p.video.readyState : 0
        };
      },
      migrate: function (raw) { return JSON.parse(JSON.stringify(migrateProject(raw))); },
      normalize: function (raw) { return JSON.parse(JSON.stringify(normalizeProject(raw))); },
      sample: function (keys, t) { return sampleTrack(keys, t); },
      propAt: function (id, prop, t) {
        const c = clipOf(id);
        return c ? propAt(c, prop, t) : null;
      },
      addTrack: function (kind) { return addTrack(kind); },
      removeTrack: function (id) { return removeTrack(id); },
      toggleTrack: function (id, key) { setTrackFlag(id, key); return JSON.parse(JSON.stringify(trackOf(id))); },
      addMarker: function (t) { return addMarker(t); },
      removeMarker: function (t) { return removeMarker(t); },
      markers: function () { return JSON.parse(JSON.stringify(S.project.markers)); },
      markerEls: function () { return document.querySelectorAll('#stRuler .st-mk').length; },
      snapTime: function (t) { return snapValue(Number(t) || 0, '', 0); },
      snapshotNow: function () { saveSnapshot(); return S.snapshots.length; },
      snapshots: function () {
        return S.snapshots.map(function (s) { return { at: s.at, name: s.name, clips: s.project.clips.length }; });
      },
      restoreSnapshot: function (i) { return restoreSnapshot(i); },
      exportProjectJSON: exportProjectJSON,
      importProjectJSON: function (text, name) { return importProjectJSON(text, name); },
      addKeyframe: function (id, prop, t) { return addKeyframe(id, prop, t == null ? S.time : t); },
      clearKeyframes: function (id, prop) { return clearKeyframes(id, prop); },
      ctxMenu: function () {
        const el = $('stCtx');
        if (!el) return null;
        return Array.from(el.querySelectorAll('[data-mi]')).map(function (b) {
          return { id: b.dataset.mi, label: b.textContent, disabled: !!b.disabled };
        });
      },
      openCtx: function (id, x, y) {
        const c = clipOf(id);
        if (!c) return false;
        openClipMenu(c, x == null ? 40 : x, y == null ? 40 : y);
        return true;
      },
      clickCtx: function (id) {
        const el = $('stCtx');
        if (!el) return false;
        const b = el.querySelector('[data-mi="' + id + '"]');
        if (!b || b.disabled) return false;
        b.click();
        return true;
      },
      closeCtx: closeClipMenu,
      detachAudio: function (id) { return detachAudio(id); },
      setTool: setTool,
      setZoom: setZoom,
      tool: function () { return S.tool; },
      setLoop: setLoop,
      loop: function () { return S.loop; },
      selectAll: selectAllClips,
      fit: fitTimeline,
      bladeAt: function (id, t) { return splitClip(clipOf(id), Number(t)); },
      openMenu: function (name) {
        const b = document.querySelector('#stMenuBar [data-menu="' + name + '"]');
        if (!b) return false;
        openMenuBar(b);
        return true;
      },
      menuBar: function () {
        const pop = $('stMenuPop');
        if (!pop) return null;
        return {
          id: pop.dataset.menu,
          items: Array.from(pop.querySelectorAll('[data-mi]')).map(function (x) {
            return {
              label: (x.querySelector('.st-mpop-label') || {}).textContent || '',
              hint: (x.querySelector('.st-mpop-hint') || {}).textContent || '',
              disabled: !!x.disabled,
              checked: (x.querySelector('.st-mpop-check') || {}).textContent || ''
            };
          })
        };
      },
      clickMenu: function (label) {
        const pop = $('stMenuPop');
        if (!pop) return false;
        const b = Array.from(pop.querySelectorAll('[data-mi]')).filter(function (x) {
          return ((x.querySelector('.st-mpop-label') || {}).textContent || '') === label;
        })[0];
        if (!b || b.disabled) return false;
        b.click();
        return true;
      },
      closeMenu: closeMenuPop,
      helpOpen: function () {
        const m = $('stHelpModal');
        return !!m && !m.classList.contains('hidden');
      },
      edit: {
        trim: function (id, edge, dx, ripple) {
          const c = clipOf(id);
          if (!c) return null;
          return trimClip(c, edge, dx, { start: c.start, dur: c.dur, in: c.in }, !!ripple);
        },
        roll: function (id, edge, dx) {
          const c = clipOf(id);
          if (!c) return null;
          return rollClip(c, edge, dx, { start: c.start, dur: c.dur, in: c.in });
        },
        slip: function (id, dx) {
          const c = clipOf(id);
          return c ? slipClip(c, dx, c.in) : null;
        },
        slide: function (id, dx) {
          const c = clipOf(id);
          return c ? slideClip(c, dx) : null;
        }
      },
      exportSupported: function () {
        return !!(window.MediaRecorder && typeof HTMLCanvasElement.prototype.captureStream === 'function');
      },
      openExport: openExport,
      startExport: startExport,
      cancelExport: cancelExport,
      exportState: function () {
        const res = $('stExResult');
        return {
          busy: !!S.exportSession,
          done: !!res && !res.classList.contains('hidden'),
          href: ($('stExLink') && $('stExLink').href) || '',
          text: ($('stExTxt') && $('stExTxt').textContent) || '',
          bar: ($('stExBar') && $('stExBar').style.width) || '0%'
        };
      }
    }
  };
})();
