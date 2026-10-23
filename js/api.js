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
    if(!res.ok) throw new Error((data && data.message) || ('HTTP ' + res.status));
    return data || {};
  }catch(e){
    if(e && e.name === 'AbortError') throw new Error('本地助手无响应（' + Math.round(ms / 1000) + ' 秒超时）');
    if(e instanceof TypeError) throw new Error('无法连接 Tripo 助手：请先双击 start-tripo-bridge.bat');
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

async function refreshTripoWebStatus(silent){
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

function setChip(id, ok, text, tip){
  const el = $(id);
  el.classList.toggle('off', !ok);
  el.querySelector('.sc-value').textContent = text;
  el.title = tip;
}

function updateStatusChips(){
  const key = $('llmKey').value.trim();
  const base = $('llmBaseUrl').value.trim();
  const llm = $('llmModel').value.trim();
  const llmOk = !!(key && base && llm);
  setChip('stLLM', llmOk, llm || '未配置',
    llmOk ? `语言模型：${llm} · ${activePreset || base}` : '未配置：需要 API Key、接口地址与模型');

  const tripo = isTripo();
  const tripoWeb = isTripoWeb();
  const tKey = $('tripoKey').value.trim();
  const tKeyOk = !!tKey && !tripoKeyLooksWrong(tKey);
  const rawImg = $('imgModel').value.trim();
  if(tripoWeb){
    setChip('stIMG', tripoWebReady, 'Tripo 网页账号',
      tripoWebReady ? '图像模型：Tripo 网页账号 · 已连接生图页' : '未连接：先运行 start-tripo-bridge.bat，再打开登录页');
  } else {
    const imgModel = rawImg || (tripo ? '' : llm);
    const imgBase = $('imgBaseUrl').value.trim() || base;
    const imgKey = tripo ? (tKeyOk ? tKey : '') : ($('imgKey').value.trim() || key);
    const imgOk = !!(imgKey && imgModel && (tripo || imgBase));
    const imgSource = tripo ? 'Tripo' : (activeImgPreset === IMG_FOLLOW ? '复用分析接口' : activeImgPreset);
    setChip('stIMG', imgOk, imgModel || '未配置',
      imgOk ? `图像模型：${imgModel} · ${imgSource}` : '未配置：需要接口 Key 与图像模型');
  }

  const tier = TRIPO_TIER[$('tripoVersion').value] || 'H3.1';
  const threeOk = tripo && tKeyOk;
  setChip('st3D', threeOk, tripo ? (threeOk ? tier : (tKey ? 'Key 无效' : '缺 Key')) : '未启用',
    threeOk ? `3D 模型：Tripo ${tier}` : '未配置：切换到 Tripo，并填入 platform.tripo3d.ai 生成的 API Key（不是账号密码）');
}

// 按引擎切换可见配置
function syncEngineUI(){
  const tripo = isTripo();
  const tripoWeb = isTripoWeb();
  $('tripoBox').classList.toggle('hidden', !tripo);
  $('tripoWebBox').classList.toggle('hidden', !tripoWeb);
  $('openaiMain').classList.toggle('hidden', tripo || tripoWeb);
  $('openaiAdv').classList.toggle('hidden', tripo || tripoWeb);
  $('tripoAdv').classList.toggle('hidden', !tripo);
  $('btnGenerate3D').classList.toggle('hidden', !tripo);
  $('imgModelBox').classList.toggle('hidden', tripoWeb);
  if(tripo && !TRIPO_IMAGE_MODELS.includes($('imgModel').value.trim())){
    $('imgModel').value = 'seedream_v5';
  }
  if(tripoWeb) refreshTripoWebStatus(true);
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
      if(!$('baseView').classList.contains('hidden') && baseTab === 'i2i') readBaseRef(file);
      else readImage(file);
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
function prettyError(text){
  const t = String(text || '');
  try{
    const j = JSON.parse(t);
    if(j && (j.error || j.message)) return String(j.error || j.message);
  }catch(e){}
  return t.slice(0, 300);
}

function friendlyErr(e){
  const m = (e && e.message) || String(e);
  if(/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(m)){
    if(relayEnabled()){
      return '无法连接本地中转：请双击项目文件夹里的 start-relay.bat 启动，或运行 node relay.js，并确认地址为 ' + relayBase();
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
  if(/上游响应超时/.test(m)){
    return m + '｜可调大该节点的「超时」参数，或减少单次请求的图片体积。';
  }
  if(/无法连接上游服务|域名解析失败/.test(m)){
    return m + '｜请检查本机网络与代理设置是否可用。';
  }
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

