/* 模型控制台（阶段 B）：设备探针 + 能力分类 + Provider 状态
 * 依赖阶段 A 的 hardware.js（probeHardware / describeHardware）与 provider.js（PROVIDER_KINDS / providersOfKind）。
 * 渲染进桌面浮动窗口 #modelsWin；阶段 C 接入 Ollama / ComfyUI 后，本地引擎也会出现在这里的 Provider 分组里。
 */
const MC_KIND_LABEL = { llm: '语言模型', image: '生图', '3d': '3D 建模', tts: '语音合成' };
const MC_GLYPH_OF = { llm: 'chat', image: 't2i', '3d': 'i2i', tts: 'flow' };

function mcEsc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let mcModelCache = {};
async function mcProbeAll(force){
  const h = await probeHardware(force);
  const box = $('mcHard');
  if(!box) return h;
  const rec = h.recommend || {};
  const recChip = [
    rec.llm && rec.llm.note ? '<span class="mc-rec">LLM ' + mcEsc(rec.llm.note) + '</span>' : '',
    rec.image && rec.image.note ? '<span class="mc-rec">生图 ' + mcEsc(rec.image.note) + '</span>' : ''
  ].filter(Boolean).join('');
  const otherGpus = (typeof describeOtherGpus === 'function') ? describeOtherGpus(h) : '';
  const gpuNote = (h.gpu && h.gpu.ok && h.gpu.webgpu === false)
    ? '浏览器未启用 WebGPU（本地引擎走独立进程，不受影响）'
    : (h.gpu && h.gpu.source === 'renderer' ? '网页版只能看到浏览器分配的那块显卡' : '');
  box.innerHTML =
    '<div class="mc-hard-head">' +
      '<span class="mc-hard-title">本机硬件</span>' +
      '<button type="button" class="btn sm" id="btnMcReProbe">重新探测</button>' +
    '</div>' +
    '<div class="mc-hard-line">' + mcEsc(describeHardware(h)) + '</div>' +
    (otherGpus ? '<div class="mc-hard-line mc-hard-sub">' + mcEsc(otherGpus) + '</div>' : '') +
    (recChip ? '<div class="mc-rec-row">' + recChip + '</div>' : '') +
    '<div class="mc-hard-meta">探测时间 ' + new Date(h.probedAt).toLocaleTimeString() +
      (gpuNote ? ' · ' + gpuNote : '') + '</div>';
  const reprobe = $('btnMcReProbe');
  if(reprobe && !reprobe.dataset.bound){
    reprobe.dataset.bound = '1';
    reprobe.addEventListener('click', () => mcProbeAll(true));
  }
  return h;
}

/* ---- 本地引擎（Ollama）三态管理 ----
 * 三态由「桌面端是否装了 Ollama」+「运行时是否连上引擎」共同决定：
 * missing 未安装 / stopped 已安装未运行 / run 运行中。
 *
 * 下载安装包是 ~1.6 GB，国内直连 GitHub 只有十几 KB/s，
 * 主进程会先测速选镜像再分片并发下载。这里必须把速度 / 剩余时间 / 当前源显式摆出来，
 * 否则用户面对一个几小时不动的进度条，根本分不清「慢」和「卡死」。
 */
const mcEng = {
  checked: false, installed: false, exe: '', busy: '', progress: '', pct: -1,
  speed: 0, etaMs: -1, src: '', stage: '', cancelled: false,
  autoErr: ''            // 开机自动启动失败的原因（成功或运行中时清空）
};

function mcDesk(){
  const d = window.openagiDesktop;
  return d && typeof d === 'object' ? d : null;
}

/* ---- 引擎自动启动的开关与状态 ----
 * 默认值（见 electron/engine-autostart.js）：Ollama 开、ComfyUI 开、预热开。
 * 预热改成开是有实测依据的：Ollama 冷加载模型时会派生 GPU 探测子进程，
 * 那个子进程要新分配一个 console → 触发 Windows 11 的默认终端委托 →
 * 弹出 Windows Terminal 深色窗口，也就是「初次 AI 对话弹出几个一闪而过的黑窗口」。
 * 预热 + 持续保活让模型一直常驻显存，就不会再冷加载，也就不会再派生那些进程。
 * 这三行必须能被用户改：自动启动是「方便」，不是「替用户决定要不要占显存」。 */
const mcEngAuto = { loaded: false, ollama: true, comfy: true, warm: true };

/* 保活状态（哪个模型正驻留在显存里）。
 * 界面上要看得见：不然用户没法判断「黑窗口还会不会再出现」——
 * 修复是隐形的，但用户需要能确认它生效了。 */
const mcKeep = { model: '', running: false };

async function mcLoadEngAuto(){
  if(mcEngAuto.loaded) return mcEngAuto;
  const d = mcDesk();
  if(!d || typeof d.enginesConfig !== 'function'){ mcEngAuto.loaded = true; return mcEngAuto; }
  try{
    const cfg = await d.enginesConfig();
    if(cfg) Object.assign(mcEngAuto, cfg);
  }catch(e){}
  mcEngAuto.loaded = true;
  return mcEngAuto;
}

/* 开关行。勾上即刻启动一次（不用等下次开程序）——用户来勾它，就是因为现在想用。 */
function mcAutoRow(items){
  return '<div class="mc-eng-auto">' + items.map(it =>
    '<label' + (it[2] ? ' title="' + mcEsc(it[2]) + '"' : '') + '>' +
      '<input type="checkbox" data-eng-auto="' + it[0] + '"' + (mcEngAuto[it[0]] ? ' checked' : '') + '>' +
      '<span>' + mcEsc(it[1]) + '</span>' +
    '</label>').join('') + '</div>';
}

function mcBindAutoToggles(box){
  if(!box || typeof box.querySelectorAll !== 'function') return;
  box.querySelectorAll('[data-eng-auto]').forEach(b => {
    b.addEventListener('change', () => mcToggleEngAuto(b.dataset.engAuto, !!b.checked));
  });
}

async function mcToggleEngAuto(key, on){
  const d = mcDesk();
  if(!d || typeof d.enginesSetConfig !== 'function') return;
  mcEngAuto[key] = !!on;
  mcEngAuto.loaded = true;
  const patch = {};
  patch[key] = !!on;
  try{
    const cfg = await d.enginesSetConfig(patch);
    if(cfg) Object.assign(mcEngAuto, cfg);
  }catch(e){}
  mcPaintEng();
  mcPaintComfy();
  if(!on){
    // 取消勾选只写配置：已经在跑的进程不打断，正在做的事不该被一个开关掐掉
    if(typeof bpToast === 'function') bpToast('已关闭开机自动启动（下次启动生效）');
    return;
  }
  if(typeof d.enginesAutoStart === 'function'){
    try{ await d.enginesAutoStart(); }catch(e){}
  }
}

let mcAutoStatusBound = false;
function mcBindEngineStatus(){
  if(mcAutoStatusBound) return;
  const d = mcDesk();
  if(!d || typeof d.onEngineStatus !== 'function') return;
  mcAutoStatusBound = true;
  d.onEngineStatus(st => { mcApplyEngineStatus(st); });
}

/* 主进程的自动启动发生在**后台**。不把状态接进来，用户会看到「已安装 · 未运行」
 * 却什么也没发生（其实 Python 正在加载 torch），然后去点「启动引擎」撞上「正在启动中」。 */
async function mcApplyEngineStatus(st){
  if(!st || typeof st !== 'object') return;
  let touched = false;

  if(st.ollama === 'starting' && mcEng.busy !== '安装中'){
    mcEng.busy = '启动中';
    mcEng.progress = st.ollamaNote || '正在启动 Ollama…';
    mcEng.pct = -1;
    mcEng.autoErr = '';
    touched = true;
  } else if(st.ollama === 'ready' || st.ollama === 'already'){
    if(mcEng.busy === '启动中'){ mcEng.busy = ''; mcEng.progress = ''; touched = true; }
    if(mcEng.autoErr){ mcEng.autoErr = ''; touched = true; }
  } else if(st.ollama === 'failed'){
    /* 自动启动失败要留在卡片上：用户可能等程序跑完才打开控制台，
     * 那时既没有进度也没有红字，只剩一句「已安装 · 未运行」——等于没说为什么。 */
    mcEng.autoErr = st.ollamaNote || '原因未知';
    if(mcEng.busy === '启动中'){ mcEng.busy = ''; mcEng.progress = ''; }
    touched = true;
  }

  if(st.comfy === 'starting'){
    if(mcComfy.busy !== '安装中') mcComfy.busy = '启动中';
    mcComfy.progress = st.comfyNote || '正在启动 ComfyUI…';
    mcComfy.pct = -1;
    mcComfy.autoErr = '';
    touched = true;
  } else if(st.comfy === 'ready' || st.comfy === 'already'){
    if(mcComfy.busy === '启动中'){ mcComfy.busy = ''; mcComfy.progress = ''; }
    mcComfy.running = true;
    mcComfy.autoErr = '';
    touched = true;
  } else if(st.comfy === 'failed'){
    mcComfy.autoErr = st.comfyNote || '原因未知';
    if(mcComfy.busy === '启动中'){ mcComfy.busy = ''; mcComfy.progress = ''; }
    touched = true;
  }
  if(!touched) return;

  const up = st.ollama === 'ready' || st.ollama === 'already' || st.comfy === 'ready' || st.comfy === 'already';
  if(up){ try{ await rtRefresh(); }catch(e){} }
  mcPaintEng();
  mcPaintComfy();
  try{ mcRenderProviders(); }catch(e){}
}

function mcEngState(){
  /* 「启动中」压过别的一切：开机自动启动时桥上的探活可能还是绿的（上一个实例没退干净），
   * 只看 rtHealth 会渲染成「运行中 + 启动中…」这种自相矛盾的组合。
   * 直接从 busy 推导，不另存一份状态，省掉两处 boolean 不同步的隐患。 */
  if(mcEng.busy === '启动中') return 'starting';
  if(rtHealth.ollama && rtHealth.ollama.ok) return 'run';
  return mcEng.installed ? 'stopped' : 'missing';
}

async function mcDetectEngine(force){
  if(mcEng.checked && !force) return mcEng.installed;
  const d = mcDesk();
  if(!d || typeof d.ollamaDetect !== 'function'){
    mcEng.checked = true;
    mcEng.installed = false;
    return false;
  }
  try{
    const r = await d.ollamaDetect();
    mcEng.installed = !!(r && r.installed);
    mcEng.exe = (r && r.exe) || '';
  }catch(e){
    mcEng.installed = false;
  }
  mcEng.checked = true;
  return mcEng.installed;
}

// 主进程把源地址换成了可读名字；这里再兜一层，避免把长 URL 塞进小字
function mcSrcLabel(s){
  if(!s) return '';
  if(/github\.com|githubusercontent|ollama\.com/.test(s) && !/^https?:\/\/gh/.test(s)) return 'GitHub 直连';
  const m = /^https?:\/\/([^/]+)/.exec(s);
  if(!m) return String(s);
  return m[1].replace(/^www\./, '');
}

function mcFmtEta(ms){
  if(!(ms >= 0) || !isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  if(s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if(m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
  return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
}

function mcFmtSpd(bps){
  const n = Number(bps);
  if(!(n > 0)) return '';
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB/s' : Math.round(n / 1024) + ' KB/s';
}

let mcEngBound = false;
function mcBindEngProgress(){
  if(mcEngBound) return;
  mcEngBound = true;
  const d = mcDesk();
  if(!d || typeof d.onOllamaProgress !== 'function') return;
  d.onOllamaProgress(info => {
    if(!info) return;
    // 不再因为 busy 不是「安装中」就丢消息：刷新页面后 busy 是空的，
    // 但主进程仍在下载，进度必须能接上——收到下载类进度就自己认领成「安装中」。
    const stage = String(info.stage || '');
    if(stage === 'download' || stage === 'verify' || stage === 'install' || stage === 'probe'){
      if(!mcEng.busy) mcEng.busy = '安装中';
    }
    // pct 是主进程算好的**整条进度**（0-100），前端不许再乘系数——
    // 曾经前端再乘 0.5，安装阶段进度条会从 55% 掉回 28%，看起来像倒退卡死。
    if(typeof info.pct === 'number') mcEng.pct = info.pct;
    if(info.message) mcEng.progress = info.message;
    if(typeof info.speed === 'number') mcEng.speed = info.speed;
    if(typeof info.etaMs === 'number') mcEng.etaMs = info.etaMs;
    if(info.source) mcEng.src = info.source;
    if(info.version) mcEng.ver = info.version;
    if(stage) mcEng.stage = stage;
    if(stage === 'cancelled') mcEng.cancelled = true;
    if(stage === 'done' || stage === 'error' || stage === 'cancelled'){
      mcEng.busy = '';
    }
    mcPaintEng();
  });
}

/* 打开面板时同步主进程状态：正在下载就恢复进度条，别让用户以为白等了 */
async function mcSyncEngStatus(){
  const d = mcDesk();
  if(!d || typeof d.ollamaStatus !== 'function') return;
  try{
    const st = await d.ollamaStatus();
    if(st && st.installing){
      mcEng.busy = '安装中';
      const p = st.progress || {};
      // pct 已经是整条进度（0-100），直接用，不再折算
      if(typeof p.pct === 'number') mcEng.pct = p.pct;
      mcEng.progress = p.message || '正在下载 Ollama 安装包…';
      if(typeof p.speed === 'number') mcEng.speed = p.speed;
      if(typeof p.etaMs === 'number') mcEng.etaMs = p.etaMs;
      if(p.source) mcEng.src = p.source;
      if(p.version) mcEng.ver = p.version;
      if(p.stage) mcEng.stage = p.stage;
    } else if(mcEng.busy === '安装中'){
      // 主进程已经不在装了（比如装完 / 失败 / 被取消），别把「安装中…」永远挂着
      mcEng.busy = '';
    }
  }catch(e){}
}

/* 读保活状态：哪个模型正驻留在显存里。
 * 读不到就算了——这只是给用户看的状态，不该影响任何功能。 */
async function mcSyncKeepStatus(){
  const d = mcDesk();
  if(!d || typeof d.enginesKeepalive !== 'function') return;
  try{
    const st = await d.enginesKeepalive();
    if(!st) return;
    mcKeep.model = String(st.model || '');
    mcKeep.running = !!st.running;
  }catch(e){}
}

function mcPaintEng(){
  const box = $('mcEng');
  if(!box) return;
  const st = mcEngState();
  const desk = !!mcDesk();
  const label = st === 'starting' ? '启动中'
    : (st === 'run' ? '运行中' : (st === 'stopped' ? '已安装 · 未运行' : '未安装'));
  const dotCls = st === 'run' ? 'ok' : (st === 'starting' || st === 'stopped' ? 'wait' : 'off');
  const sub = st === 'starting'
    ? '正在启动引擎，界面照常可用；起来之后可以直接对话'
    : (st === 'run'
        ? 'Ollama 已就绪，可以拉取、卸载本地模型'
        : (st === 'stopped'
            ? '引擎已安装，启动后即可使用；直接点拉取也会自动启动'
            : '首次拉取模型会自动下载并静默安装引擎（约 1.6 GB，支持断点续传）'));
  let btn;
  if(mcEng.busy === '安装中'){
    btn = '<button type="button" class="btn sm" data-mc-eng="cancel">取消下载</button>';
  } else if(mcEng.busy){
    btn = '<button type="button" class="btn sm" disabled>' + mcEsc(mcEng.busy) + '…</button>';
  } else if(!desk){
    btn = '<button type="button" class="btn sm" disabled title="需通过桌面端启动">桌面端可用</button>';
  } else if(st === 'run'){
    btn = '<button type="button" class="btn sm" data-mc-eng="refresh">刷新状态</button>';
  } else if(st === 'stopped'){
    btn = '<button type="button" class="btn sm primary" data-mc-eng="launch">启动引擎</button>';
  } else {
    btn = '<button type="button" class="btn sm primary" data-mc-eng="install">安装引擎</button>';
  }
  let prog = '';
  if(mcEng.progress){
    // pct 由主进程统一算成整条进度（0-100），这里只做显示，绝不二次折算
    const q = mcEng.pct >= 0 ? Math.max(0, Math.min(100, mcEng.pct)) : 0;
    const meta = [];
    const spd = mcFmtSpd(mcEng.speed);
    if(spd) meta.push(spd);
    const eta = mcFmtEta(mcEng.etaMs);
    if(eta) meta.push('剩余 ' + eta);
    const src = mcSrcLabel(mcEng.src);
    if(src) meta.push('源 ' + src);
    if(mcEng.ver) meta.push(mcEng.ver);
    prog = '<div class="mc-eng-progress"><i style="width:' + q + '%"></i><span>' +
      mcEsc(mcEng.progress) + '</span></div>' +
      (meta.length ? '<div class="mc-eng-meta">' +
        meta.map(x => '<span>' + mcEsc(x) + '</span>').join('') + '</div>' : '');
  }
  box.innerHTML =
    '<div class="mc-eng-head">' +
      '<span class="mc-eng-dot ' + dotCls + '"></span>' +
      '<span class="mc-eng-title">本地引擎 · Ollama</span>' +
      '<span class="mc-eng-state">' + label + '</span>' +
      btn +
    '</div>' +
    '<div class="mc-eng-sub">' + mcEsc(sub) + '</div>' +
    ((st !== 'run' && mcEng.autoErr)
      ? '<div class="mc-eng-sub warn">开机自动启动没成功：' + mcEsc(mcEng.autoErr) + '</div>'
      : '') +
    (mcKeep.model
      ? '<div class="mc-eng-sub ok">模型驻留中：' + mcEsc(mcKeep.model) +
        '（常驻显存，不会再冷加载，也就不会再弹黑窗口）</div>'
      : '') +
    (desk ? mcAutoRow([
      ['ollama', '启动时自动启动', '打开软件就绪，不用再点「启动引擎」'],
      ['warm', '预热当前模型', '把对话选中的本地模型提前读进显存并持续保活：第一条消息不用干等四五秒（冷加载实测 4.2 秒，热请求 42 毫秒），而且模型一直驻留就不会再冷加载——那几次一闪而过的黑窗口也就不会再出现；会占用显存（退出软件后最多 30 分钟释放），同时跑 ComfyUI 的机器建议关掉']
    ]) : '') +
    prog;
  box.querySelectorAll('[data-mc-eng]').forEach(b => {
    b.addEventListener('click', () => mcEngAction(b.dataset.mcEng));
  });
  mcBindAutoToggles(box);
}

async function mcEngAction(action){
  try{
    if(action === 'refresh'){
      await rtRefresh();
      await mcDetectEngine(true);
      mcPaintEng();
      mcRenderProviders();
      return;
    }
    if(action === 'cancel'){
      const d = mcDesk();
      if(!d || typeof d.ollamaCancelInstall !== 'function') return;
      mcEng.progress = '正在取消…';
      mcEng.busy = '';
      mcPaintEng();
      await d.ollamaCancelInstall();
      return;
    }
    if(action === 'launch') await mcLaunchEngine();
    if(action === 'install') await mcInstallEngine();
    delete mcModelCache['llm/ollama-llm'];
    mcPaintEng();
    mcRenderProviders();
  }catch(e){
    mcEng.busy = '';
    mcEng.progress = '';
    mcPaintEng();
    alert('操作失败：' + String((e && e.message) || e));
  }
}

async function mcInstallEngine(){
  const d = mcDesk();
  if(!d || typeof d.ollamaInstall !== 'function') throw new Error('需通过桌面端启动才能自动安装 Ollama');
  mcEng.busy = '安装中';
  mcEng.stage = 'download';
  mcEng.progress = '正在查找最新安装包…';
  mcEng.pct = 0;
  mcEng.speed = 0;
  mcEng.etaMs = -1;
  mcEng.src = '';
  mcEng.cancelled = false;
  mcPaintEng();
  let cancelled = false;
  let interrupted = '';
  try{
    const r = await d.ollamaInstall();
    cancelled = !!(r && r.cancelled);
    if(r && r.resumable) interrupted = String(r.message || '下载中断');
  }catch(e){
    // 用户主动取消不是错误，别弹「操作失败」
    if(/取消|cancel/i.test(String((e && e.message) || e))) cancelled = true;
    else throw e;
  }finally{
    mcEng.busy = '';
    mcEng.stage = '';
  }
  if(cancelled){
    mcEng.progress = '已取消下载（进度已保留，再次安装会续传）';
    mcEng.speed = 0;
    mcEng.etaMs = -1;
    mcPaintEng();
    return false;
  }
  if(interrupted){
    // 网络中断但已下的分片都在，再点一次「安装引擎」会从断点继续
    mcEng.progress = '下载中断，进度已保留：' + interrupted;
    mcEng.speed = 0;
    mcEng.etaMs = -1;
    mcPaintEng();
    return false;
  }
  mcEng.progress = '';
  mcEng.speed = 0;
  mcEng.etaMs = -1;
  await rtRefresh();
  await mcDetectEngine(true);
  if(!(rtHealth.ollama && rtHealth.ollama.ok)) await mcLaunchEngine();
  return !!(rtHealth.ollama && rtHealth.ollama.ok);
}

async function mcLaunchEngine(){
  const d = mcDesk();
  if(!d || typeof d.ollamaLaunch !== 'function') throw new Error('需通过桌面端启动才能启动 Ollama');
  mcEng.busy = '启动中';
  mcEng.progress = '正在启动引擎…';
  mcEng.pct = -1;
  mcPaintEng();
  try{
    await d.ollamaLaunch();
  }finally{
    mcEng.busy = '';
  }
  await rtRefresh();
  return !!(rtHealth.ollama && rtHealth.ollama.ok);
}

// 拉取前的引擎兜底：没装就装、装了没跑就启动。返回引擎是否就绪。
async function mcEnsureEngine(){
  if(rtHealth.ollama && rtHealth.ollama.ok) return true;
  if(!mcDesk()) return false;
  await mcDetectEngine(true);
  if(!mcEng.installed){
    if(!confirm('本机还没有 Ollama 引擎。\n现在自动下载并安装吗？（约 1.6 GB，仅需一次）')) return false;
    await mcInstallEngine();
  } else {
    await mcLaunchEngine();
  }
  return !!(rtHealth.ollama && rtHealth.ollama.ok);
}

async function mcListFor(kind, id, btn){
  if(!btn) return;
  let body = btn.parentNode.querySelector('.mc-prov-x');
  if(body){
    body.remove();
    btn.textContent = '模型列表';
    return;
  }
  const p = providerFor(kind, id);
  if(!p || typeof p.listModels !== 'function') return;
  body = document.createElement('div');
  body.className = 'mc-prov-x';
  btn.parentNode.insertBefore(body, btn.nextSibling);
  btn.textContent = '收起';
  await mcRenderBody(body, kind, id);
}

// 渲染展开区内容；Ollama 专属：顶部拉取条 + 带卸载按钮的模型 chips。
async function mcRenderBody(body, kind, id){
  body.innerHTML = '<div class="mc-loading">读取中…</div>';
  let models;
  let errMsg = '';
  if(mcModelCache[kind + '/' + id]){
    models = mcModelCache[kind + '/' + id];
  } else {
    const p = providerFor(kind, id);
    try{
      models = p ? await p.listModels() : [];
      if(!Array.isArray(models)) models = [];
      mcModelCache[kind + '/' + id] = models;
    }catch(e){
      models = null;
      errMsg = String((e && e.message) || e);
    }
  }
  // Ollama 分支先渲染拉取条：引擎没起/没装时列表会读失败，但拉取入口必须始终可用（拉取会自动装引擎）
  if(kind === 'llm' && id === 'ollama-llm'){
    body.innerHTML = '';
    mcRenderOllamaBar(body);
    if(models === null){
      body.insertAdjacentHTML('beforeend',
        '<div class="mc-empty">引擎暂不可用：' + mcEsc(errMsg) + '；输入模型名点拉取会自动安装并启动引擎</div>');
    } else if(!models.length){
      const run = !!(rtHealth.ollama && rtHealth.ollama.ok);
      body.insertAdjacentHTML('beforeend',
        '<div class="mc-empty">' + mcEsc(run ? '还没有模型，可在上方输入模型名拉取' : '还没有模型；输入模型名点拉取，会自动安装并启动引擎') + '</div>');
    } else {
      mcRenderOllamaChips(body, models);
    }
    return;
  }
  /* 本地生图：模型是一个个 .safetensors，得让用户**点选**用哪份。
   * 不给选择时，4 GB 的卡被随机分到 SDXL 会直接爆显存，看起来就像「本地生图不可用」。
   * 放在「读取失败」之前：引擎没起来时通用报错只会甩一串 ECONNREFUSED，
   * 这里能直接告诉用户去上面的「本地生图引擎」点启动。 */
  if(kind === 'image' && id === 'comfy-image'){
    if(models === null){
      body.innerHTML = '<div class="mc-empty">连不上 ComfyUI：' + mcEsc(errMsg) +
        '<br>到上方「本地生图引擎」点「启动引擎」，没装过就点「一键安装」</div>';
      return;
    }
    if(!models.length){
      body.innerHTML = '<div class="mc-empty">ComfyUI 里还没有生图模型：把 .safetensors 放进 ' +
        'ComfyUI/models/checkpoints，然后在「本地生图引擎」里点「重新检测」</div>';
      return;
    }
    const cur = (typeof comfyCkptChoice === 'function') ? comfyCkptChoice() : '';
    body.innerHTML =
      '<div class="mc-empty">点一张作为本地生图用的大模型（当前：' +
        mcEsc(cur && models.some(m => (m.id || m) === cur) ? cur : '自动选 SD1.5') + '）</div>' +
      '<div class="mc-models">' + models.map(m => {
        const name = m.id || m.model || String(m);
        return '<span class="mc-model-chip mc-pick' + (name === cur ? ' on' : '') +
          '" data-mc-ckpt="' + mcEsc(name) + '" title="' + mcEsc(name) + '">' + mcEsc(name) + '</span>';
      }).join('') + '</div>';
    body.querySelectorAll('[data-mc-ckpt]').forEach(el => {
      el.addEventListener('click', () => {
        setComfyCkpt(el.dataset.mcCkpt);
        mcRenderBody(body, kind, id);
      });
    });
    return;
  }
  if(models === null){
    body.innerHTML = '<div class="mc-empty">读取失败：' + mcEsc(errMsg) + '</div>';
    return;
  }
  if(!models.length){
    body.innerHTML = '<div class="mc-empty">没有可用的模型列表（可手动填写模型名）</div>';
    return;
  }
  body.innerHTML =
    '<div class="mc-models">' + models.slice(0, 30).map(m =>
      '<span class="mc-model-chip">' + mcEsc(m.id || m.model || m) + '</span>').join('') +
    (models.length > 30 ? '<span class="mc-empty">…共 ' + models.length + ' 个</span>' : '') +
    '</div>';
}

function mcRenderOllamaBar(body){
  const bar = document.createElement('div');
  bar.className = 'mc-pull';
  bar.innerHTML =
    '<input type="text" class="mc-pull-input" placeholder="模型名，如 qwen2.5:7b">' +
    '<button type="button" class="btn sm" data-mc-pull="1">拉取</button>' +
    '<div class="mc-pull-progress hidden"></div>';
  body.appendChild(bar);
  bar.querySelector('[data-mc-pull]').addEventListener('click', () => mcPullModel(bar, body));
}

function mcRenderOllamaChips(body, models){
  const wrap = document.createElement('div');
  wrap.className = 'mc-models';
  wrap.innerHTML = models.slice(0, 30).map(m => {
    const name = m.id || m.model || String(m);
    const size = m.sizeMB ? ' · ' + m.sizeMB + ' MB' : '';
    return '<span class="mc-model-chip" title="' + mcEsc(name + size) + '">' +
      mcEsc(name) +
      '<button type="button" class="mc-chip-del" data-mc-del="' + mcEsc(name) + '" title="卸载 ' + mcEsc(name) + '">×</button>' +
      '</span>';
  }).join('') +
  (models.length > 30 ? '<span class="mc-empty">…共 ' + models.length + ' 个</span>' : '');
  body.appendChild(wrap);
  wrap.querySelectorAll('[data-mc-del]').forEach(b => {
    b.addEventListener('click', () => mcDeleteModel(b, body));
  });
}

async function mcPullModel(bar, body){
  const input = bar.querySelector('.mc-pull-input');
  const btn = bar.querySelector('[data-mc-pull]');
  const prog = bar.querySelector('.mc-pull-progress');
  const name = input.value.trim();
  if(!name){ input.focus(); return; }
  const p = providerFor('llm', 'ollama-llm');
  if(!p || typeof p.pullModel !== 'function') return;
  btn.disabled = true;
  input.disabled = true;
  prog.classList.remove('hidden');
  const paint = info => {
    const spd = (info && typeof mcFmtSpd === 'function') ? mcFmtSpd(info.speed) : '';
    const eta = (info && typeof mcFmtEta === 'function') ? mcFmtEta(info.etaMs) : '';
    const extra = [spd, eta ? '剩余 ' + eta : ''].filter(Boolean).join(' · ');
    prog.textContent = ((info && info.message) || '') + (extra ? ' · ' + extra : '');
    const pct = Number(info && info.pct);
    if(!isNaN(pct) && pct >= 0){
      const q = Math.min(100, pct);
      prog.style.background = 'linear-gradient(90deg, #2f81f7 ' + q + '%, #eef1f5 ' + q + '%)';
    } else {
      prog.style.background = '';
    }
  };
  paint({ message: '开始拉取…', pct: 0 });
  try{
    if(!(rtHealth.ollama && rtHealth.ollama.ok)){
      paint({ message: '本地引擎未就绪，正在准备（首次会自动安装）…', pct: -1 });
      const ready = await mcEnsureEngine();
      mcPaintEng();
      if(!ready) throw new Error('本地引擎未就绪，请先在「本地引擎」里安装或启动 Ollama');
    }
    await p.pullModel(name, paint);
    delete mcModelCache['llm/ollama-llm'];
    paint({ message: '拉取完成，刷新列表…', pct: -1 });
    await mcRenderBody(body, 'llm', 'ollama-llm');
  }catch(e){
    paint({ message: '拉取失败：' + String((e && e.message) || e), pct: -1 });
  }finally{
    btn.disabled = false;
    input.disabled = false;
  }
}

async function mcDeleteModel(delBtn, body){
  const name = delBtn.dataset.mcDel;
  if(!name) return;
  if(!confirm('卸载模型「' + name + '」？已下载的文件会被删除。')) return;
  const p = providerFor('llm', 'ollama-llm');
  if(!p || typeof p.deleteModel !== 'function') return;
  const orig = delBtn.textContent;
  delBtn.disabled = true;
  delBtn.textContent = '…';
  try{
    await p.deleteModel(name);
    delete mcModelCache['llm/ollama-llm'];
    await mcRenderBody(body, 'llm', 'ollama-llm');
  }catch(e){
    delBtn.textContent = orig;
    delBtn.disabled = false;
    alert('卸载失败：' + String((e && e.message) || e));
  }
}

/* ---- 本地生图引擎 · ComfyUI ----
 * 与 Ollama 的关键差异：ComfyUI 不是一个 exe，而是「一整个带 Python 的目录」。
 * 所以状态里必须显示**找到的目录**和**缺什么**，否则用户只知道「启动失败」，不知道该点哪里。
 * 三种装法（便携版 / venv / 系统 Python）由主进程识别，这里只负责显示。
 */
const mcComfy = {
  checked: false, running: false, installed: false,
  dir: '', mode: '', sevenZip: '', tar: '', canInstall: false, log: '',
  busy: '', progress: '', pct: -1,
  autoErr: ''            // 开机自动启动失败的原因（成功或运行中时清空）
};
const MC_COMFY_MODE = { portable: '便携版', venv: '虚拟环境', system: '系统 Python' };

function mcComfyDesk(){
  const d = mcDesk();
  return (d && typeof d.comfyDetect === 'function') ? d : null;
}

async function mcComfyDetect(){
  const d = mcComfyDesk();
  if(!d) return null;
  try{
    const st = await d.comfyDetect();
    mcComfy.checked = true;
    mcComfy.running = !!(st && st.running);
    mcComfy.installed = !!(st && st.installed);
    mcComfy.dir = (st && st.dir) || '';
    mcComfy.mode = (st && st.layout && st.layout.mode) || '';
    mcComfy.sevenZip = (st && st.sevenZip) || '';
    mcComfy.tar = (st && st.tar) || '';
    mcComfy.canInstall = !!(st && st.canInstall);
    mcComfy.log = (st && st.log) || '';
    return st;
  }catch(e){
    mcComfy.checked = true;
    return null;
  }
}

let mcComfyBound = false;
function mcBindComfyProgress(){
  if(mcComfyBound) return;
  mcComfyBound = true;
  const d = mcComfyDesk();
  if(!d || typeof d.onComfyProgress !== 'function') return;
  d.onComfyProgress(info => {
    if(!info) return;
    if(info.stage === 'download' || info.stage === 'extract'){
      if(!mcComfy.busy) mcComfy.busy = '安装中';
    }
    if(typeof info.pct === 'number') mcComfy.pct = info.pct;
    if(info.message) mcComfy.progress = info.message;
    if(info.stage === 'done' || info.stage === 'error') mcComfy.busy = '';
    mcPaintComfy();
  });
}

function mcPaintComfy(){
  const box = $('mcComfy');
  if(!box) return;
  const desk = !!mcComfyDesk();
  const running = mcComfy.running;
  const installed = mcComfy.installed;
  const modeText = MC_COMFY_MODE[mcComfy.mode] || '';
  /* 同理：自动启动中就以「启动中」为准，别让徽标继续显示上一次的结论 */
  const autoStarting = mcComfy.busy === '启动中';

  const label = autoStarting ? '启动中' : (running ? '运行中' : (installed ? '已找到 · 未运行' : '未安装'));
  const dotCls = running && !autoStarting ? 'ok' : ((autoStarting || installed) ? 'wait' : 'off');
  let sub;
  if(autoStarting){
    sub = '正在启动 ComfyUI，界面照常可用；首次加载 torch 约 100 秒';
  } else if(running){
    sub = 'ComfyUI 已就绪：生图切到「本地生成」后走本机显卡计算';
  } else if(installed){
    sub = '已找到：' + mcComfy.dir + (modeText ? '（' + modeText + '）' : '') + '，启动后即可本地生图';
  } else if(!desk){
    sub = '需通过桌面端启动才能自动安装 / 启动 ComfyUI';
  } else {
    sub = '没找到 ComfyUI。一键安装会自动下载便携版（约 2 GB）、用系统自带 tar 解压、装完自动启动';
  }

  const btns = [];
  if(!desk){
    btns.push('<button type="button" class="btn sm" disabled>桌面端可用</button>');
  } else if(mcComfy.busy){
    btns.push('<button type="button" class="btn sm" disabled>' + mcEsc(mcComfy.busy) + '…</button>');
  } else if(running){
    btns.push('<button type="button" class="btn sm" data-mc-comfy="refresh">刷新状态</button>');
    btns.push('<button type="button" class="btn sm" data-mc-comfy="stop">停止</button>');
  } else if(installed){
    btns.push('<button type="button" class="btn sm primary" data-mc-comfy="launch">启动引擎</button>');
    btns.push('<button type="button" class="btn sm" data-mc-comfy="pick">换目录</button>');
  } else {
    btns.push('<button type="button" class="btn sm primary" data-mc-comfy="install">一键安装</button>');
    btns.push('<button type="button" class="btn sm" data-mc-comfy="pick">选择目录</button>');
  }

  /* 引导到独立 app：安装 / 启动 / 日志 / 打开网页界面都在那边。
   * 控制台里这一小块只做「一眼看状态 + 快捷启动」，不重复实现整套流程。 */
  if(desk) btns.push('<button type="button" class="btn sm" data-mc-comfy="app" title="安装、启动、日志、打开网页界面都在独立的「本地生图」窗口里">完整窗口</button>');

  let prog = '';
  if(mcComfy.progress){
    const q = mcComfy.pct >= 0 ? Math.max(0, Math.min(100, mcComfy.pct)) : 0;
    prog = '<div class="mc-eng-progress"><i style="width:' + q + '%"></i><span>' + mcEsc(mcComfy.progress) + '</span></div>';
  }
  // 启动失败时把日志尾巴露出来：ComfyUI 起不来的原因（缺 torch / CUDA 不对 / 路径有空格）都在里面
  const logBox = (!running && mcComfy.log)
    ? '<pre class="mc-eng-log">' + mcEsc(mcComfy.log) + '</pre>'
    : '';
  const zipHint = (!running && !installed && desk && !mcComfy.canInstall)
    ? '<div class="mc-eng-sub warn">没有可用的解压工具（系统 tar / 7-Zip 都没有）：一键安装会失败</div>'
    : '';

  box.innerHTML =
    '<div class="mc-eng-head">' +
      '<span class="mc-eng-dot ' + dotCls + '"></span>' +
      '<span class="mc-eng-title">本地生图引擎 · ComfyUI</span>' +
      '<span class="mc-eng-state">' + label + '</span>' +
      btns.join('') +
    '</div>' +
    '<div class="mc-eng-sub">' + mcEsc(sub) + '</div>' +
    ((!running && mcComfy.autoErr)
      ? '<div class="mc-eng-sub warn">开机自动启动没成功：' + mcEsc(mcComfy.autoErr) + '</div>'
      : '') +
    (desk ? mcAutoRow([['comfy', '启动时自动启动', '打开软件后自动起 ComfyUI（首次要加载 torch，约 100 秒，期间界面照常可用）']]) : '') +
    zipHint + prog + logBox;
  box.querySelectorAll('[data-mc-comfy]').forEach(b => {
    b.addEventListener('click', () => mcComfyAction(b.dataset.mcComfy));
  });
  mcBindAutoToggles(box);
}

async function mcComfyAction(action, opts){
  const o = opts || {};
  const d = mcComfyDesk();
  if(!d) return;
  try{
    if(action === 'refresh'){
      await rtRefresh();
      await mcComfyDetect();
      return;
    }
    if(action === 'app'){
      if(typeof openComfyApp === 'function') openComfyApp();
      return;
    }
    if(action === 'pick'){
      const r = await d.comfyPickDir();
      if(r && r.ok){
        await mcComfyDetect();
        if(typeof bpToast === 'function') bpToast('已指定 ComfyUI 目录');
      } else if(r && r.message){
        alert(r.message);
      }
      return;
    }
    if(action === 'launch'){
      mcComfy.busy = '启动中';
      mcComfy.progress = '正在启动 ComfyUI（首次加载要几十秒，别关窗口）…';
      mcComfy.pct = -1;
      mcPaintComfy();
      let r = null;
      try{ r = await d.comfyLaunch({}); }
      finally{ mcComfy.busy = ''; mcComfy.progress = ''; }
      await rtRefresh();
      await mcComfyDetect();
      if(r && r.ok){
        if(typeof bpToast === 'function') bpToast('ComfyUI 已启动');
      } else {
        alert('启动失败：' + ((r && r.message) || '未知原因'));
      }
      return;
    }
    if(action === 'stop'){
      mcComfy.busy = '停止中';
      mcPaintComfy();
      try{ await d.comfyStop(); }
      finally{ mcComfy.busy = ''; }
      // python 进程退出要点时间，稍等一下再探，否则会显示成还在跑
      await new Promise(r => setTimeout(r, 1500));
      await rtRefresh();
      await mcComfyDetect();
      return;
    }
    if(action === 'install'){
      /* 不再二次确认：这是一次「一键安装」，体积和解压过程都写在按钮旁边的说明里了，
       * 下载中也给了取消入口。再弹一个 confirm 只是把「点一下就好」变成「点两下」。
       * （这里的 o.confirmed 仍保留，商店流程会显式传，语义不变。） */
      mcComfy.busy = '安装中';
      mcComfy.progress = '正在准备下载…';
      mcComfy.pct = 0;
      mcPaintComfy();
      let r = null;
      try{ r = await d.comfyInstall(); }
      finally{ mcComfy.busy = ''; mcComfy.progress = ''; }
      await mcComfyDetect();
      if(r && r.ok){
        if(typeof bpToast === 'function') bpToast('ComfyUI 已安装，正在启动');
        await mcComfyAction('launch');
      } else {
        alert('安装失败：' + ((r && r.message) || '未知原因'));
      }
      return;
    }
  }catch(e){
    mcComfy.busy = '';
    mcComfy.progress = '';
    alert('操作失败：' + String((e && e.message) || e));
  }finally{
    mcPaintComfy();
    mcRenderProviders();
  }
}

/* ---- 来源选项卡：语言模型（本地/云端）、生图（本地/在线） ----
 * 生图那份和 provider.js 的 imgMode() 读写**同一个键** mc_scope_image：
 * 两处各存一份必然打架——切了选项卡、生图还走原来那侧，是最难查的那类 bug。 */
const MC_SCOPE_KEY = { llm: 'mc_llm_scope', image: 'mc_scope_image' };
const MC_SCOPE_TABS = {
  llm: [['local', '本地模型'], ['cloud', '云端模型']],
  image: [['local', '本地生成'], ['online', '在线接口']]
};
const MC_SCOPE_EMPTY = {
  llm: {
    local: '暂无本地语言模型（在上方「本地引擎」安装 Ollama 后可用）',
    cloud: '暂无云端语言模型（在设置 → 语言模型 里填入接口后可用）'
  },
  image: {
    local: '暂无本地生图引擎（在上方「本地生图引擎」里安装或启动 ComfyUI）',
    online: '暂无在线生图接口（在设置 → 图像模型 里填入接口，或配置 Tripo）'
  }
};
const mcScopeCache = {};

function mcScopeOf(kind){
  return (MC_SCOPE_TABS[kind] || []).map(t => t[0]);
}
function mcScopeDefault(kind){
  const localReady = providersOfKind(kind).some(p => p.local && p.status());
  return localReady ? 'local' : (kind === 'image' ? 'online' : 'cloud');
}
function mcGetScope(kind){
  if(mcScopeCache[kind]) return mcScopeCache[kind];
  let saved = '';
  try{ saved = localStorage.getItem(MC_SCOPE_KEY[kind]) || ''; }catch(e){}
  mcScopeCache[kind] = mcScopeOf(kind).indexOf(saved) !== -1 ? saved : mcScopeDefault(kind);
  return mcScopeCache[kind];
}
function mcSetScope(kind, scope){
  const valid = mcScopeOf(kind);
  if(valid.indexOf(scope) === -1) scope = mcScopeDefault(kind);
  mcScopeCache[kind] = scope;
  try{ localStorage.setItem(MC_SCOPE_KEY[kind], scope); }catch(e){}
}

function mcRenderProviders(){
  const wrap = $('mcKinds');
  if(!wrap) return;
  wrap.innerHTML = '';
  PROVIDER_KINDS.forEach(kind => {
    const all = providersOfKind(kind);
    const tabs = MC_SCOPE_TABS[kind] || null;
    const scope = tabs ? mcGetScope(kind) : null;
    const list = tabs ? all.filter(p => (scope === 'local') === !!p.local) : all;
    const sec = document.createElement('section');
    sec.className = 'mc-sec';
    let rows = '';
    if(!list.length){
      const byKind = MC_SCOPE_EMPTY[kind] || {};
      const emptyText = (tabs && byKind[scope]) || ('暂无 ' + (MC_KIND_LABEL[kind] || kind) + ' 提供方');
      rows = '<div class="mc-empty">' + mcEsc(emptyText) + '</div>';
    } else {
      rows = list.map(p => {
        let ok = false;
        try{ ok = !!p.status(); }catch(e){ ok = false; }
        const dotCls = ok ? 'ok' : 'off';
        const dotTitle = ok ? '就绪' : '未就绪';
        return '<div class="mc-prov">' +
          '<span class="mc-prov-icon">' + deskSvg(MC_GLYPH_OF[kind] || 'model') + '</span>' +
          '<span class="mc-prov-main">' +
            '<span class="mc-prov-name">' + mcEsc(p.label) + '</span>' +
            '<span class="mc-prov-id">' + mcEsc(p.id) + '</span>' +
          '</span>' +
          '<span class="mc-prov-dot ' + dotCls + '" title="' + dotTitle + '"></span>' +
          '<button type="button" class="btn sm" data-mc-list="' + kind + '/' + mcEsc(p.id) + '">模型列表</button>' +
        '</div>';
      }).join('');
    }
    const tabHtml = tabs
      ? '<div class="mc-tabs" role="tablist" aria-label="' + mcEsc(MC_KIND_LABEL[kind] || kind) + '来源">' +
          tabs.map(([val, label]) =>
            '<button type="button" class="mc-tab' + (scope === val ? ' active' : '') + '" role="tab"' +
              ' aria-selected="' + (scope === val) + '" data-mc-scope="' + kind + '/' + val + '">' +
              mcEsc(label) + '</button>').join('') +
        '</div>'
      : '';
    sec.innerHTML =
      '<div class="mc-sec-head">' +
        '<span class="mc-sec-name">' + mcEsc(MC_KIND_LABEL[kind] || kind) + '</span>' +
        '<span class="mc-sec-count">' + list.length + '</span>' +
      '</div>' +
      tabHtml +
      '<div class="mc-sec-body">' + rows + '</div>';
    wrap.appendChild(sec);
  });
  wrap.querySelectorAll('[data-mc-list]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [kind, id] = btn.dataset.mcList.split('/');
      mcListFor(kind, id, btn);
    });
  });
  wrap.querySelectorAll('[data-mc-scope]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [kind, scope] = btn.dataset.mcScope.split('/');
      mcSetScope(kind, scope);
      /* 生图切到本地时顺手把面板里的 ComfyUI 状态刷新一遍：用户切过来就是想看它能不能用 */
      if(kind === 'image' && scope === 'local'){
        try{ rtRefresh().then(() => { mcPaintEng(); mcPaintComfy(); mcRenderProviders(); }); }catch(e){}
      }
      mcRenderProviders();
      /* 通知对话那边：生图来源/模型变了，页头的「生图 · xxx」标签和输入条上的
       * 生图模型下拉都要跟着换。不通知的话，用户在这个面板切了本地，
       * 对话里还显示着「在线 · seedream」，两边对不上。 */
      if(kind === 'image'){
        try{ window.dispatchEvent(new CustomEvent('hf-img-source-changed')); }catch(e){}
      }
    });
  });
}

async function renderModelsConsole(){
  await mcProbeAll(false);
  try{ if(typeof rtRefresh === 'function') await rtRefresh(); }catch(e){}
  mcBindEngProgress();
  mcBindComfyProgress();
  mcBindEngineStatus();
  await mcLoadEngAuto();
  await mcDetectEngine(true);
  await mcSyncEngStatus();
  await mcSyncKeepStatus();
  await mcComfyDetect();
  mcPaintEng();
  mcPaintComfy();
  /* 自动启动可能在我们打开面板之前就已经跑过一轮了：进来先对一次表，
   * 否则明明已经在启动（或已经起来了），卡片还停在「未运行」上。 */
  try{
    if(window.engineAuto && typeof window.engineAuto.status === 'function'){
      await mcApplyEngineStatus(window.engineAuto.status());
    }
  }catch(e){}
  /* 商店不在这个窗口里了（它自己是工作台上的一个 app），这里只负责引擎与 Provider 列表。
   * 装模型请走「模型商店」。 */
  mcRenderProviders();
}