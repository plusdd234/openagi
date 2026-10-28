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
 * 而识图模型混在对话列表里时，他只能靠名字里有没有 vl/vision 去猜。 */
const MS_FILTERS = [['all', '全部'], ['llm', '对话'], ['vision', '看图'], ['image', '生图']];

const msState = {
  filter: 'all',
  fitOnly: false,
  hw: null,
  ready: false,
  /* installed.llm 为 null 表示「还不知道」（引擎没跑），不能当成「没装」 */
  installed: { llm: null, image: null },
  progress: {},        // id -> { pct, msg, speed, etaMs, busy }
  error: {},           // id -> 文案
  notes: {}            // id -> 完成后的提示（如「下载中断，进度已保留」）
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

/* ---------- 已安装清单 ---------- */
async function msRefreshInstalled(){
  // 生图：直接读磁盘，引擎没启动也能判断
  const d = msDesk();
  if(d && typeof d.storeImageList === 'function'){
    try{
      const r = await d.storeImageList();
      if(r && r.ok) msState.installed.image = (r.files || []).map(f => f.file);
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
  if(item.engine === 'comfyui'){
    return Array.isArray(msState.installed.image) && msState.installed.image.indexOf(item.file) !== -1;
  }
  return Array.isArray(msState.installed.llm) && msState.installed.llm.indexOf(item.ollama) !== -1;
}

/* ---------- 当前启用的是哪个 ---------- */
function msIsActive(item){
  if(item.engine === 'ollama'){
    const base = ($('llmBaseUrl') && $('llmBaseUrl').value || '').trim().replace(/\/$/, '');
    const model = ($('llmModel') && $('llmModel').value || '').trim();
    const mode = (typeof llmMode === 'function') ? llmMode() : 'cloud';
    return mode === 'local' && model === item.ollama && /\/ollama\/v1$/i.test(base);
  }
  const mode = (typeof imgMode === 'function') ? imgMode() : 'online';
  const ckpt = (typeof comfyCkptChoice === 'function') ? comfyCkptChoice() : '';
  return mode === 'local' && ckpt === item.file;
}

/* ---------- 启用（配置）：写真正执行链路要读的那些键 ---------- */
function msEnable(item){
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

async function msInstall(item, btn){
  if(msProg(item.id) && msProg(item.id).busy) return;
  delete msState.error[item.id];
  delete msState.notes[item.id];
  if(btn) btn.disabled = true;
  let ok = false;
  try{
    if(item.engine === 'ollama') await msInstallLlm(item);
    else ok = await msInstallImage(item);
    if(item.engine === 'ollama') ok = true;
  }catch(e){
    const msg = String((e && e.message) || e);
    // 可续传的中断不是失败：已下的分片都在，再点一次会接着下
    if(e && (e.resumable || e.cancelled)) msState.notes[item.id] = msg;
    else msState.error[item.id] = msg;
  }finally{
    delete msState.progress[item.id];
  }
  if(!ok && !msState.notes[item.id]){ msPaintStore(); return; }
  // 装完即启用：这就是「一键式」的关键一步，用户不用再去设置页填配置
  if(ok && msIsInstalled(item)){
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
  try{ await d.storeCancel(item.id); }catch(e){}
}

/* 卸载后必须处理「配置还指着它」。
 * 用户点卸载的往往正是当前启用的那个模型，配置不清掉，下一次对话直接
 * model not found —— 看起来像是刚卸载就坏了。有别的本地模型就自动切过去，
 * 一个都不剩就退回云端，别把人锁在一个跑不动的配置上。 */
function msDetachIfActive(item){
  if(item.engine === 'ollama'){
    const cur = ($('llmModel') && $('llmModel').value || '').trim();
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
function msCard(item){
  const fit = msFit(item);
  const prog = msProg(item.id);
  const err = msState.error[item.id];
  const note = msState.notes[item.id];
  const installed = msIsInstalled(item);
  const active = msIsActive(item);

  const tags = (item.tags || []).map(t => '<span class="ms-tag">' + msEsc(t) + '</span>').join('');
  const fitCls = fit.level === 'good' ? 'ok' : (fit.level === 'cpu' ? 'warn' : (fit.level === 'no' ? 'bad' : 'mute'));

  let action = '';
  if(prog && prog.busy){
    /* 生图模型动辄 2-7 GB，必须有取消入口；语言模型走 Ollama 的 /api/pull，
     * 客户端这边没有中止能力（中断反而会丢掉已下好的层），所以只显示状态。 */
    action = (item.engine === 'comfyui')
      ? '<button type="button" class="btn sm" data-ms-act="cancel" data-ms-id="' + msEsc(item.id) + '">取消下载</button>'
      : '<button type="button" class="btn sm" disabled>' +
          (prog.pct > 0 ? '下载中 ' + Math.round(prog.pct) + '%' : '下载中…') + '</button>';
  } else if(active){
    action = '<span class="ms-on">已启用</span>' +
      '<button type="button" class="btn sm" data-ms-act="remove" data-ms-id="' + msEsc(item.id) + '">卸载</button>';
  } else if(installed){
    action = '<button type="button" class="btn sm primary" data-ms-act="enable" data-ms-id="' +
      msEsc(item.id) + '">启用</button>' +
      '<button type="button" class="btn sm" data-ms-act="remove" data-ms-id="' + msEsc(item.id) + '">卸载</button>';
  } else {
    action = '<button type="button" class="btn sm primary" data-ms-act="install" data-ms-id="' +
      msEsc(item.id) + '">安装</button>';
  }

  let progHtml = '';
  if(prog && (prog.busy || prog.msg)){
    /* pct < 0 表示引擎还没报出总大小（刚发 pull、正在读清单）。
     * 这时候不能画一根 0% 的空条——用户看到的是「一条灰杠，永远不动」，
     * 会以为点了没反应。改走不确定态：斜纹来回跑，表达「在动，但还不知道到哪」。 */
    const indet = !(prog.pct >= 0) && !!prog.busy;
    const q = indet ? 0 : Math.max(0, Math.min(100, prog.pct));
    const meta = [];
    const spd = (typeof mcFmtSpd === 'function') ? mcFmtSpd(prog.speed) : '';
    if(spd) meta.push(spd);
    const eta = (typeof mcFmtEta === 'function') ? mcFmtEta(prog.etaMs) : '';
    if(eta) meta.push('剩余 ' + eta);
    progHtml = '<div class="ms-prog' + (indet ? ' indet' : '') + '"><i' +
        (indet ? '' : ' style="width:' + q + '%"') + '></i></div>' +
      '<div class="ms-prog-txt">' + msEsc(prog.msg || '下载中…') +
        (meta.length ? ' · ' + msEsc(meta.join(' · ')) : '') + '</div>';
  }

  return '<div class="ms-card' + (active ? ' on' : '') + '">' +
    '<div class="ms-top">' +
      '<span class="ms-name" title="' + msEsc(item.name) + '">' + msEsc(item.name) + '</span>' +
      '<span class="ms-size">' + msFmtGB(item.sizeGB) + '</span>' +
    '</div>' +
    '<div class="ms-meta">' + msEsc(item.params || '') +
      (item.params ? ' · ' : '') + msEsc(item.org || '') +
      ' · 需约 ' + item.vramGB + ' GB 显存</div>' +
    /* 生图模型把权重文件名写出来：ComfyUI 是按文件名认模型的，
     * 用户在自己的目录里核对、或改 ckpt 时需要这个名字 */
    (item.file ? '<div class="ms-file">' + msEsc(item.file) + '</div>' : '') +
    '<div class="ms-desc">' + msEsc(item.desc || '') + '</div>' +
    (tags ? '<div class="ms-tags">' + tags + '</div>' : '') +
    '<div class="ms-fit ' + fitCls + '">' + msEsc(fit.note || '') + '</div>' +
    (progHtml || '') +
    (err ? '<div class="ms-err">' + msEsc(err) + '</div>' : '') +
    (note ? '<div class="ms-note">' + msEsc(note) + '</div>' : '') +
    '<div class="ms-foot">' + action + '</div>' +
  '</div>';
}

function msSection(kind, label){
  const items = catalogOf(kind).filter(m => !msState.fitOnly || msFit(m).level !== 'no');
  if(!items.length) return '';
  return '<div class="ms-sec">' +
    '<div class="ms-sec-head"><span>' + msEsc(label) + '</span>' +
      '<span class="ms-sec-n">' + items.length + '</span></div>' +
    '<div class="ms-grid">' + items.map(msCard).join('') + '</div>' +
  '</div>';
}

function msEngineHint(){
  const ollamaOk = !!(rtHealth && rtHealth.ollama && rtHealth.ollama.ok);
  const parts = [];
  if(!ollamaOk){
    parts.push('<span class="ms-hint-item">Ollama 未运行：装对话模型时会自动安装并启动</span>');
  }
  /* ComfyUI 的那句挪到 msImageEngineHint 了：那里能说清「会连带下 2 GB」，
   * 而这条是全局的、两句话高度重复，叠在一起只会让顶部变成一堆黄条。 */
  return parts.length ? '<div class="ms-hint">' + parts.join('') + '</div>' : '';
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

function msPaintStore(){
  const box = $('mcStore');
  if(!box) return;
  const showLlm = msState.filter === 'all' || msState.filter === 'llm';
  const showVis = msState.filter === 'all' || msState.filter === 'vision';
  const showImg = msState.filter === 'all' || msState.filter === 'image';
  const chips = MS_FILTERS.map(([v, label]) =>
    '<button type="button" class="ms-chip' + (msState.filter === v ? ' on' : '') +
      '" data-ms-filter="' + v + '">' + msEsc(label) + '</button>').join('');

  box.innerHTML =
    '<div class="ms-head">' +
      '<span class="ms-title">模型商店</span>' +
      '<span class="ms-sub">点「安装」自动下载并放到本机，装完直接启用</span>' +
    '</div>' +
    '<div class="ms-bar">' +
      '<div class="ms-filters">' + chips + '</div>' +
      '<label class="ms-toggle"><input type="checkbox" data-ms-fit' + (msState.fitOnly ? ' checked' : '') +
        '> 只看跑得动的</label>' +
    '</div>' +
    msEngineHint() +
    msGuessHint() +
    (showLlm ? msSection('llm', '对话模型（Ollama 本地推理）') : '') +
    /* 装了识图模型却不知道在哪用，是这类功能最常见的「装了没用」投诉。
     * 用「AI 任务」节点是唯一真正会把图片以 image_url 发出去的地方。 */
    (showVis ? '<div class="ms-tip">识图模型用在流程的「AI 任务」节点——把图片接到该节点的图片输入，问题写在提示词里即可。' +
      '「设置 → 分析接口」的连通性测试也会顺带带上参考图。</div>' : '') +
    (showVis ? msSection('vision', '识图 / 多模态（能读图片、截图、表格）') : '') +
    /* 生图模型必须落在 ComfyUI 的 checkpoints 里。本机没引擎时点「安装」会连带
     * 下 2 GB 的引擎，事先不说清就是「我明明只点了一个 2 GB 的模型」这种投诉。 */
    (showImg ? msImageEngineHint() : '') +
    (showImg ? msSection('image', '生图模型（ComfyUI 本地推理）') : '');

  box.querySelectorAll('[data-ms-filter]').forEach(b => {
    b.addEventListener('click', () => { msState.filter = b.dataset.msFilter; msPaintStore(); });
  });
  const fitBox = box.querySelector('[data-ms-fit]');
  if(fitBox) fitBox.addEventListener('change', () => { msState.fitOnly = !!fitBox.checked; msPaintStore(); });
  box.querySelectorAll('[data-ms-act]').forEach(b => {
    b.addEventListener('click', () => {
      const item = catalogGet(b.dataset.msId);
      if(!item) return;
      if(b.dataset.msAct === 'install') msInstall(item, b);
      else if(b.dataset.msAct === 'cancel') msCancel(item);
      else if(b.dataset.msAct === 'enable'){
        msEnable(item);
        if(typeof bpToast === 'function') bpToast('已启用：' + item.name);
        msPaintStore();
        if(typeof mcRenderProviders === 'function') mcRenderProviders();
      } else if(b.dataset.msAct === 'remove') msRemove(item);
    });
  });
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
  /* 统一走 App 页翻页（deskMountApp 定义在 desktop.js）；拿不到时退回弹窗 */
  if(typeof deskMountApp === 'function') deskMountApp(win, '模型商店', '安装 / 删除本地模型');
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
