/* 模型商店（阶段 E）：把「装模型」变成两次点击。
 *
 * 目标流程：
 *   1. 打开模型控制台，直接看到可装的模型清单（本机能不能跑已经标好）；
 *   2. 点「安装」→ 自动搞定前置引擎（Ollama / ComfyUI）、下载权重、放到正确目录；
 *   3. 装完自动「启用」——把模型写进客户端配置（LLM 写 llm 配置，生图写 ckpt 选择），
 *      用户不需要再去设置页填 Base URL / 模型名。
 *
 * 三个必须守住的设计：
 *   ① 「已安装」判断不能依赖引擎在跑：生图清单直接读磁盘（主进程），
 *      否则引擎一停就显示「未安装」，用户会重复下 2 GB。
 *   ② 「启用」写的键必须和真正执行链路读的键是同一个（llmMode / llmModel / comfyCkptChoice /
 *      imgMode），否则会出现「显示已启用、实际还在走云端」。
 *   ③ 体积/显存门槛用实测值：写「约 4 GB」实际下 8 GB 是最伤信任的错。
 */
/* 「看图」单列一个类目：用户的诉求往往是「识图不够用」，
 * 而识图模型混在对话列表里时，他只能靠名字里有没有 vl/vision 去猜。
 * 「语音合成」同样单列：它的安装语义是「选中系统音色」，和下载权重不是一回事。 */
const MS_FILTERS = [
  ['all', '全部模型'], ['llm', '对话模型'], ['vision', '识图模型'],
  ['image', '生图模型'], ['tts', '语音合成']
];

/* 商店卡片的类目元信息：标题、副标题、图标字样与配色后缀集中在这里，
 * 渲染层不再散落 if(kind === ...) 的分支。 */
const MS_KIND = {
  llm:    { label: '对话模型', hint: 'Ollama 本地推理 · 装完即用', ico: 'AI' },
  vision: { label: '识图 / 多模态', hint: '能读图片、截图、表格', ico: 'VL' },
  image:  { label: '生图模型', hint: 'ComfyUI 本地推理 · checkpoints', ico: 'IMG' },
  tts:    { label: '语音合成', hint: '系统语音 + Piper / Kokoro 本地音色', ico: 'TTS' }
};

const msState = {
  filter: 'all',
  fitOnly: false,
  q: '',
  view: 'browse',      // browse = 按类目逛；installed = 只看已安装
  hw: null,
  ready: false,
  /* installed.llm 为 null 表示「还不知道」（引擎没跑），不能当成「没装」 */
  /* kokoro 是共享模型：不按音色区分，装一次全部 Kokoro 音色可用 */
  installed: { llm: null, image: null, tts: [], kokoro: false },
  progress: {},        // id -> { pct, msg, speed, etaMs, busy }
  error: {},           // id -> 文案
  notes: {},           // id -> 完成后的提示（如「下载中断，进度已保留」）
  previewId: '',       // 正在试听的语音条目
  previewAudio: null,  // 本地语音试听的 Audio 实例（系统语音走 speechSynthesis）
  ttsItems: {},        // 本机语音生成的动态条目，id -> item
  voicesBound: false
};

function msEsc(s){
  return (typeof mcEsc === 'function') ? mcEsc(s) : String(s == null ? '' : s);
}
function msDesk(){
  const d = window.openagiDesktop;
  return d && typeof d === 'object' ? d : null;
}
function msFmtGB(gb){
  const n = Number(gb) || 0;
  return n >= 1 ? (Math.round(n * 10) / 10) + ' GB' : Math.round(n * 1024) + ' MB';
}
function msFit(item){
  return (typeof catalogFit === 'function') ? catalogFit(item, msState.hw) : { level: 'unknown', note: '' };
}

/* ---------- 系统语音（TTS） ----------
 * 语音合成不下载权重：这里的「已安装」= 系统里能找到对应音色，
 * 「启用」= 把音色名写进 hf_ttsVoice，数字人朗读会优先使用它。
 * 所有 speechSynthesis 访问都必须兜底——无头测试与部分老内核没有这个对象。 */
function msVoiceList(){
  const ss = (typeof window !== 'undefined' && window) ? window.speechSynthesis : null;
  if(!ss || typeof ss.getVoices !== 'function') return [];
  try{ return ss.getVoices() || []; }catch(e){ return []; }
}
/* 语音标题：把 "Microsoft Zira Desktop - English (United States)" 收敛成 "Zira"。
 * 系统语音的原名很长，直接塞进卡片会把语种和按钮挤没。 */
function msVoiceTitle(voice){
  let n = String(voice.name || '系统语音')
    .replace(/^Microsoft\s+/i, '')
    .replace(/\s+Desktop\b/i, '')
    .replace(/\s+Online\b.*$/i, '')
    .replace(/\(.*?\)/g, '');
  n = n.split(/\s*-\s*/)[0].trim();
  return n || String(voice.name || '系统语音');
}
function msVoiceKey(voice){
  let h = 0;
  const raw = String(voice.name || '') + '|' + String(voice.lang || '');
  for(let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return 'tts-voice-' + h.toString(36);
}
/* 语音类目不再只列 7 个预设：那会出现「检测到 4 个，只有 2 个能用」。
 * 现在以系统实际语音为准，预设只作为匹配到的音色的名称/说明模板；
 * 认不出的语音也生成条目，保证「检测到几只 = 能用几只」。 */
function msTtsItems(){
  const voices = msVoiceList();
  const presets = (typeof catalogOf === 'function') ? catalogOf('tts') : [];
  const seen = {};
  const list = [];
  voices.forEach(voice => {
    const name = String(voice.name || '');
    const lang = String(voice.lang || '');
    if(!name) return;
    const key = name + '|' + lang;
    if(seen[key]) return;
    seen[key] = 1;
    const preset = presets.filter(p => p.engine === 'system' && p.voice instanceof RegExp && p.voice.test(name + ' ' + lang))[0] || null;
    let item;
    if(preset){
      item = Object.assign({}, preset);
      item.lang = preset.lang || lang;
    } else {
      const zh = /^zh|chinese|中文|普通话/i.test(lang + ' ' + name);
      const title = msVoiceTitle(voice);
      item = {
        id: msVoiceKey(voice), kind: 'tts', engine: 'system',
        name: title, org: /microsoft/i.test(name) ? 'Microsoft' : 'System',
        params: 'System', sizeGB: 0, vramGB: 0, ramGB: 0, lang: lang,
        sample: zh ? ('你好，我是' + title + '。很高兴为你朗读。')
                   : ('Hi, I am ' + title + '. I can read text for you.'),
        tags: ['系统音色', lang.split('-')[0] || '本地'],
        desc: '系统里已经装好的语音包，可直接试听并设为默认，不占显存与磁盘。'
      };
    }
    /* 记住精确的语音名：启用与试听都按这个名字取 voice，
     * 预设里的正则只负责「认出这是哪一档音色」。 */
    item.voiceName = name;
    list.push(item);
  });
  /* 同一个预设可能匹配到多只语音（例如同时装了在线版和桌面版），
   * 给重复 id 加后缀，避免 data-ms-id 撞车导致点 A 启用了 B。 */
  const ids = {};
  list.forEach(item => {
    if(ids[item.id]) item.id = item.id + '-' + (++ids[item.id]);
    else ids[item.id] = 1;
  });
  const map = {};
  list.forEach(item => { map[item.id] = item; });
  msState.ttsItems = map;
  return list;
}
/* 需要下载的高级本地语音（Piper ONNX / Kokoro 共享模型）。它们不在 msTtsItems 里：
 * 那一组是「系统里现成能用的音色」，这一组要先下权重、由本地引擎桥合成。 */
function msTtsLocal(){
  return (typeof catalogOf === 'function')
    ? catalogOf('tts').filter(m => m.engine !== 'system')
    : [];
}
function msTtsLocalInstalled(item){
  /* Kokoro 的「已安装」是共享模型的状态，不是单个音色文件 */
  if(item.engine === 'kokoro') return !!msState.installed.kokoro;
  return Array.isArray(msState.installed.tts) && msState.installed.tts.indexOf(item.voiceFile) !== -1;
}
/* 动态系统音色的 id 与本地预设 id 都可能是 tts- 开头，启用值用前缀区分，
 * 否则「tts-huihui」这类名字会被误当成系统音色去 getVoices() 里找。 */
function msPiperChoice(item){ return item ? ('piper:' + item.id) : ''; }
/* Kokoro 是「一份模型 + 多个 sid」，启用值必须存 sid 而不是条目 id：
 * 渲染层换目录文案时 sid 不变，数字人那侧也只需要一个整数。 */
function msKokoroChoice(item){ return item ? ('kokoro:' + item.sid) : ''; }
function msLocalChoice(item){
  return item && item.engine === 'kokoro' ? msKokoroChoice(item) : msPiperChoice(item);
}

/* 语音条目是按本机语音动态生成的，不在静态目录里：
 * 点击动作必须先查这份运行时映射，再回退静态目录。 */
function msFindItem(id){
  const key = String(id || '');
  if(!key) return null;
  const dyn = msState.ttsItems || {};
  if(dyn[key]) return dyn[key];
  /* 语音列表可能在两次渲染之间更新（voiceschanged），映射还没重建时再算一次。 */
  if(key.indexOf('tts-') === 0){
    msTtsItems();
    if(msState.ttsItems[key]) return msState.ttsItems[key];
  }
  return (typeof catalogGet === 'function') ? catalogGet(key) : null;
}
function msVoiceMatch(item){
  const list = msVoiceList();
  const want = String(item.voiceName || '');
  if(want){
    for(let i = 0; i < list.length; i++){
      if(String((list[i] || {}).name || '') === want) return list[i];
    }
    return null;
  }
  const re = item.voice;
  if(!(re instanceof RegExp)) return null;
  for(let i = 0; i < list.length; i++){
    const v = list[i] || {};
    if(re.test(String(v.name || '') + ' ' + String(v.lang || ''))) return v;
  }
  return null;
}
function msTtsChoice(){
  try{ return String(localStorage.getItem('hf_ttsVoice') || ''); }catch(e){ return ''; }
}
function msTtsSetVoice(name){
  try{
    if(name) localStorage.setItem('hf_ttsVoice', String(name));
    else localStorage.removeItem('hf_ttsVoice');
  }catch(e){}
}
function msBindVoices(){
  if(msState.voicesBound) return;
  const ss = (typeof window !== 'undefined' && window) ? window.speechSynthesis : null;
  if(!ss || typeof ss.addEventListener !== 'function') return;
  msState.voicesBound = true;
  /* Chromium 的语音列表是异步填充的：第一次 getVoices() 经常返回空，
   * 不监听这个事件，商店会一直显示「未检测到语音」直到用户手动刷新。 */
  try{ ss.addEventListener('voiceschanged', () => msPaintStore()); }catch(e){}
}
function msStopPreview(){
  const ss = (typeof window !== 'undefined' && window) ? window.speechSynthesis : null;
  try{ if(ss && typeof ss.cancel === 'function') ss.cancel(); }catch(e){}
  const a = msState.previewAudio;
  if(a){
    try{ a.pause(); }catch(e){}
    try{ if(a.__msUrl && typeof URL !== 'undefined' && URL.revokeObjectURL) URL.revokeObjectURL(a.__msUrl); }catch(e){}
  }
  msState.previewAudio = null;
  msState.previewId = '';
}
/* 本地语音试听：文本发给本地引擎桥，桥调 piper.exe / sherpa 合成 WAV 再回传。
 * 不走 speechSynthesis —— 这只音色本来就不在系统语音列表里。 */
async function msPreviewLocal(item){
  const base = (typeof rtBase === 'function') ? rtBase() : '';
  const hasFetch = (typeof fetch === 'function');
  const AudioCtor = (typeof window !== 'undefined' && window && typeof window.Audio === 'function') ? window.Audio
    : (typeof Audio === 'function' ? Audio : null);
  if(!base || !hasFetch || !AudioCtor) throw new Error('当前环境不支持本地语音试听（需要桌面端）');
  const payload = { text: item.sample || ('你好，我是' + item.name + '。'), rate: 1 };
  if(item.engine === 'kokoro'){ payload.engine = 'kokoro'; payload.sid = item.sid; }
  else { payload.voice = item.voiceFile; }
  const res = await fetch(base + '/tts/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if(!res || !res.ok){
    let msg = '本地语音合成失败';
    try{ const j = await res.json(); if(j && j.error) msg = j.error; }catch(e){}
    throw new Error(msg);
  }
  const blob = await res.blob();
  if(!blob || !blob.size) throw new Error('本地语音合成没有返回音频');
  const url = URL.createObjectURL(blob);
  const audio = new AudioCtor(url);
  audio.__msUrl = url;
  audio.onended = audio.onerror = () => {
    if(msState.previewAudio !== audio) return;
    msState.previewAudio = null;
    msState.previewId = '';
    try{ URL.revokeObjectURL(url); }catch(e){}
    msPaintStore();
  };
  msState.previewAudio = audio;
  msState.previewId = item.id;
  const p = audio.play();
  if(p && typeof p.catch === 'function') p.catch(() => {});
  msPaintStore();
}
async function msPreview(item){
  if(msState.previewId === item.id){ msStopPreview(); msPaintStore(); return; }
  msStopPreview();
  if(item.kind === 'tts' && item.engine !== 'system'){
    try{
      delete msState.error[item.id];
      await msPreviewLocal(item);
    }catch(e){
      msState.previewId = '';
      msState.error[item.id] = String((e && e.message) || e);
      msPaintStore();
    }
    return;
  }
  const ss = (typeof window !== 'undefined' && window) ? window.speechSynthesis : null;
  const Utter = (typeof window !== 'undefined' && window) ? window.SpeechSynthesisUtterance : null;
  const voice = msVoiceMatch(item);
  if(!ss || typeof ss.speak !== 'function' || typeof Utter !== 'function' || !voice) return;
  try{
    const u = new Utter(item.sample || ('你好，我是' + item.name + '。'));
    u.voice = voice;
    u.lang = voice.lang || item.lang || 'zh-CN';
    u.rate = 1;
    u.pitch = 1;
    u.onend = u.onerror = () => { msState.previewId = ''; msPaintStore(); };
    msState.previewId = item.id;
    ss.speak(u);
    msPaintStore();

  }catch(e){
    msState.previewId = '';
  }
}

/* ---------- 已安装清单 ---------- */
async function msRefreshInstalled(){
  const d = msDesk();
  // 生图：直接读磁盘，引擎没启动也能判断
  if(d && typeof d.storeImageList === 'function'){
    try{
      const r = await d.storeImageList();
      if(r && r.ok) msState.installed.image = (r.files || []).map(f => f.file);
    }catch(e){}
  }
  // 本地语音：同样读磁盘（tts/voices/*.onnx），不依赖 piper 进程
  if(d && typeof d.storeTtsList === 'function'){
    try{
      const r = await d.storeTtsList();
      msState.installed.tts = (r && r.ok && Array.isArray(r.voices)) ? r.voices.map(v => v.file) : [];
    }catch(e){}
  }
  // Kokoro：共享模型是否就绪（引擎 + 三份模型文件），与具体音色无关
  if(d && typeof d.storeKokoroStatus === 'function'){
    try{
      const r = await d.storeKokoroStatus();
      msState.installed.kokoro = !!(r && r.ok && r.installed);
    }catch(e){}
  }
  // 语言模型：只有引擎在跑才问得到，问不到就保留上一次的结果（null = 未知）
  if(rtHealth && rtHealth.ollama && rtHealth.ollama.ok){
    try{
      const p = providerFor('llm', 'ollama-llm');
      const list = p ? await p.listModels() : [];
      msState.installed.llm = (list || []).map(m => String(m.id || ''));
      if(typeof mcModelCache === 'object' && mcModelCache) delete mcModelCache['llm/ollama-llm'];
    }catch(e){}
  }
}

function msIsInstalled(item){
  if(item.kind === 'tts'){
    return item.engine === 'system' ? !!msVoiceMatch(item) : msTtsLocalInstalled(item);
  }
  if(item.engine === 'comfyui'){
    return Array.isArray(msState.installed.image) && msState.installed.image.indexOf(item.file) !== -1;
  }
  return Array.isArray(msState.installed.llm) && msState.installed.llm.indexOf(item.ollama) !== -1;
}

/* ---------- 当前启用的是哪个 ---------- */
function msIsActive(item){
  if(item.kind === 'tts'){
    if(item.engine === 'system'){
      const voice = msVoiceMatch(item);
      return !!(voice && msTtsChoice() === String(voice.name || ''));
    }
    return msTtsChoice() === msLocalChoice(item);
  }
  if(item.engine === 'ollama'){
    const base = confGet('llmBaseUrl').replace(/\/$/, '');
    const model = confGet('llmModel');
    const mode = (typeof llmMode === 'function') ? llmMode() : 'cloud';
    return mode === 'local' && model === item.ollama && /\/ollama\/v1$/i.test(base);
  }
  const mode = (typeof imgMode === 'function') ? imgMode() : 'online';
  const ckpt = (typeof comfyCkptChoice === 'function') ? comfyCkptChoice() : '';
  return mode === 'local' && ckpt === item.file;
}

/* ---------- 启用（配置）：写真正执行链路要读的那些键 ---------- */
function msEnable(item){
  if(item.kind === 'tts'){
    const choice = item.engine === 'system'
      ? (msVoiceMatch(item) ? msVoiceMatch(item).name : '')
      : msLocalChoice(item);
    if(item.engine === 'system'){
      if(!choice) throw new Error('系统里没有安装这只语音');
    } else if(!msTtsLocalInstalled(item)){
      throw new Error('本地语音还没下载完');
    }
    msTtsSetVoice(choice);
    /* 数字人 App 监听这个事件即时刷新音色选择；没有监听方也不影响。 */
    try{
      if(typeof window !== 'undefined' && window && typeof window.dispatchEvent === 'function' &&
         typeof CustomEvent === 'function'){
        window.dispatchEvent(new CustomEvent('hf-tts-changed', { detail: { voice: choice } }));
      }
    }catch(e){}
    return;
  }
  if(item.engine === 'ollama'){
    // llmMode 必须是 local，否则 llmConn() 会继续走网关/云端，本地模型装了也用不上
    if(typeof setLlmMode === 'function') setLlmMode('local');
    if($('llmBaseUrl')) $('llmBaseUrl').value = rtBase() + '/ollama/v1';
    if($('llmKey')) $('llmKey').value = 'ollama';       // Ollama 不校验 Key，但不能留空（llmReady 要求非空）
    if($('llmModel')) $('llmModel').value = item.ollama;
    if(typeof saveAll === 'function') saveAll();
    if(typeof updateStatusChips === 'function') updateStatusChips();
    if(typeof updateModelLabels === 'function') updateModelLabels();
    if(typeof mcSetScope === 'function') mcSetScope('llm', 'local');
    return;
  }
  if(typeof setImgMode === 'function') setImgMode('local');
  if(typeof setComfyCkpt === 'function') setComfyCkpt(item.file);
  // 采样参数跟着模型走：SDXL-Turbo 用默认 20 步 / cfg 7 只会出糊图
  if(item.tune && item.tune.size && $('imgSize')) $('imgSize').value = item.tune.size;
  if(typeof saveAll === 'function') saveAll();
  if(typeof mcSetScope === 'function') mcSetScope('image', 'local');
}

/* ---------- 安装 ---------- */
function msProg(id){
  return msState.progress[id] || null;
}
function msSetProg(id, patch){
  const cur = msState.progress[id] || { pct: -1, msg: '', speed: 0, etaMs: -1, busy: true };
  // undefined 不能写进去：上一次是 42%，这次回调没给 pct，写进去就变成「进度未知」，
  // 进度条会从 42% 跳回 0%，看起来像下载失败重来了
  const clean = {};
  for(const k in (patch || {})) if(patch[k] !== undefined) clean[k] = patch[k];
  msState.progress[id] = Object.assign(cur, clean);
  msPaintThrottled();
}
function msThrottle(){
  const now = Date.now();
  if(msState._lastPaint && now - msState._lastPaint < 200) {
    if(msState._timer) return;
    msState._timer = setTimeout(() => { msState._timer = null; msPaintStore(); }, 220);
    return;
  }
  msState._lastPaint = now;
  msPaintStore();
}
const msPaintThrottled = msThrottle;

/* 语言模型：Ollama 的 /api/pull 自带断点续传，这里只负责前置引擎和进度转发 */
async function msInstallLlm(item){
  const p = providerFor('llm', 'ollama-llm');
  if(!p || typeof p.pullModel !== 'function') throw new Error('本地语言模型 Provider 未注册');
  msSetProg(item.id, { busy: true, pct: 0, msg: '正在准备本地引擎…', speed: 0, etaMs: -1 });
  const ready = await mcEnsureEngine();     // 没装会自动安装 Ollama（含一次确认）
  if(!ready) throw new Error('本地引擎未就绪，请先在上方「本地引擎」里安装 / 启动 Ollama');
  msSetProg(item.id, { pct: 0, msg: '开始拉取 ' + item.ollama + '…' });
  await p.pullModel(item.ollama, info => {
    const i = info || {};
    // 速度和剩余时间要一起转给卡片，否则 4 GB 的模型只有一行百分比，
    // 用户没法判断「是在慢慢下，还是已经卡死了」
    msSetProg(item.id, {
      pct: (typeof i.pct === 'number' && i.pct >= 0) ? i.pct : undefined,
      msg: i.message || undefined,
      speed: (typeof i.speed === 'number' && i.speed > 0) ? i.speed : undefined,
      etaMs: (typeof i.etaMs === 'number') ? i.etaMs : undefined
    });
  });
  msState.installed.llm = null;
  await msRefreshInstalled();
}

/* 生图：先把 ComfyUI 备好，再让主进程把权重下到 checkpoints */
async function msInstallImage(item){
  const d = msDesk();
  if(!d || typeof d.storeInstallImage !== 'function') throw new Error('需通过桌面端启动才能自动下载生图模型');
  await mcComfyDetect();
  if(!mcComfy.running){
    /* 这里**不再弹确认框**。生图模型的去处只有 ComfyUI 一个，问「要不要装引擎」没有第二种答案，
     * 只是把「点一下」变成「点两下」——那正是「一键安装」要消灭的东西。
     * 体积（2 GB）和「装完自动启动」都写在卡片文案里，下载中也给了取消入口。 */
    msSetProg(item.id, {
      busy: true, pct: 0,
      msg: mcComfy.installed ? '正在启动 ComfyUI…' : '正在安装 ComfyUI 引擎（约 2 GB，装完自动启动）…'
    });
    await mcComfyAction(mcComfy.installed ? 'launch' : 'install', { confirmed: true });
    await mcComfyDetect();
    if(!mcComfy.running){
      // 引擎起不来时把用户导到独立窗口：原因（缺依赖 / 显卡驱动 / 路径有空格）都在启动日志里
      if(typeof openComfyApp === 'function') openComfyApp();
      throw new Error('ComfyUI 没启动起来，已打开「本地生图」窗口，里面能看到启动日志');
    }
  }
  msSetProg(item.id, { busy: true, pct: 0, msg: '正在准备下载…' });
  const r = await d.storeInstallImage({ id: item.id, file: item.file, urls: item.urls, sizeGB: item.sizeGB });
  if(r && r.cancelled){ msState.notes[item.id] = '已取消下载，进度已保留'; return false; }
  if(!r || !r.ok) throw new Error((r && r.message) || '下载失败');
  await msRefreshInstalled();
  return true;
}

/* 下载 Piper 语音权重（.onnx + .onnx.json）。主进程负责把 piper 引擎也补齐，
 * 渲染进程只关心「下完没有」，不重复实现下载与解压。 */
async function msInstallTts(item){
  const d = msDesk();
  if(!d) throw new Error('本地语音需要桌面端才能下载');
  let r;
  if(item.engine === 'kokoro'){
    if(typeof d.storeInstallKokoro !== 'function') throw new Error('当前版本不支持 Kokoro 超自然语音');
    msSetProg(item.id, { busy: true, pct: 0, msg: '正在下载 Kokoro 共享模型（约 160 MB）…' });
    /* 带上卡片 id：主进程用它发进度事件，任务 key 仍然固定为共享的 kokoro */
    try{
      r = await d.storeInstallKokoro({ id: item.id });
    }catch(err){
      /* 内容包热更新只换渲染层，主进程还是旧版本时 IPC 根本不存在。
       * 这时直接显示 "No handler registered" 会让人以为下载坏了，换成可执行的提示。 */
      if(/No handler registered/i.test(String((err && err.message) || err))){
        throw new Error('Kokoro 需要重启桌面端后生效：请完全退出应用再重新打开');
      }
      throw err;
    }
  } else {
    if(typeof d.storeInstallTts !== 'function') throw new Error('本地语音需要桌面端才能下载');
    msSetProg(item.id, { busy: true, pct: 0, msg: '正在下载语音权重…' });
    r = await d.storeInstallTts({
      id: item.id, voiceFile: item.voiceFile, voiceJson: item.voiceJson,
      urls: item.urls, jsonUrls: item.jsonUrls, sizeGB: item.sizeGB
    });
  }
  if(r && r.cancelled){
    const e = new Error('已取消下载，进度已保留');
    e.cancelled = true;
    throw e;
  }
  if(!r || !r.ok) throw new Error((r && r.message) || '下载失败');
  await msRefreshInstalled();
  return true;
}

async function msInstall(item, btn){
  if(msProg(item.id) && msProg(item.id).busy) return;
  delete msState.error[item.id];
  delete msState.notes[item.id];
  if(btn) btn.disabled = true;
  let ok = false;
  try{
    if(item.kind === 'tts'){
      if(item.engine === 'system'){
        /* 系统音色没有可下载的权重：点安装等价于「选中这只音色」，
         * 所以不进入下面的刷新/提示分支，也不去动引擎。 */
        msEnable(item);
        if(typeof bpToast === 'function') bpToast('已设为默认语音：' + item.name);
      } else {
        await msInstallTts(item);
      }
      ok = true;
    } else if(item.engine === 'ollama'){
      await msInstallLlm(item);
      ok = true;
    } else {
      ok = await msInstallImage(item);
    }
  }catch(e){
    const msg = String((e && e.message) || e);
    // 可续传的中断不是失败：已下的分片都在，再点一次会接着下
    if(e && (e.resumable || e.cancelled)) msState.notes[item.id] = msg;
    else msState.error[item.id] = msg;
  }finally{
    delete msState.progress[item.id];
  }
  if(!ok && !msState.notes[item.id]){ msPaintStore(); return; }
  // 下载完的本地语音直接设为默认：装完就能在数字人里朗读
  if(ok && item.kind === 'tts' && item.engine !== 'system'){
    try{
      msEnable(item);
      if(typeof bpToast === 'function') bpToast('已下载并设为默认语音：' + item.name);
    }catch(e){}
  }
  // 装完即启用：这就是「一键式」的关键一步，用户不用再去设置页填配置
  if(ok && item.kind !== 'tts' && msIsInstalled(item)){
    try{ msEnable(item); }catch(e){}
    try{ await rtRefresh(); }catch(e){}
    if(typeof bpToast === 'function') bpToast('已安装并启用：' + item.name);
  }
  msPaintStore();
  if(typeof mcRenderProviders === 'function') mcRenderProviders();
}

/* 取消生图模型下载：主进程在分片边界退出，已下好的块留在侧车里，再点安装会续传 */
async function msCancel(item){
  const d = msDesk();
  if(!d || typeof d.storeCancel !== 'function') return;
  const p = msProg(item.id);
  if(p) msSetProg(item.id, { msg: '正在取消…' });
  /* 主进程把 Kokoro 的下载任务固定记在 'kokoro' 这个 key 下（共享模型只下一份） */
  const key = item.engine === 'kokoro' ? 'kokoro' : item.id;
  try{ await d.storeCancel(key); }catch(e){}
}

/* 卸载后必须处理「配置还指着它」。
 * 用户点卸载的往往正是当前启用的那个模型，配置不清掉，下一次对话直接
 * model not found —— 看起来像是刚卸载就坏了。有别的本地模型就自动切过去，
 * 一个都不剩就退回云端，别把人锁在一个跑不动的配置上。 */
function msDetachIfActive(item){
  if(item.engine === 'ollama'){
    const cur = confGet('llmModel');
    if(cur !== item.ollama) return false;
    const rest = (msState.installed.llm || []).filter(n => n && n !== item.ollama);
    // 备选要连视觉模型一起找：只装了识图模型的人，卸载后不该被踢回云端
    const pool = (typeof catalogOllama === 'function') ? catalogOllama() : catalogOf('llm');
    const alt = rest.length ? pool.find(m => m.ollama === rest[0]) : null;
    if(alt){ msEnable(alt); return true; }
    if($('llmModel')) $('llmModel').value = '';
    if(typeof setLlmMode === 'function') setLlmMode('cloud');
  } else {
    const ckpt = (typeof comfyCkptChoice === 'function') ? comfyCkptChoice() : '';
    if(ckpt !== item.file) return false;
    if(typeof setComfyCkpt === 'function') setComfyCkpt('');
    if(typeof setImgMode === 'function') setImgMode('online');
  }
  if(typeof saveAll === 'function') saveAll();
  if(typeof updateStatusChips === 'function') updateStatusChips();
  if(typeof updateModelLabels === 'function') updateModelLabels();
  return true;
}

async function msRemove(item){
  if(item.kind === 'tts'){
    if(msState.previewId === item.id) msStopPreview();
    if(item.engine !== 'system'){
      /* Kokoro 是共享模型：删的是整份模型，不是这一只音色，文案必须说清楚，
       * 否则用户会以为只删了当前音色、其他 Kokoro 还能用。 */
      if(item.engine === 'kokoro'){
        if(!confirm('删除 Kokoro 超自然语音模型（约 160 MB）？所有 Kokoro 音色都会不可用，之后要用需重新下载。')) return;
        delete msState.error[item.id];
        delete msState.notes[item.id];
        try{
          const d = msDesk();
          if(!d || typeof d.storeRemoveKokoro !== 'function') throw new Error('需通过桌面端删除');
          const r = await d.storeRemoveKokoro();
          if(!r || !r.ok) throw new Error((r && r.message) || '删除失败');
          if(/^kokoro:/.test(msTtsChoice())) msTtsSetVoice('');
          await msRefreshInstalled();
          if(typeof bpToast === 'function') bpToast('已删除 Kokoro 超自然语音模型');
        }catch(e){
          msState.error[item.id] = String((e && e.message) || e);
        }
        msPaintStore();
        return;
      }
      /* Piper 音色可以卸载：删掉 .onnx + .onnx.json。引擎本身是共享的，不跟着删。 */
      if(!confirm('删除本地语音「' + item.name + '」？之后要用需要重新下载。')) return;
      delete msState.error[item.id];
      delete msState.notes[item.id];
      try{
        const d = msDesk();
        if(!d || typeof d.storeRemoveTts !== 'function') throw new Error('需通过桌面端删除');
        const r = await d.storeRemoveTts({ id: item.id, voiceFile: item.voiceFile, voiceJson: item.voiceJson });
        if(!r || !r.ok) throw new Error((r && r.message) || '删除失败');
        if(msIsActive(item)) msTtsSetVoice('');
        await msRefreshInstalled();
        if(typeof bpToast === 'function') bpToast('已删除：' + item.name);
      }catch(e){
        msState.error[item.id] = String((e && e.message) || e);
      }
      msPaintStore();
      return;
    }
    /* 系统语音不能卸载，这里只取消「默认音色」绑定。 */
    delete msState.error[item.id];
    delete msState.notes[item.id];
    if(msIsActive(item)) msTtsSetVoice('');
    msState.previewId = '';
    if(typeof bpToast === 'function') bpToast('已停用：' + item.name);
    msPaintStore();
    return;
  }
  if(!confirm('卸载「' + item.name + '」？下载的文件会被删除，之后要重新下载。')) return;
  delete msState.error[item.id];
  delete msState.notes[item.id];
  try{
    if(item.engine === 'ollama'){
      const p = providerFor('llm', 'ollama-llm');
      if(!p || typeof p.deleteModel !== 'function') throw new Error('不支持卸载');
      await p.deleteModel(item.ollama);
      msState.installed.llm = null;
      await msRefreshInstalled();
    } else {
      const d = msDesk();
      if(!d || typeof d.storeRemoveImage !== 'function') throw new Error('需通过桌面端卸载');
      const r = await d.storeRemoveImage(item.file);
      if(!r || !r.ok) throw new Error((r && r.message) || '删除失败');
      await msRefreshInstalled();
    }
    // 删完才动配置：万一删除失败，配置不该先被清掉
    const detached = msDetachIfActive(item);
    if(typeof bpToast === 'function') bpToast('已卸载：' + item.name + (detached ? '（已切到其他模型）' : ''));
  }catch(e){
    msState.error[item.id] = String((e && e.message) || e);
  }
  msPaintStore();
  if(typeof mcRenderProviders === 'function') mcRenderProviders();
}

/* ---------- 渲染 ---------- */
function msSizeText(item){
  if(item.kind === 'tts' && item.engine === 'system') return '无需下载';
  /* Kokoro 的体积是「共享模型」总量：所有音色共用，避免误读成每只都要下 */
  if(item.kind === 'tts' && item.engine === 'kokoro') return '共享 ' + msFmtGB(item.sizeGB);
  return msFmtGB(item.sizeGB);
}

/* 卡片底部的动作区：系统语音走「设为默认 / 试听」，可下载语音走「下载 / 卸载」，
 * 权重类走「安装 / 启用 / 卸载」。三种语义不能混用——给系统音色画下载进度条，
 * 或给 Piper 音色画一个「系统未安装」，都是最容易穿帮的地方。 */
function msActionHtml(item, prog, installed, active){
  if(item.kind === 'tts'){
    const local = item.engine !== 'system';
    if(!local && !installed) return '<span class="ms-state-note">系统未安装</span>';
    if(local && prog && prog.busy){
      return '<button type="button" class="btn sm" data-ms-act="cancel" data-ms-id="' +
        msEsc(item.id) + '">取消下载</button>';
    }
    const preview = installed
      ? '<button type="button" class="btn sm" data-ms-act="preview" data-ms-id="' +
        msEsc(item.id) + '">' + (msState.previewId === item.id ? '停止' : '试听') + '</button>'
      : '';
    const removeLabel = item.engine === 'kokoro' ? '卸载共享模型' : '卸载';
    if(active){
      return '<span class="ms-on">已启用</span>' + preview +
        '<button type="button" class="btn sm" data-ms-act="remove" data-ms-id="' + msEsc(item.id) + '">' +
        (local ? removeLabel : '停用') + '</button>';
    }
    if(installed){
      return '<button type="button" class="btn sm primary" data-ms-act="enable" data-ms-id="' +
        msEsc(item.id) + '">设为默认</button>' + preview +
        (local
          ? '<button type="button" class="btn sm" data-ms-act="remove" data-ms-id="' + msEsc(item.id) + '">' +
            msEsc(removeLabel) + '</button>'
          : '');
    }
    return '<button type="button" class="btn sm primary" data-ms-act="install" data-ms-id="' +
      msEsc(item.id) + '">下载并启用 · ' +
      (item.engine === 'kokoro' ? '共享 ' : '') + msEsc(msFmtGB(item.sizeGB)) + '</button>';
  }
  if(prog && prog.busy){
    /* 生图模型动辄 2-7 GB，必须有取消入口；语言模型走 Ollama 的 /api/pull，
     * 客户端这边没有中止能力（中断反而会丢掉已下好的层），所以只显示状态。 */
    return (item.engine === 'comfyui')
      ? '<button type="button" class="btn sm" data-ms-act="cancel" data-ms-id="' + msEsc(item.id) + '">取消下载</button>'
      : '<button type="button" class="btn sm" disabled>' +
          (prog.pct > 0 ? '下载中 ' + Math.round(prog.pct) + '%' : '下载中…') + '</button>';
  }
  if(active){
    return '<span class="ms-on">已启用</span>' +
      '<button type="button" class="btn sm" data-ms-act="remove" data-ms-id="' + msEsc(item.id) + '">卸载</button>';
  }
  if(installed){
    return '<button type="button" class="btn sm primary" data-ms-act="enable" data-ms-id="' +
      msEsc(item.id) + '">启用</button>' +
      '<button type="button" class="btn sm" data-ms-act="remove" data-ms-id="' + msEsc(item.id) + '">卸载</button>';
  }
  return '<button type="button" class="btn sm primary" data-ms-act="install" data-ms-id="' +
    msEsc(item.id) + '">安装</button>';
}

function msCard(item){
  const fit = msFit(item);
  const prog = msProg(item.id);
  const err = msState.error[item.id];
  const note = msState.notes[item.id];
  const installed = msIsInstalled(item);
  const active = msIsActive(item);
  const kind = MS_KIND[item.kind] ? item.kind : 'llm';
  const meta = MS_KIND[kind];

  const tags = (item.tags || []).map(t => '<span class="ms-tag">' + msEsc(t) + '</span>').join('');
  const fitCls = fit.level === 'good' ? 'ok' : (fit.level === 'cpu' ? 'warn' : (fit.level === 'no' ? 'bad' : 'mute'));
  const metaText = (item.kind === 'tts')
    ? [item.params, item.lang, item.org].filter(Boolean).join(' · ')
    : (item.params || '') + (item.params ? ' · ' : '') + (item.org || '') +
      ' · 需约 ' + item.vramGB + ' GB 显存';

  const badges = [];
  if((item.tags || []).indexOf('推荐') !== -1) badges.push('<span class="ms-badge rec">推荐</span>');
  if(active) badges.push('<span class="ms-badge on">已启用</span>');
  else if(installed && (item.kind !== 'tts' || item.engine !== 'system')) badges.push('<span class="ms-badge ins">已安装</span>');

  const ttsTip = (item.kind === 'tts' && item.engine === 'system' && !msVoiceMatch(item))
    ? '<div class="ms-tip-line">系统里没有这只音色：到 Windows「设置 → 时间和语言 → 语音」添加语音包，再点右上角「刷新语音」。</div>'
    : (item.kind === 'tts' && item.engine === 'kokoro' && !installed
      ? '<div class="ms-tip-line">所有 Kokoro 音色共用同一份模型：首次下载约 160 MB，之后切换音色不再重复下载。</div>'
      : '');

  let progHtml = '';
  if(prog && (prog.busy || prog.msg)){
    /* pct < 0 表示引擎还没报出总大小（刚发 pull、正在读清单）。
     * 这时候不能画一根 0% 的空条——用户看到的是「一条灰杠，永远不动」，
     * 会以为点了没反应。改走不确定态：斜纹来回跑，表达「在动，但还不知道到哪」。 */
    const indet = !(prog.pct >= 0) && !!prog.busy;
    const q = indet ? 0 : Math.max(0, Math.min(100, prog.pct));
    const metaParts = [];
    const spd = (typeof mcFmtSpd === 'function') ? mcFmtSpd(prog.speed) : '';
    if(spd) metaParts.push(spd);
    const eta = (typeof mcFmtEta === 'function') ? mcFmtEta(prog.etaMs) : '';
    if(eta) metaParts.push('剩余 ' + eta);
    progHtml = '<div class="ms-prog' + (indet ? ' indet' : '') + '"><i' +
        (indet ? '' : ' style="width:' + q + '%"') + '></i></div>' +
      '<div class="ms-prog-txt">' + msEsc(prog.msg || '下载中…') +
        (metaParts.length ? ' · ' + msEsc(metaParts.join(' · ')) : '') + '</div>';
  }

  return '<div class="ms-card' + (active ? ' on' : '') + '" data-ms-card="' + msEsc(item.id) + '">' +
    '<div class="ms-card-top">' +
      '<span class="ms-ico ms-ico-' + kind + '">' + msEsc(meta.ico) + '</span>' +
      '<div class="ms-card-id">' +
        '<div class="ms-name" title="' + msEsc(item.name) + '">' + msEsc(item.name) + '</div>' +
        '<div class="ms-meta">' + msEsc(metaText) + '</div>' +
      '</div>' +
      '<span class="ms-size">' + msEsc(msSizeText(item)) + '</span>' +
    '</div>' +
    (badges.length ? '<div class="ms-badges">' + badges.join('') + '</div>' : '') +
    /* 生图模型把权重文件名写出来：ComfyUI 是按文件名认模型的，
     * 用户在自己的目录里核对、或改 ckpt 时需要这个名字 */
    (item.file ? '<div class="ms-file">' + msEsc(item.file) + '</div>' : '') +
    '<div class="ms-desc">' + msEsc(item.desc || '') + '</div>' +
    (tags ? '<div class="ms-tags">' + tags + '</div>' : '') +
    /* 语音卡不再重复「系统语音，无需下载，不占显存」：右上角已经有「无需下载」，
     * 分节里也写了同一句；缺音色时绿色的「够用」结论还会和「系统未安装」打架。 */
    (item.kind === 'tts' ? '' : '<div class="ms-fit ' + fitCls + '">' + msEsc(fit.note || '') + '</div>') +
    ttsTip +
    (progHtml || '') +
    (err ? '<div class="ms-err">' + msEsc(err) + '</div>' : '') +
    (note ? '<div class="ms-note">' + msEsc(note) + '</div>' : '') +
    '<div class="ms-foot">' + msActionHtml(item, prog, installed, active) + '</div>' +
  '</div>';
}

function msKindItems(kind){
  const base = kind === 'tts'
    ? msTtsItems().concat(msTtsLocal())
    : catalogOf(kind);
  return base.filter(m =>
    msMatchesQuery(m) && (!msState.fitOnly || msFit(m).level !== 'no'));
}
function msKindCount(kind){
  return kind === 'tts' ? msTtsItems().length + msTtsLocal().length : catalogOf(kind).length;
}

function msMatchesQuery(item){
  const q = String(msState.q || '').trim().toLowerCase();
  if(!q) return true;
  const hay = [item.name, item.org, item.desc, item.params, item.lang, item.id,
    (item.tags || []).join(' ')].join(' ').toLowerCase();
  return hay.indexOf(q) !== -1;
}

function msSection(kind){
  const meta = MS_KIND[kind];
  if(!meta) return '';
  const items = msKindItems(kind);
  if(!items.length) return '';
  let extra = '';
  if(kind === 'vision'){
    /* 装了识图模型却不知道在哪用，是这类功能最常见的「装了没用」投诉。
     * 用「AI 任务」节点是唯一真正会把图片以 image_url 发出去的地方。 */
    extra = '<div class="ms-tip">识图模型用在流程的「AI 任务」节点——把图片接到该节点的图片输入，问题写在提示词里即可。' +
      '「设置 → 分析接口」的连通性测试也会顺带带上参考图。</div>';
  } else if(kind === 'image'){
    extra = msImageEngineHint();
  } else if(kind === 'tts'){
    extra = '<div class="ms-tip">上半部分是本机已经装好的系统语音，检测到几只就列几只，零下载、立即可用；' +
      '带「下载」标记的是本地高级音色：Piper 是几十 MB 的单个权重，Kokoro 是约 126 MB 的共享超自然模型，' +
      '都由 CPU 在本地合成，断网也能朗读。' +
      '想用晓晓 / 云希等神经音色，到 Windows「设置 → 时间和语言 → 语音」安装对应语音包后点「刷新语音」。</div>';
  }
  return '<section class="ms-sec" data-ms-kind="' + kind + '">' +
    '<div class="ms-sec-head">' +
      '<div class="ms-sec-titles">' +
        '<span class="ms-sec-title">' + msEsc(meta.label) + '</span>' +
        '<span class="ms-sec-hint">' + msEsc(meta.hint) + '</span>' +
      '</div>' +
      '<span class="ms-sec-n">' + items.length + '</span>' +
      (kind === 'tts'
        ? '<button type="button" class="btn sm" data-ms-act="refresh-voices">刷新语音</button>'
        : '') +
    '</div>' + extra +
    '<div class="ms-grid">' + items.map(msCard).join('') + '</div>' +
  '</section>';
}

/* 网页版只能按型号猜显存（texture / WebGL 拿不到 VRAM），桌面端读注册表才是真值。
 * 猜出来的结论可能偏乐观，所以显式标注一句，别让人以为「跑得动」是实测结果。 */
function msGuessHint(){
  const g = msState.hw && msState.hw.gpu;
  if(!g || g.source !== 'renderer') return '';
  return '<div class="ms-hint"><span class="ms-hint-item">网页版读不到真实显存，适配结论按显卡型号估算，仅供参照</span></div>';
}

/* 生图模型依附于 ComfyUI：引擎不在时把「会连带装什么」提前讲清楚 */
function msImageEngineHint(){
  const known = (typeof mcComfy === 'object' && mcComfy) ? mcComfy : null;
  if(!known || known.running) return '';
  const what = known.checked && known.installed ? '还没启动' : '还没装';
  return '<div class="ms-tip">本机 ComfyUI ' + msEsc(what) +
    '：点「安装」会自动处理（引擎约 2 GB，装完自动启动），不需要你另外做步骤。' +
    '想单独管理引擎，去工作台的「本地生图」。</div>';
}

/* ---------- 精选横幅 ---------- */
function msHeroItem(){
  const kinds = msState.filter === 'all' ? ['llm', 'vision', 'image'] : [msState.filter];
  const pool = [];
  kinds.forEach(k => catalogOf(k).forEach(m => {
    if(msMatchesQuery(m) && (!msState.fitOnly || msFit(m).level !== 'no')) pool.push(m);
  }));
  const rec = pool.filter(m => (m.tags || []).indexOf('推荐') !== -1);
  return rec.filter(m => !msIsInstalled(m))[0] || rec[0] || pool[0] || null;
}

function msHardwareLine(){
  const hw = msState.hw || {};
  const g = hw.gpu || {};
  const ram = (hw.memory && hw.memory.deviceMemoryGB) || 0;
  const parts = [];
  if(g.vramMB) parts.push('显卡 ' + Math.round(g.vramMB / 1024) + ' GB');
  else if(g.discrete === false) parts.push('未检测到独立显卡');
  if(ram) parts.push('内存 ' + ram + ' GB');
  return parts.length ? parts.join(' · ') : '未检测到硬件信息';
}

function msHeroHtml(){
  if(msState.view === 'installed') return '';
  if(msState.filter === 'tts'){
    const sysN = msTtsItems().length;
    const localN = msTtsLocal().length;
    return '<div class="ms-hero ms-hero-tts">' +
      '<div class="ms-hero-main">' +
        '<div class="ms-hero-kicker">VOICE</div>' +
        '<div class="ms-hero-title">系统语音零等待，超自然音色按需下载</div>' +
        '<div class="ms-hero-sub">系统语音直接调用 Windows 语音包，选中即可试听、设为默认；' +
          '需要更自然的效果就下 Kokoro：82M 参数、int8 量化，语调接近真人，纯 CPU 合成、断网可用，不占显存。' +
          'Piper 则胜在体积小、下载快。</div>' +
      '</div>' +
      '<div class="ms-hero-side"><span class="ms-hero-stat">系统 ' + sysN + ' 个 · 可下载 ' + localN + ' 个</span></div>' +
    '</div>';
  }
  const item = msHeroItem();
  if(!item) return '';
  const fit = msFit(item);
  const fitCls = fit.level === 'good' ? 'ok' : (fit.level === 'cpu' ? 'warn' : (fit.level === 'no' ? 'bad' : 'mute'));
  const active = msIsActive(item);
  const installed = msIsInstalled(item);
  const cta = active ? '' : (installed
    ? '<button type="button" class="btn sm primary" data-ms-act="enable" data-ms-id="' + msEsc(item.id) + '">启用</button>'
    : '<button type="button" class="btn sm primary" data-ms-act="install" data-ms-id="' + msEsc(item.id) + '">一键安装</button>');
  return '<div class="ms-hero">' +
    '<div class="ms-hero-main">' +
      '<div class="ms-hero-kicker">本机推荐</div>' +
      '<div class="ms-hero-title">' + msEsc(item.name) + '</div>' +
      '<div class="ms-hero-sub">' + msEsc(item.desc || '') + '</div>' +
    '</div>' +
    '<div class="ms-hero-side">' +
      '<span class="ms-hero-stat">' + msEsc(msHardwareLine()) + '</span>' +
      '<span class="ms-hero-fit ' + fitCls + '">' + msEsc(fit.note || '') + '</span>' +
      cta +
    '</div>' +
  '</div>';
}

/* ---------- 侧栏 / 外壳 ---------- */
function msEnginesHtml(){
  const ollamaOk = !!(rtHealth && rtHealth.ollama && rtHealth.ollama.ok);
  const comfyOk = !!(typeof mcComfy === 'object' && mcComfy && mcComfy.running);
  const voiceN = msVoiceList().length;
  const piperN = msTtsLocal().filter(m => m.engine === 'piper' && msTtsLocalInstalled(m)).length;
  const kokoroN = msTtsLocal().filter(m => m.engine === 'kokoro').length;
  const kokoroOk = !!msState.installed.kokoro;
  function row(name, ok, text){
    return '<div class="ms-engine-row"><span class="ms-engine-dot ' + (ok ? 'ok' : 'bad') + '"></span>' +
      name + '<span class="ms-engine-txt">' + text + '</span></div>';
  }
  return row('Ollama', ollamaOk, ollamaOk ? '运行中' : '未运行') +
    row('ComfyUI', comfyOk, comfyOk ? '运行中' : '未运行') +
    row('系统语音', voiceN > 0, voiceN > 0 ? voiceN + ' 个音色' : '未检测到') +
    row('Piper 本地语音', piperN > 0, piperN > 0 ? piperN + ' 个音色' : '未下载') +
    row('Kokoro 超自然语音', kokoroOk, kokoroOk ? kokoroN + ' 个音色可用' : '未下载');
}

function msInstalledItems(){
  const list = [];
  ['llm', 'vision', 'image'].forEach(k => catalogOf(k).forEach(m => {
    if(msIsInstalled(m) && msMatchesQuery(m)) list.push(m);
  }));
  /* 系统语音是「有就能用」，直接来自本机语音列表，不走目录预设 */
  msTtsItems().forEach(m => { if(msMatchesQuery(m)) list.push(m); });
  /* 已下载的本地音色（Piper 按文件、Kokoro 按共享模型）同样算已安装 */
  msTtsLocal().forEach(m => { if(msIsInstalled(m) && msMatchesQuery(m)) list.push(m); });
  return list;
}

/* 侧栏的「已安装」计数不跟搜索走：它回答的是「本机装了多少」，
 * 不应该因为顶栏输入了一个关键词就变小。 */
function msInstalledCount(){
  let n = 0;
  ['llm', 'vision', 'image'].forEach(k => catalogOf(k).forEach(m => {
    if(msIsInstalled(m)) n++;
  }));
  msTtsLocal().forEach(m => { if(msIsInstalled(m)) n++; });
  return n + msTtsItems().length;
}

function msVisibleCount(){
  if(msState.view === 'installed') return msInstalledItems().length;
  const kinds = msState.filter === 'all' ? ['llm', 'vision', 'image', 'tts'] : [msState.filter];
  let n = 0;
  kinds.forEach(k => { n += msKindItems(k).length; });
  return n;
}

function msResultsHtml(){
  if(msState.view === 'installed'){
    const items = msInstalledItems();
    if(!items.length){
      const hasAny = msInstalledCount() > 0;
      return '<div class="ms-empty"><b>' + (hasAny ? '没有匹配的已安装模型' : '还没有已安装的模型') + '</b>' +
        '<span>' + (hasAny
          ? '换个关键词，或清空搜索再看。'
          : '到左侧「全部模型」里挑一个，点安装后会出现在这里。') + '</span></div>';
    }
    return '<section class="ms-sec" data-ms-kind="installed">' +
      '<div class="ms-sec-head"><div class="ms-sec-titles">' +
        '<span class="ms-sec-title">已安装</span>' +
        '<span class="ms-sec-hint">包含系统语音与已下载的本地语音；卸载 Kokoro 会删除整份共享模型</span>' +
      '</div><span class="ms-sec-n">' + items.length + '</span></div>' +
      '<div class="ms-grid">' + items.map(msCard).join('') + '</div>' +
    '</section>';
  }
  const kinds = msState.filter === 'all' ? ['llm', 'vision', 'image', 'tts'] : [msState.filter];
  const body = kinds.map(k => msSection(k)).filter(Boolean).join('');
  const empty = '<div class="ms-empty"><b>没有匹配的模型</b><span>换个关键词，或清空筛选再试。</span></div>';
  /* 语音类目最怕「检测到 0 个」却只给一句通用空态：
   * 这里直接说清去哪儿装、装完点哪个按钮。 */
  if(msState.filter === 'tts' && !msVoiceList().length && !msTtsLocal().length){
    return msHeroHtml() +
      '<div class="ms-empty"><b>没有检测到可用的语音</b>' +
      '<span>到 Windows「设置 → 时间和语言 → 语音」添加语音包，完成后点下面的按钮刷新。</span>' +
      '<button type="button" class="btn sm primary" data-ms-act="refresh-voices">刷新语音</button></div>';
  }
  return msHeroHtml() + msGuessHint() + (body || empty);
}

function msShellHtml(){
  const allLen = MS_FILTERS.reduce((sum, kv) => sum + (kv[0] === 'all' ? 0 : msKindCount(kv[0])), 0);
  const nav = MS_FILTERS.map(kv => {
    const v = kv[0];
    const n = v === 'all' ? allLen : msKindCount(v);
    const on = msState.view !== 'installed' && msState.filter === v;
    return '<button type="button" class="ms-nav-btn' + (on ? ' on' : '') + '" data-ms-filter="' + v + '">' +
      '<span class="ms-nav-dot"></span><span class="ms-nav-label">' + msEsc(kv[1]) + '</span>' +
      '<span class="ms-nav-n">' + n + '</span></button>';
  }).join('');
  const installed = msInstalledCount();
  const visible = msVisibleCount();
  return '<div class="ms-layout">' +
    '<aside class="ms-side">' +
      '<div class="ms-brand">' +
        '<span class="ms-brand-mark">M</span>' +
        '<div><div class="ms-brand-name">模型商店</div>' +
          '<div class="ms-brand-sub">本地模型 · 语音 · 一键安装</div></div>' +
      '</div>' +
      '<nav class="ms-nav">' + nav + '<div class="ms-nav-sep"></div>' +
        '<button type="button" class="ms-nav-btn' + (msState.view === 'installed' ? ' on' : '') + '" data-ms-view="installed">' +
          '<span class="ms-nav-dot"></span><span class="ms-nav-label">已安装</span>' +
          '<span class="ms-nav-n">' + installed + '</span></button>' +
      '</nav>' +
      '<div class="ms-engines"><div class="ms-engines-title">引擎状态</div>' + msEnginesHtml() + '</div>' +
    '</aside>' +
    '<section class="ms-main">' +
      '<div class="ms-toolbar">' +
        '<div class="ms-search"><span class="ms-search-ico" aria-hidden="true"></span>' +
          '<input type="text" data-ms-search placeholder="搜索模型、厂商或标签" value="' + msEsc(msState.q) +
            '" autocomplete="off" spellcheck="false"></div>' +
        '<label class="ms-toggle"><input type="checkbox" data-ms-fit' + (msState.fitOnly ? ' checked' : '') +
          '> 只看跑得动的</label>' +
        '<span class="ms-toolbar-count" id="msCount">' + visible + ' 个条目</span>' +
        '<button type="button" class="btn sm" data-ms-act="refresh">刷新状态</button>' +
      '</div>' +
      '<div class="ms-body" id="msBody">' + msResultsHtml() + '</div>' +
    '</section>' +
  '</div>';
}

/* 只重画结果区：搜索时不能整块重绘，否则输入框会失去焦点，
 * 表现就是「打一个字就跳出输入框」。 */
function msPaintResults(){
  const body = $('msBody');
  if(body) body.innerHTML = msResultsHtml();
  const count = $('msCount');
  if(count) count.textContent = msVisibleCount() + ' 个条目';
}

function msBindStoreEvents(box){
  if(!box || box.dataset.msBound === '1') return;
  box.dataset.msBound = '1';
  box.addEventListener('click', msOnStoreClick);
  box.addEventListener('change', msOnStoreChange);
  box.addEventListener('input', msOnStoreInput);
}

function msOnStoreClick(e){
  const t = e && e.target;
  const el = (t && typeof t.closest === 'function')
    ? t.closest('[data-ms-filter],[data-ms-view],[data-ms-act]') : null;
  if(!el) return;
  if(el.dataset.msFilter){
    msState.filter = el.dataset.msFilter;
    msState.view = 'browse';
    msPaintStore();
    return;
  }
  if(el.dataset.msView){
    msState.view = el.dataset.msView;
    msPaintStore();
    return;
  }
  const act = el.dataset.msAct;
  if(!act) return;
  if(act === 'refresh'){ msRefreshAll(); return; }
  if(act === 'refresh-voices'){ msRefreshVoices(true); return; }
  const item = msFindItem(el.dataset.msId);
  if(!item) return;
  if(act === 'install') msInstall(item, el);
  else if(act === 'cancel') msCancel(item);
  else if(act === 'preview') msPreview(item);
  else if(act === 'remove') msRemove(item);
  else if(act === 'enable'){
    try{
      msEnable(item);
      if(typeof bpToast === 'function') bpToast('已启用：' + item.name);
    }catch(err){
      msState.error[item.id] = String((err && err.message) || err);
    }
    msPaintStore();
    if(typeof mcRenderProviders === 'function') mcRenderProviders();
  }
}

function msOnStoreChange(e){
  const t = e && e.target;
  if(!t || !t.dataset || !('msFit' in t.dataset)) return;
  msState.fitOnly = !!t.checked;
  msPaintStore();
}

function msOnStoreInput(e){
  const t = e && e.target;
  if(!t || !t.dataset || t.dataset.msSearch === undefined) return;
  msState.q = String(t.value || '');
  msPaintResults();
}

function msRefreshVoices(showToast){
  msBindVoices();
  msPaintStore();
  if(showToast && typeof bpToast === 'function'){
    const n = msVoiceList().length;
    bpToast(n ? '已检测到 ' + n + ' 个系统语音' : '没有检测到系统语音，请先在 Windows 设置里添加语音包，或下载下面的 Kokoro 超自然音色');
  }
}

async function msRefreshAll(){
  try{ if(typeof rtRefresh === 'function') await rtRefresh(); }catch(e){}
  try{ if(typeof mcComfyDetect === 'function') await mcComfyDetect(); }catch(e){}
  try{ if(typeof mcDetectEngine === 'function') await mcDetectEngine(true); }catch(e){}
  let hw = msState.hw;
  try{ hw = (typeof probeHardware === 'function') ? await probeHardware(false) : msState.hw; }catch(e){}
  await renderModelStore(hw);
}

function msPaintStore(){
  const box = $('mcStore');
  if(!box) return;
  msBindVoices();
  msBindStoreEvents(box);
  box.innerHTML = msShellHtml();
}

let msProgBound = false;
function msBindStoreProgress(){
  if(msProgBound) return;
  const d = msDesk();
  if(!d || typeof d.onStoreProgress !== 'function') return;
  msProgBound = true;
  d.onStoreProgress(info => {
    if(!info || !info.id) return;
    const cur = msProg(info.id) || { pct: -1, msg: '', speed: 0, etaMs: -1, busy: true };
    const pct = (typeof info.pct === 'number' && info.pct >= 0) ? info.pct : cur.pct;
    msSetProg(info.id, {
      pct,
      msg: info.message || cur.msg,
      speed: typeof info.speed === 'number' ? info.speed : cur.speed,
      etaMs: typeof info.etaMs === 'number' ? info.etaMs : cur.etaMs,
      busy: info.stage !== 'done' && info.stage !== 'error'
    });
  });
}

async function renderModelStore(hw){
  if(hw) msState.hw = hw;
  else if(!msState.hw && typeof probeHardware === 'function') msState.hw = await probeHardware(false);
  try{ await msRefreshInstalled(); }catch(e){}
  msBindStoreProgress();
  msState.ready = true;
  msPaintStore();
}

/* 工作台上的「模型商店」app 入口。
 * 每次打开都重探一次引擎与本机硬件：用户很可能刚在别处装完 Ollama/ComfyUI，
 * 用上次缓存的状态会显示成「未安装」，看起来像装失败了。 */
async function openModelStore(){
  const win = $('storeWin');
  if(!win) return;
  /* 统一走 App 页翻页（deskMountApp 定义在 desk-shell.js）；拿不到时退回弹窗 */
  if(typeof deskMountApp === 'function') deskMountApp(win, '模型商店', '本地模型 · 语音 · 一键安装');
  else win.classList.remove('hidden');
  if(!msState.hw) msPaintStore();      // 先出骨架，别让窗口空白等探测
  try{ if(typeof rtRefresh === 'function') await rtRefresh(); }catch(e){}
  try{ if(typeof mcComfyDetect === 'function') await mcComfyDetect(); }catch(e){}
  try{ await mcDetectEngine(true); }catch(e){}
  let hw = null;
  try{ hw = (typeof probeHardware === 'function') ? await probeHardware(false) : null; }catch(e){}
  await renderModelStore(hw);
  return true;
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = { MS_FILTERS, msState, msInstall, msEnable, msRemove, msIsActive, msIsInstalled, msPaintStore, openModelStore };
}
