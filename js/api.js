/* Tripo 网页账号 / 通用 fetch / Tripo v3 / 模型列表 / 连通性测试
 * 原 index.html 1779-2432 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
// ---- Tripo 网页账号（本地助手） ----
async function tripoWebFetch(pathname, opts, timeoutMs){
  const ms = timeoutMs || 8000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try{
    const res = await fetch(TRIPO_WEB_BASE + pathname, Object.assign({ signal: ctrl.signal }, opts || {}));
    let data = null;
    try { data = await res.json(); } catch(e) {}
    if(!res.ok) throw new Error(pickErrMsg(data, 0) || ('HTTP ' + res.status));
    return data || {};
  }catch(e){
    if(e && e.name === 'AbortError') throw new Error('本地助手无响应（' + Math.round(ms / 1000) + ' 秒超时）');
    if(e instanceof TypeError) throw new Error('无法连接 Tripo 助手：请先启动项目（桌面端双击 start.bat），再点「打开登录页」');
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

let _tripoProbeAt = 0;
async function refreshTripoWebStatus(silent){
  /* 静默探测 30 秒节流：isTripoWeb() 以连接状态为准后，开机/切页/状态胶囊
     都会来探一次，桥不在时每次都是 6 秒超时 × N 次调用太浪费。
     手动点「检测状态」传 silent=false，永远实时。 */
  const now = Date.now();
  if(silent && now - _tripoProbeAt < 30000) return tripoWebReady;
  _tripoProbeAt = now;
  const el = $('tripoWebState');
  if(!silent) el.textContent = '检测中…';
  try{
    const d = await tripoWebFetch('/status', {}, 6000);
    tripoWebReady = !!d.ready;
    if(!d.running) el.textContent = '助手已启动 · 浏览器未打开';
    else if(d.ready) el.textContent = '已连接 · ' + (d.title || '生图页就绪');
    else el.textContent = '浏览器已打开 · 请登录并进入生图页';
  }catch(e){
    tripoWebReady = false;
    el.textContent = '助手未启动';
  }
  updateStatusChips();
  if(typeof refreshDeskStates === 'function') refreshDeskStates();
  return tripoWebReady;
}

async function tripoWebLogin(){
  const el = $('tripoWebState');
  el.textContent = '正在打开浏览器…';
  try{
    await tripoWebFetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: $('tripoWebUrl').value })
    }, 20000);
    el.textContent = '浏览器已打开 · 等待登录并进入生图页…';
    for(let i = 0; i < 30; i++){
      await new Promise(r => setTimeout(r, 3000));
      const d = await tripoWebFetch('/status', {}, 6000);
      if(d.ready){
        tripoWebReady = true;
        el.textContent = '已连接 · ' + (d.title || '生图页就绪');
        updateStatusChips();
        if(typeof refreshDeskStates === 'function') refreshDeskStates();
        return;
      }
    }
    tripoWebReady = false;
    el.textContent = '已打开浏览器 · 登录后点「检测状态」';
    updateStatusChips();
  }catch(e){
    tripoWebReady = false;
    el.textContent = e.message;
    updateStatusChips();
  }
}

$('btnTripoWebLogin').addEventListener('click', tripoWebLogin);
$('btnTripoWebCheck').addEventListener('click', () => refreshTripoWebStatus(false));

function clearKeys(){
  ['llmKey','imgKey','tripoKey'].forEach(id => { $(id).value = ''; localStorage.removeItem('hf_'+id); });
  updateStatusChips();
  setStatus('API Key 已清空');
}

// 折叠选择器上显示当前模型
function updateModelLabels(){
  [['llmModel','llmModelLabel'], ['imgModel','imgModelLabel']].forEach(([inputId, labelId]) => {
    const v = $(inputId).value.trim();
    const el = $(labelId);
    el.textContent = v || '未选择';
    el.classList.toggle('empty', !v);
  });
  updateStatusChips();
}

// 顶栏显示三类模型的配置状态
const TRIPO_TIER = { 'v3.1-20260211': 'H3.1', 'v3.0-20250812': 'H3.0', 'v2.5-20250123': 'H2.5' };

/* ⚠ 元素可能不存在：语言 / 图像 / 3D 三个胶囊已从顶栏撤掉（和输入条的模型选择器重复），
 * 但 updateStatusChips 仍在算这三个状态——它带副作用（本地引擎没跑时去刷引擎状态），
 * 不能因为「没人看」就把整段删掉。所以这里找不到元素就静默跳过。 */
function setChip(id, ok, text, tip){
  const el = $(id);
  if(!el) return;
  el.classList.toggle('off', !ok);
  const v = el.querySelector('.sc-value');
  if(v) v.textContent = text;
  el.title = tip;
}

function updateStatusChips(){
  const key = $('llmKey').value.trim();
  const base = $('llmBaseUrl').value.trim();
  const llm = $('llmModel').value.trim();
  const llmOk = !!(key && base && llm);
  /* 语言 chip 必须区分本地/云端：两种来源出问题时排查方向完全不同
   * （本地看 Ollama / 引擎，云端看 Key / 网络）。只给一个模型名等于什么都没说。 */
  const llmLocal = (typeof llmMode === 'function') && llmMode() === 'local';
  setChip('stLLM', llmOk, (llmLocal ? '本地 · ' : '云端 · ') + (llm || '未配置'),
    llmOk
      ? `语言模型：${llm} · ${llmLocal ? '本地推理（Ollama）' : (activePreset || base)}`
      : '未配置：需要 API Key、接口地址与模型');

  /* 图像 chip 按真实来源分两种说法：
   *   本地生成 → 显示引擎状态（引擎没跑而出图必然失败，这是最常见的坑）
   *   云端 → 接口与模型
   * Tripo 不再参与通用生图（2026-10-29 解耦），网页生图只存在于专门的
   * tripoImg 节点上，由「网页操作」页的连接状态管理，不占这里的 chip。 */
  const webReady = isTripoWeb();
  if((typeof imgMode === 'function') && imgMode() === 'local'){
    const c = (typeof mcComfy !== 'undefined' && mcComfy && mcComfy.checked) ? mcComfy : null;
    const running = !!(c && c.running);
    const ckpt = (typeof comfyCkptChoice === 'function') ? comfyCkptChoice() : '';
    setChip('stIMG', running, running ? '本地生成' : '引擎未启动',
      running
        ? `图像：本地生成 · ComfyUI 运行中${ckpt ? ' · ' + ckpt : ''}`
        : '图像已切到本地生成，但 ComfyUI 没在跑——打开「本地生图」启动引擎，否则出图会失败');
    if(!running) refreshStatusEngine();
  } else {
    const imgModel = $('imgModel').value.trim() || llm;
    const imgBase = $('imgBaseUrl').value.trim() || base;
    const imgKey = $('imgKey').value.trim() || key;
    const imgOk = !!(imgKey && imgModel && imgBase);
    const imgSource = activeImgPreset === IMG_FOLLOW ? '复用分析接口' : activeImgPreset;
    setChip('stIMG', imgOk, '云端 · ' + (imgModel || '未配置'),
      imgOk ? `图像模型：${imgModel} · ${imgSource}` : '未配置：需要接口 Key 与图像模型');
  }

  /* 3D chip：网页助手连接优先，API Key 兜底（与「3D 生成」节点的取用顺序一致） */
  const tKey = $('tripoKey').value.trim();
  const tKeyOk = !!tKey && !tripoKeyLooksWrong(tKey);
  const tier = TRIPO_TIER[$('tripoVersion').value] || 'H3.1';
  if(webReady){
    setChip('st3D', true, 'Tripo 网页助手', `3D 模型：网页账号已连接（版本 ${tier}）· 未连接时自动改走 API Key`);
  } else if(tKeyOk){
    setChip('st3D', true, 'Tripo API · ' + tier, `3D 模型：Tripo API · ${tier} · 网页助手未连接，可在 设置 → 网页操作 登录`);
  } else {
    setChip('st3D', false, '未启用', '3D 模型：在 设置 → 网页操作 里登录 Tripo，或填入 platform.tripo3d.ai 生成的 API Key（不是账号密码）');
  }

  refreshAssetChip();
}

/* 资产 chip：图库 + 模型库的总占用。
 * 异步取（读磁盘统计），所以从 updateStatusChips 里拆出来，
 * 只在拿得到数据时更新——取不到就保持上次的值，别闪成「—」。 */
let _assetChipBusy = false;
let _assetChipAt = 0;
async function refreshAssetChip(force){
  const now = Date.now();
  if(!force && (_assetChipBusy || now - _assetChipAt < 30000)) return;   // 30 秒内不重复扫盘
  const d = window.openagiDesktop;
  const el = $('stASSET');
  if(!el) return;
  if(!d || typeof d.assetStat !== 'function'){
    setChip('stASSET', false, '桌面版', '资产要落到本机磁盘上，网页版没有这个能力');
    return;
  }
  _assetChipBusy = true;
  try{
    const s = await d.assetStat();
    _assetChipAt = Date.now();
    const total = (s && s.totalBytes) || 0;
    const n = (s && s.count) || 0;
    const trash = (s && s.trashBytes) || 0;
    if(typeof libFmt === 'function'){
      setChip('stASSET', true, libFmt(total),
        `图库 + 模型库共 ${libFmt(total)}（${n} 个资产）` +
        (trash ? `\n回收站还占 ${libFmt(trash)}，可在设置 → 资产库清空` : '') +
        '\n点开管理（图库 / 模型库）');
    }
  }catch(e){ /* 统计失败就保持原样，别让顶部状态栏闪红 */ }
  finally{ _assetChipBusy = false; }
}

/* 引擎状态是异步探测的：探测完把图像 chip 重画一次。
 * 只在「本地生成」模式下才值得探测，别给云端用户白扫一遍。 */
let _engineProbeAt = 0;
function refreshStatusEngine(){
  const now = Date.now();
  if(now - _engineProbeAt < 60000) return;   // 一分钟内探测过就不再扫
  _engineProbeAt = now;
  if(typeof mcComfyDetect !== 'function') return;
  mcComfyDetect().then(() => {
    if((typeof imgMode === 'function') && imgMode() === 'local') updateStatusChips();
  }).catch(() => {});
}

// 网页操作页每次展示时调用：填当前生效的助手地址（桌面端 ?tripo= 可能改端口）并探测状态
function fillWebopPane(){
  const addr = $('webopBridgeAddr');
  if(addr) addr.textContent = TRIPO_WEB_BASE;
  refreshTripoWebStatus(true);
}

// 按引擎切换可见配置
function syncEngineUI(){
  /* Tripo 已从生图引擎中移除（2026-10-29）：网页账号在「网页操作」页独立管理，
     isTripoWeb() 以连接状态为准，与引擎选择无关。引擎只剩 OpenAI 兼容一项，
     这里只负责探一次网页助手状态（isTripoWeb 的真值来源）。 */
  refreshTripoWebStatus(true);
  renderAllModelTabs();
  updateModelLabels();
}

// ---- 输入绑定 ----
// toggle 密码显示
document.querySelectorAll('.toggle-pw').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const t = $(btn.dataset.target);
    t.type = t.type === 'password' ? 'text' : 'password';
    btn.textContent = t.type === 'password' ? '显示' : '隐藏';
  });
});

let currentImageDataURL = null;
let currentPrompt = '';

function setStatus(msg, cls){ const s = $('status'); s.textContent = msg; s.className = 'statusbar ' + (cls||''); }

// 拖放 / 选择 / 粘贴
const dz = $('dropzone');
dz.addEventListener('click', ()=> $('fileInput').click());
$('fileInput').addEventListener('change', e => { if(e.target.files[0]) readImage(e.target.files[0]); });
['dragover','dragenter'].forEach(ev => dz.addEventListener(ev, e=>{ e.preventDefault(); dz.classList.add('drag'); }));
['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e=>{ e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', e => { if(e.dataTransfer.files[0]) readImage(e.dataTransfer.files[0]); });
window.addEventListener('paste', e => {
  const items = (e.clipboardData||{}).items || [];
  for(const it of items){
    if(it.type.startsWith('image/')){
      const file = it.getAsFile();
      readImage(file);
      return;
    }
  }
});

function readImage(file){
  const r = new FileReader();
  r.onload = () => {
    currentImageDataURL = r.result;
    setStatus('已加载图片 ' + (file.name || '剪贴板图片'), 'ok');
    ensurePreview();
    $('previewBox').innerHTML = `<img src="${r.result}">`;
    $('imgMeta').textContent = '已载入';
  };
  r.readAsDataURL(file);
}

function ensurePreview(){
  $('dropzone').classList.add('has-image');
}

// ---- 通用 fetch Json ----
async function post(base, key, path, body){
  const res = await apiFetch(base.replace(/\/$/,'') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body)
  });
  if(!res.ok){
    const t = await res.text();
    throw new Error('HTTP ' + res.status + ': ' + prettyError(t));
  }
  /* 网关对拼错/缺 /v1 的路径可能回退 SPA 首页（200 + text/html），
     res.json() 只会报「Unexpected token '<'」——先拦下来给出可操作建议。 */
  if((res.headers.get('content-type') || '').toLowerCase().includes('text/html')){
    throw new Error('接口返回的是网页而不是 API 数据：通常是接口地址少了 /v1，'
      + '试试「' + base.replace(/\/$/,'') + '/v1」');
  }
  return res.json();
}

function lookupPath(o, path){
  return path.split('.').reduce((acc,k)=>{
    if(acc==null) return undefined;
    const idx = k.match(/^(\w+)\[(\d+)\]$/);
    if(idx) return acc[idx[1]] && acc[idx[1]][idx[2]];
    return acc[k];
  }, o);
}

// 中转返回的 JSON 错误体（{"error":"..."}）比裸文本更可读
/* 上游的错误体五花八门：
 *   官方 OpenAI   {"error":{"message":"…","type":"invalid_request_error"}}
 *   Ollama        {"error":"model requires more system memory"}
 *   vLLM / TGI    {"object":"error","message":"…"}
 *   网关          {"error":"upstream timeout"} / {"detail":"…"}
 * 老实现只取 `j.error || j.message` 再 String() —— **error 是对象时直接变 "[object Object]"**，
 * 于是运行日志只剩一句「HTTP 400: [object Object]」，等于没报错（真踩过）。
 * 这里递归把真正的那句话挖出来，实在挖不到才退回原文。 */
function pickErrMsg(o, depth){
  if(o == null) return '';
  if(typeof o === 'string'){ const s = o.trim(); return s ? s.slice(0, 300) : ''; }
  if(typeof o === 'number' || typeof o === 'boolean') return String(o);
  if(depth > 4) return '';
  if(Array.isArray(o)){
    for(const x of o){ const s = pickErrMsg(x, depth + 1); if(s) return s; }
    return '';
  }
  if(typeof o === 'object'){
    /* 顺序有讲究：`error` 放最后。OAuth 风格的 {"error":"invalid_request",
     * "error_description":"Missing Authorization header"} 里，前者只是错误码，
     * 能读的是后者；而 OpenAI 那种 error 本身是个对象，会自己往下递归到 message。 */
    const keys = ['message', 'msg', 'error_description', 'detail', 'reason', 'error'];
    for(const k of keys){
      if(!(k in o)) continue;
      const s = pickErrMsg(o[k], depth + 1);
      if(s) return s;
    }
  }
  return '';
}

function prettyError(text){
  const t = String(text == null ? '' : text).trim();
  if(!t) return '（响应体为空）';
  try{
    const j = JSON.parse(t);
    const s = pickErrMsg(j, 0);
    if(s) return s;
    /* 结构认不出来（如 {"code":4001,"data":{…}}）就压成一行 JSON，别把原始信息丢掉 */
    const flat = JSON.stringify(j);
    return flat && flat !== '{}' ? flat.slice(0, 300) : '（响应体是空对象）';
  }catch(e){
    return t.slice(0, 300);
  }
}

/* 上游一律说英语。运行日志直接甩一句
 * 「Multimodal data provided, but model does not support multimodal requests.」
 * 用户既看不懂、也不知道该改什么，只能来问「这是什么意思」。
 * 这里把常见病因翻成中文，**中文在前、原文附在括号里**——排错时还要靠原文去搜。
 * 只翻译，不改写语义：认不出就明说「上游返回错误」，不要假装看懂了。 */
const ERR_ZH = [
  [/multimodal|does not support (image|vision|multimodal)|image input is not supported/i,
    '这个模型不接受图像输入', '把「图像」引脚的连线摘掉，或换成视觉模型（Qwen3-VL / Qwen2.5-VL）'],
  [/context length|maximum context|too many tokens|context window|token limit/i,
    '输入超出上下文长度', '减少图片数量 / 尺寸，或关掉引用上一轮的上下文'],
  [/invalid api key|incorrect api key|invalid_api_key|api key not valid|unauthorized|authentication/i,
    'API Key 无效或已失效', '到设置里重新粘贴该站的 Key（注意别带空格，账号密码不能用于接口）'],
  [/rate limit|too many requests|429/i,
    '被上游限流（请求太频繁）', '等一会儿再试，或换一条线路 / 换服务商'],
  [/model .{0,40}(not found|not exist|does not exist|unknown)|no such model|unknown model|model_not_found/i,
    '模型名不存在', '到设置里点「读取模型」，从清单里选一个'],
  [/insufficient (quota|balance)|quota exceeded|billing|payment required|out of credits|recharge/i,
    '额度或余额不足', '到该站的控制台充值，或换用别的来源'],
  [/upstream (timeout|timed out)|gateway time-?out|deadline exceeded/i,
    '上游超时', '稍后重试，或把该节点的「超时」调大'],
  [/content (policy|filter)|safety system|blocked by (policy|safety)/i,
    '被内容安全策略拦截', '换个说法再试（这类拦截来自上游，本地改不了）'],
  [/max_tokens|maximum.{0,20}tokens.{0,20}exceed/i,
    '输出长度超出上限', '把「最大输出」调大，或让它分次回答']
];

function translateErr(m){
  const raw = String(m || '').trim();
  if(!raw) return '';
  for(const row of ERR_ZH){
    if(row[0].test(raw)) return row[1] + '：' + row[2] + '（原文：' + raw.slice(0, 140) + '）';
  }
  /* 全英文又认不出：至少标明「这是上游原文」，别让人以为是我们自己写的中文提示 */
  if(!/[\u4e00-\u9fa5]/.test(raw) && /[a-z]{4,}/i.test(raw)){
    return '上游返回错误：' + raw.slice(0, 160);
  }
  return '';
}

function friendlyErr(e){
  const m = (e && e.message) || String(e);
  if(/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(m)){
    if(relayEnabled()){
      return '无法连接本地中转：请双击项目里的 start.bat 启动（桌面模式下已托管本地中转），或运行 node plugins\relay\relay.js，并确认地址为 ' + relayBase();
    }
    if(location.protocol === 'file:'){
      return '网络或跨域失败：当前以 file:// 直接打开，多数接口会拒绝。请改用本地 HTTP 服务打开，或换用支持浏览器直连的服务商';
    }
    return '网络或跨域(CORS)失败：该服务商未开放浏览器跨域。可换用 OpenRouter / DeepSeek / 硅基流动，或通过本地代理转发';
  }
  // 中转层报上来的上游故障：给出下一步动作
  if(/ECONNRESET|socket hang up|上游连接被重置/i.test(m)){
    return m + '｜本机中转已自动重试仍未成功：可稍后重试，或检查本机代理 / 网络，或把该节点的「超时」调大后重跑。';
  }
  /* 本地模型显存不足：Ollama 原样抛出的是
   * "llama-server startup failed before projector CPU offload retry:
   *  llama-server reported out-of-memory during startup: CUDA error: out of memory"，
   * 用户看到这一串只会以为程序坏了，然后反复重试。
   * 实测（4 GB 显存跑 8B 视觉模型）这是必然触发，且**不会**自动降级到 CPU——
   * 所以在文案里必须给出「换小一档」这个具体动作。 */
  if(/out of memory|out-of-memory|CUDA error|failed to allocate|insufficient memory/i.test(m)){
    return '显存不足，模型没能加载起来（本地引擎不会自动降级到 CPU）。' +
      '换小一档的模型（识图建议 Qwen3-VL 2B / 4B），或先关掉占显存的程序再试。' +
      '原始报错：' + m.slice(0, 150);
  }
  if(/上游响应超时/.test(m)){
    return m + '｜可调大该节点的「超时」参数，或减少单次请求的图片体积。';
  }
  if(/无法连接上游服务|域名解析失败/.test(m)){
    return m + '｜请检查本机网络与代理设置是否可用。';
  }
  /* 走到这里的基本都是上游原样抛回来的英文。翻成中文再收尾——
   * 前面几段已经处理过的（CORS / 重置 / OOM / 超时）本来就是中文，不会重复翻译。 */
  const zh = translateErr(m);
  if(zh) return zh;
  return m;
}

// ---- Tripo v3 调用 ----
function tripoKeyLooksWrong(key){
  // 明显不是 API Key：空、含邮箱、含空白、长度过短
  return !key || key.includes('@') || /\s/.test(key) || key.length < 16;
}
async function tripoCall(path, opts){
  const key = $('tripoKey').value.trim();
  if(!key) throw new Error('请先填写 Tripo API Key');
  if(tripoKeyLooksWrong(key)){
    throw new Error('Tripo Key 格式不对：请在 platform.tripo3d.ai → API Keys 生成并粘贴完整 Key，不能填邮箱或账号密码');
  }
  const headers = Object.assign({ Authorization: 'Bearer ' + key }, (opts && opts.headers) || {});
  const res = await apiFetch(TRIPO_BASE + path, Object.assign({}, opts, { headers }));
  if(!res.ok){
    const raw = (await res.text()).slice(0, 300);
    if(res.status === 401 || /invalid api key/i.test(raw)){
      throw new Error('Tripo 拒绝了这个 Key（401 Invalid API key）：请到 platform.tripo3d.ai → API Keys 重新生成，确认复制完整且无空格；账号密码不能用于接口');
    }
    throw new Error('HTTP ' + res.status + ': ' + raw);
  }
  const json = await res.json();
  if(json.code !== 0){
    if(json.code === 2 || /invalid api key/i.test(json.message || '')){
      throw new Error('Tripo API Key 无效：请到 platform.tripo3d.ai → API Keys 重新生成后再试');
    }
    throw new Error((json.message || 'Tripo 请求失败') + '（code ' + json.code + '）');
  }
  return json.data;
}

async function checkTripoKey(){
  const note = $('tripoNote');
  const key = $('tripoKey').value.trim();
  if(tripoKeyLooksWrong(key)){
    note.textContent = 'Key 格式不对：请粘贴 Tripo 平台生成的 API Key（不是邮箱或账号密码）。';
    setStatus('Tripo Key 格式不正确', 'error');
    return;
  }
  setButton('btnTripoCheck', true, '检测中…');
  note.textContent = '正在校验 Key 与余额…';
  try{
    const d = await tripoCall('/account/balance');
    const info = d && typeof d === 'object'
      ? Object.entries(d).filter(([, v]) => typeof v === 'number').slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' · ')
      : '';
    note.textContent = 'Key 有效' + (info ? ' · ' + info : '') + '（生图 / 建模按量扣费）';
    setStatus('Tripo Key 有效', 'ok');
    updateStatusChips();
  }catch(e){
    note.textContent = friendlyErr(e);
    setStatus('Tripo Key 检测失败', 'error');
  }finally{
    setButton('btnTripoCheck', false);
  }
}

async function tripoUpload(dataURL){
  const mime = (dataURL.match(/^data:([^;]+)/) || [])[1] || 'image/png';
  const ext = mime.includes('jpeg') ? 'jpg' : 'png';
  const blob = await (await fetch(dataURL)).blob();
  const fd = new FormData();
  fd.append('file', blob, 'source.' + ext);
  const d = await tripoCall('/files', { method: 'POST', body: fd });
  if(!d || !d.file_token) throw new Error('Tripo 未返回 file_token');
  return d.file_token;
}

async function tripoPoll(taskId, onProgress){
  const started = Date.now();
  while(Date.now() - started < 600000){
    const d = await tripoCall('/tasks/' + taskId);
    if(d.status === 'success') return d;
    if(d.status === 'failed' || d.status === 'cancelled'){
      throw new Error(d.error_message || ('任务状态 ' + d.status));
    }
    if(onProgress) onProgress(d.progress || 0);
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error('等待超时（任务可能仍在 Tripo 后台运行）');
}

// ---- 读取模型列表并渲染为分组选项卡 ----
let MODEL_CACHE = { base: '', list: [] };
let IMG_MODEL_CACHE = { base: '', list: [] };

const FAMILY_RULES = [
  [/^(gpt|chatgpt|o\d|dall-e|whisper|tts)/i, 'OpenAI'],
  [/^(claude|sonnet|opus|haiku)/i, 'Anthropic'],
  [/^(gemini|gemma|imagen|veo)/i, 'Google'],
  [/^grok/i, 'xAI'],
  [/^deepseek/i, 'DeepSeek'],
  [/^(qwen|qwq|wan)/i, '通义千问'],
  [/^(kimi|moonshot)/i, 'Kimi'],
  [/^(glm|chatglm|cogview|cogvideo)/i, '智谱'],
  [/^(doubao|seedream|seedance|seed-?edit)/i, '豆包'],
  [/^ernie/i, '文心'],
  [/^(hunyuan|hunyuanvideo)/i, '混元'],
  [/^(minimax|abab|hailuo)/i, 'MiniMax'],
  [/^(llama|meta-llama)/i, 'Llama'],
  [/^(mistral|mixtral|codestral|devstral)/i, 'Mistral'],
  [/^(flux|sdxl|stable|midjourney|mj|image)/i, '图像']
];
const GROUP_ORDER = ['OpenAI','Anthropic','Google','xAI','DeepSeek','通义千问','Kimi','智谱','豆包','文心','混元','MiniMax','Llama','Mistral','图像','其他'];

function groupOf(m){
  const id = m.id;
  if(id.includes('/')) return id.split('/')[0];
  const owner = (m.owned_by || '').trim();
  if(owner && !/^(system|user|organization|org)$/i.test(owner)) return owner;
  for(const [re, name] of FAMILY_RULES){ if(re.test(id)) return name; }
  return '其他';
}

function groupModels(list){
  const map = new Map();
  list.forEach(m => {
    const g = groupOf(m);
    if(!map.has(g)) map.set(g, []);
    map.get(g).push(m.id);
  });
  return [...map.entries()]
    .map(([name, ids]) => ({ name, ids: ids.sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => {
      if(a.name === '其他') return 1;
      if(b.name === '其他') return -1;
      const ia = GROUP_ORDER.indexOf(a.name), ib = GROUP_ORDER.indexOf(b.name);
      if(ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      return a.name.localeCompare(b.name);
    });
}

function modelListForCurrentBase(role){
  const isLLM = role !== 'img';
  const raw = isLLM ? $('llmBaseUrl').value.trim() : ($('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim());
  const base = raw.replace(/\/$/, '');
  const cache = isLLM ? MODEL_CACHE : IMG_MODEL_CACHE;
  return cache.base === base ? cache.list : [];
}

function parseModelList(data){
  const raw = Array.isArray(data) ? data : (data.data || data.models || []);
  return raw.map(x => typeof x === 'string'
    ? { id: x, owned_by: '' }
    : { id: x.id || x.model || x.name || '', owned_by: x.owned_by || x.ownedBy || x.provider || '' }
  ).filter(m => m.id);
}

function chipGroup(label, ids, current, onPick){
  const wrap = document.createElement('div');
  wrap.className = 'model-group';
  const lab = document.createElement('div');
  lab.className = 'model-group-label';
  lab.textContent = `${label} · ${ids.length}`;
  const chips = document.createElement('div');
  chips.className = 'model-chips';
  ids.forEach(id => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'model-chip' + (id === current ? ' active' : '');
    c.textContent = id;
    c.title = id;
    c.addEventListener('click', () => onPick(id));
    chips.appendChild(c);
  });
  wrap.append(lab, chips);
  return wrap;
}

function renderTripoImageModels(){
  const listEl = $('imgModelTabs');
  const filter = $('imgModelFilter').value.trim().toLowerCase();
  const current = $('imgModel').value.trim();
  const models = TRIPO_IMAGE_MODELS.filter(m => !filter || m.includes(filter));
  listEl.innerHTML = '';
  if(!models.length){
    listEl.innerHTML = '<div class="hint">没有匹配的模型</div>';
    return;
  }
  listEl.appendChild(chipGroup('Tripo 图像编辑', models, current, id => {
    $('imgModel').value = id;
    renderTripoImageModels();
    updateModelLabels();
    scheduleSave();
    setStatus('已选择生图模型：' + id, 'ok');
  }));
}

function renderModelTabs(role){
  if(role === 'img' && isTripo()){ renderTripoImageModels(); return; }

  const isLLM = role === 'llm';
  const listEl = $(isLLM ? 'llmModelTabs' : 'imgModelTabs');
  const filter = $(isLLM ? 'llmModelFilter' : 'imgModelFilter').value.trim().toLowerCase();
  const current = $(isLLM ? 'llmModel' : 'imgModel').value.trim();
  const all = modelListForCurrentBase(role);
  listEl.innerHTML = '';

  if(!all.length){
    const cache = isLLM ? MODEL_CACHE : IMG_MODEL_CACHE;
    listEl.innerHTML = '<div class="hint">' + (cache.list.length ? '当前 Base URL 已变化，请重新点「读取模型」' : '读取后模型会按分组显示在这里') + '</div>';
    return;
  }
  const list = filter ? all.filter(m => m.id.toLowerCase().includes(filter)) : all;
  if(!list.length){
    listEl.innerHTML = '<div class="hint">没有匹配的模型</div>';
    return;
  }

  groupModels(list).forEach(g => {
    listEl.appendChild(chipGroup(g.name, g.ids, current, id => {
      $(isLLM ? 'llmModel' : 'imgModel').value = id;
      renderModelTabs(role);
      updateModelLabels();
      scheduleSave();
      setStatus(`已选择${isLLM ? '分析' : '生图'}模型：${id}`, 'ok');
    }));
  });
}

function renderAllModelTabs(){
  renderModelTabs('llm');
  renderModelTabs('img');
}

function syncModelActive(role){
  const isLLM = role === 'llm';
  const current = $(isLLM ? 'llmModel' : 'imgModel').value.trim();
  document.querySelectorAll(`#${isLLM ? 'llmModelTabs' : 'imgModelTabs'} .model-chip`).forEach(c => {
    c.classList.toggle('active', c.textContent === current);
  });
}

async function loadModels(){
  const base = $('llmBaseUrl').value.trim().replace(/\/$/, '');
  const key = $('llmKey').value.trim();
  if(!base || !key){ setStatus('读取模型前请先填好 Base URL 和 API Key', 'error'); return; }

  setButton('btnLoadModels', true, '读取中…');
  $('modelStatus').textContent = '正在读取模型列表…';
  try{
    const res = await apiFetch(base + '/models', {
      headers: { 'Authorization': 'Bearer ' + key }
    }, 25000);
    if(!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    /* 网关对不认识的路径可能回退到 SPA 首页（200 + text/html），JSON.parse 只会报
       一句难懂的「Unexpected token <」——先拦下来给出可操作的建议。 */
    if((res.headers.get('content-type') || '').toLowerCase().includes('text/html')){
      throw new Error('接口返回的是网页而不是模型列表：通常是地址少了 /v1，试试「' + base + '/v1」');
    }
    const list = parseModelList(await res.json());

    if(!list.length) throw new Error('接口返回里没有模型 id');
    MODEL_CACHE = { base, list };
    $('modelStatus').textContent = `已读取 ${list.length} 个模型`;
    renderAllModelTabs();
    setStatus(`已读取 ${list.length} 个模型`, 'ok');
  }catch(e){
    const msg = friendlyErr(e);
    $('modelStatus').textContent = '读取失败：' + msg + '（可直接手动填写模型名称）';
    setStatus('模型读取失败：' + msg, 'error');
  }finally{
    setButton('btnLoadModels', false);
  }
}

async function loadImgModels(){
  const base = ($('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim()).replace(/\/$/, '');
  const key = $('imgKey').value.trim() || $('llmKey').value.trim();
  if(!base || !key){ setStatus('读取生图模型前请先填好 Base URL 和 Key（图像或分析侧）', 'error'); return; }

  setButton('btnLoadImgModels', true, '读取中…');
  $('imgModelStatus').textContent = '正在读取模型列表…';
  try{
    const res = await apiFetch(base + '/models', {
      headers: { 'Authorization': 'Bearer ' + key }
    }, 25000);
    if(!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    if((res.headers.get('content-type') || '').toLowerCase().includes('text/html')){
      throw new Error('接口返回的是网页而不是模型列表：通常是地址少了 /v1，试试「' + base + '/v1」');
    }
    const list = parseModelList(await res.json());

    if(!list.length) throw new Error('接口返回里没有模型 id');
    IMG_MODEL_CACHE = { base, list };
    $('imgModelStatus').textContent = `已读取 ${list.length} 个模型`;
    renderModelTabs('img');
    setStatus(`已读取 ${list.length} 个生图模型`, 'ok');
  }catch(e){
    const msg = friendlyErr(e);
    $('imgModelStatus').textContent = '读取失败：' + msg + '（可直接手动填写模型名称）';
    setStatus('生图模型读取失败：' + msg, 'error');
  }finally{
    setButton('btnLoadImgModels', false);
  }
}

// ---- 连通性测试 ----
function showTest(name, state, ms, detail, boxId){
  const box = $(boxId || 'testLLMResult');
  const old = box.querySelector('.test-item[data-test="' + name + '"]');
  if(old) old.remove();
  const item = document.createElement('div');
  item.className = 'test-item ' + state;
  item.dataset.test = name;
  const label = state === 'ok' ? name + ' 通过' : name + ' 失败';
  item.innerHTML = `<span class="name">${label}</span>` +
    (ms != null ? `<span class="ms">${ms}ms</span>` : '') +
    `<span class="detail"></span>`;
  item.querySelector('.detail').textContent = detail || '';
  box.appendChild(item);
}

async function testLLM(){
  const base = $('llmBaseUrl').value.trim();
  const model = $('llmModel').value.trim();
  const key = $('llmKey').value.trim();
  if(!base || !model || !key){ setStatus('测试分析接口前请填写 Base URL / 模型名 / Key', 'error'); return; }

  $('testLLMResult').querySelector('.test-item[data-test="分析接口"]')?.remove();
  setButton('testLLM', true, '测试中…');
  const t0 = performance.now();
  try{
    const content = currentImageDataURL ? [
      { type: 'text', text: '连通性测试，请只回复 OK' },
      { type: 'image_url', image_url: { url: currentImageDataURL } }
    ] : '连通性测试，请只回复 OK';
    const data = await post(base, key, '/chat/completions', {
      model,
      messages: [{ role: 'user', content }],
      max_tokens: 16,
      temperature: 0
    });
    const ms = Math.round(performance.now() - t0);
    const reply = ((data.choices && data.choices[0] && data.choices[0].message.content) || '').trim().slice(0, 60);
    showTest('分析接口', 'ok', ms, `${data.model || model}${currentImageDataURL ? '（含图片输入）' : '（纯文本）'} · ${reply || '已响应'}`, 'testLLMResult');
    setStatus('分析接口连通', 'ok');
  }catch(e){
    const ms = Math.round(performance.now() - t0);
    showTest('分析接口', 'error', ms, friendlyErr(e), 'testLLMResult');
    setStatus('分析接口测试失败', 'error');
  }finally{
    setButton('testLLM', false);
  }
}

async function testIMG(){
  if(isTripo()){
    if(!$('tripoKey').value.trim()){ setStatus('测试 Tripo 前请先填写 Tripo API Key', 'error'); return; }
    if(!currentImageDataURL){ setStatus('Tripo 连通性测试需先载入一张原图', 'error'); return; }
    $('testIMGResult').querySelector('.test-item[data-test="生图接口"]')?.remove();
    setButton('testIMG', true, '测试中…');
    const t0 = performance.now();
    try{
      const token = await tripoUpload(currentImageDataURL);
      const ms = Math.round(performance.now() - t0);
      showTest('生图接口', 'ok', ms, `Tripo 文件上传正常 · ${token}`, 'testIMGResult');
      setStatus('Tripo 接口连通', 'ok');
    }catch(e){
      showTest('生图接口', 'error', Math.round(performance.now() - t0), friendlyErr(e), 'testIMGResult');
      setStatus('Tripo 接口测试失败', 'error');
    }finally{
      setButton('testIMG', false);
    }
    return;
  }

  const base = ($('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim()).replace(/\/$/,'');
  const model = ($('imgModel').value.trim() || $('llmModel').value.trim());
  const key = $('imgKey').value.trim() || $('llmKey').value.trim();
  const endpoint = $('imgEndpoint').value.trim();
  if(!base || !model || !key || !endpoint){ setStatus('测试生图接口前请填写 Base URL / 模型名 / Key / 端点', 'error'); return; }

  $('testIMGResult').querySelector('.test-item[data-test="生图接口"]')?.remove();
  setButton('testIMG', true, '测试中…');
  const t0 = performance.now();
  try{
    const size = $('imgSize').value.trim() || '1024x1024';
    const isEdit = /edit/i.test(endpoint);
    let data, usedPath = endpoint, extra = '';

    if(isEdit && currentImageDataURL){
      const blob = await (await fetch(currentImageDataURL)).blob();
      const fd = new FormData();
      fd.append('model', model);
      fd.append('prompt', 'connectivity test');
      fd.append('size', size);
      fd.append('image', blob, 'test.png');
      const res = await apiFetch(base + endpoint, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key },
        body: fd
      });
      if(!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0,300));
      data = await res.json();
    } else {
      if(isEdit){
        usedPath = endpoint.replace(/edit/i, 'generations');
        extra = '（无原图，改用生成端点测试）';
      }
      data = await post(base, key, usedPath, {
        model,
        prompt: 'connectivity test',
        size
      });
    }

    const ms = Math.round(performance.now() - t0);
    const url = lookupPath(data, $('respPath').value.trim() || 'data[0].url');
    const b64json = lookupPath(data, 'data[0].b64_json');
    if(url || b64json){
      showTest('生图接口', 'ok', ms, `端点 ${usedPath} 可用${extra}`, 'testIMGResult');
      setStatus('生图接口连通', 'ok');
    } else {
      showTest('生图接口', 'ok', ms, `端点可达，但响应里没找到图片字段（检查“响应字段路径”）。返回片段：${JSON.stringify(data).slice(0,120)}`, 'testIMGResult');
      setStatus('生图接口可达，但响应格式未匹配', 'warn');
    }
  }catch(e){
    const ms = Math.round(performance.now() - t0);
    showTest('生图接口', 'error', ms, friendlyErr(e), 'testIMGResult');
    setStatus('生图接口测试失败', 'error');
  }finally{
    setButton('testIMG', false);
  }
}

