/* 配置持久化 / 本地中转 / 接口来源预设 / 生图中转站
 * 原 index.html 1336-1778 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
const STORE_BASE = 'http://127.0.0.1:8787';
// 本地中转会把 hf_* 配置落盘；浏览器存储被清空或预览端口变化时，从这里回填
(function(){
  const rawSet = Storage.prototype.setItem;
  const isHf = k => String(k).indexOf('hf_') === 0;

  // 所有 hf_* 写入同步到本地中转（中转没开时静默失败，不影响页面）
  Storage.prototype.setItem = function(k, v){
    rawSet.call(this, k, v);
    if(!isHf(k)) return;
    try{
      if(String(v).length > 4 * 1024 * 1024) return;
      fetch(STORE_BASE + '/store/' + encodeURIComponent(k), { method:'POST', body:String(v), keepalive:true }).catch(() => {});
    }catch(e){}
  };

  // 异步读取落盘配置；中转可能比页面晚启动，因此带几次重试。
  // 只补齐本地缺失的键，不覆盖浏览器里已有的新值。
  async function hydrate(){
    for(const wait of [0, 700, 1600]){
      if(wait) await new Promise(r => setTimeout(r, wait));
      let data = null;
      try{
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1200);
        const r = await fetch(STORE_BASE + '/store.js', { cache:'no-store', signal: ctrl.signal });
        clearTimeout(timer);
        if(!r.ok) continue;
        const txt = await r.text();
        const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
        if(a < 0 || b <= a) continue;
        data = JSON.parse(txt.slice(a, b + 1));
      }catch(e){ continue; }
      if(!data || typeof data !== 'object') continue;
      let filled = 0;
      Object.keys(data).forEach(k => {
        if(!isHf(k) || typeof data[k] !== 'string') return;
        try{
          if(localStorage.getItem(k) == null){ rawSet.call(localStorage, k, data[k]); filled++; }
        }catch(e){}
      });
      if(filled && typeof loadAll === 'function'){
        loadAll();
        if(typeof syncEngineUI === 'function') syncEngineUI();
        if(typeof updateStatusChips === 'function') updateStatusChips();
      }
      if(filled) return;
    }
  }
  hydrate();
})();

const $ = id => document.getElementById(id);
const loadKey = k => localStorage.getItem('hf_' + k);

// ---- 配置持久化 ----
const CFG = ['llmBaseUrl','llmModel','imgBaseUrl','imgEndpoint','imgModel','imgSize','respPath','sendImage','genEngine','tripoVersion','tripoWebUrl','relayUrl','relayOn'];
let saveTimer = null;

// ---- 本地中转（绕过服务商 CORS 限制）----
const RELAY_DEFAULT = 'http://127.0.0.1:8787';
function relayEnabled(){
  return !!($('relayOn') && $('relayOn').checked);
}
function relayBase(){
  const v = ($('relayUrl') && $('relayUrl').value.trim()) || RELAY_DEFAULT;
  return v.replace(/\/$/, '');
}
function apiRequest(url, opts){
  // 本地助手（127.0.0.1 / localhost）不经过中转，避免被代理转发
  if(!relayEnabled() || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) return { url, init: opts || {} };
  const headers = Object.assign({}, (opts && opts.headers) || {}, { 'X-Relay-Target': url });
  return { url: relayBase() + '/proxy', init: Object.assign({}, opts || {}, { headers }) };
}
async function apiFetch(url, opts, timeoutMs){
  const ms = timeoutMs || 180000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const req = apiRequest(url, opts);
  const init = Object.assign({}, req.init, { signal: ctrl.signal });
  try{
    return await fetch(req.url, init);
  }catch(e){
    if(e && e.name === 'AbortError'){
      throw new Error('请求超时（' + Math.round(ms / 1000) + ' 秒）：服务商没有响应');
    }
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

// ---- Tripo v3（图像编辑 / 3D 建模）----
const TRIPO_BASE = 'https://openapi.tripo3d.com/v3';
const TRIPO_IMAGE_MODELS = ['seedream_v5','banana_pro','banana2','chat_image_2.5_sunburst','chat_image_2.5_flare','chat_image_2'];
const isTripo = () => $('genEngine').value === 'tripo';
const TRIPO_WEB_BASE = 'http://127.0.0.1:8790';
const isTripoWeb = () => $('genEngine').value === 'tripo-web';
let tripoWebReady = false;

// ---- 接口来源预设（点击标签自动切换 Base URL）----
const PRESET_GROUPS = [
  { label: '中转站', items: [
    ['灵算', 'https://api.lingsuan.si/v1'],
    ['302.AI', 'https://api.302.ai/v1'],
    ['AIHubMix', 'https://aihubmix.com/v1'],
    ['OpenRouter', 'https://openrouter.ai/api/v1'],
    ['LimAPI', 'https://limapi.com/api/v1'],
    ['灵核', 'https://api.lingcoreai.com/v1'],
    ['API2D', 'https://oa.api2d.net/v1'],
    ['OhMyGPT', 'https://api.ohmygpt.com/v1']
  ]},
  { label: '官方直连', items: [
    ['OpenAI', 'https://api.openai.com/v1'],
    ['DeepSeek', 'https://api.deepseek.com/v1'],
    ['硅基流动', 'https://api.siliconflow.cn/v1'],
    ['智谱', 'https://open.bigmodel.cn/api/paas/v4'],
    ['通义百炼', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['Kimi', 'https://api.moonshot.cn/v1'],
    ['火山方舟', 'https://ark.cn-beijing.volces.com/api/v3'],
    ['百度千帆', 'https://qianfan.baidubce.com/v2'],
    ['腾讯混元', 'https://api.hunyuan.cloud.tencent.com/v1'],
    ['MiniMax', 'https://api.minimax.chat/v1']
  ]}
];
const ALL_PRESETS = PRESET_GROUPS.flatMap(g => g.items);
const CUSTOM_PRESET = { name: '自定义', base: '', custom: true };
let activePreset = '';

// 中转站官网，方便注册并获取 Key
const PRESET_SITES = {
  '灵算': 'https://lingsuan.si',
  '302.AI': 'https://302.ai',
  'AIHubMix': 'https://aihubmix.com',
  'OpenRouter': 'https://openrouter.ai',
  'LimAPI': 'https://limapi.com',
  '灵核': 'https://lingcoreai.com',
  'API2D': 'https://api2d.com',
  'OhMyGPT': 'https://ohmygpt.com'
};

function renderPresetLinks(containerId){
  const box = $(containerId);
  if(!box) return;
  box.innerHTML = '';
  const lab = document.createElement('span');
  lab.className = 'pl-label';
  lab.textContent = '中转站官网：';
  box.appendChild(lab);
  PRESET_GROUPS[0].items.forEach(([name]) => {
    const url = PRESET_SITES[name];
    if(!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = name + ' ↗';
    a.title = '打开 ' + name + ' 官网，注册并获取 API Key';
    box.appendChild(a);
  });
}

// ---- 生图中转站：走 OpenAI 兼容 images 接口，按张计价 ----
const IMG_PRESET_GROUPS = [
  { label: '生图中转站', items: [
    { name: 'Crazyrouter', base: 'https://cn.crazyrouter.com/v1', model: 'nano-banana', price: '约 $0.02/张', site: 'https://crazyrouter.com' },
    { name: 'Kunavo', base: 'https://api.kunavo.com/v1', model: 'nano-banana', price: '约 $0.027/张', site: 'https://kunavo.com' },
    { name: 'API易', base: 'https://api.apiyi.com/v1', model: 'gemini-3.1-flash-lite-image', price: '约 $0.025/张起', site: 'https://apiyi.com' },
    { name: 'AIHubMix', base: 'https://aihubmix.com/ai/v1', model: 'gemini-nano-banana-2.1', price: '按 token 计费', site: 'https://aihubmix.com' }
  ] },
  { label: '官方直连', items: [
    { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-image-1', price: '按质量计费', site: 'https://platform.openai.com' },
    { name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors', price: '', site: 'https://cloud.siliconflow.cn' }
  ] }
];
const IMG_PRESETS = IMG_PRESET_GROUPS.flatMap(g => g.items);

function renderImgPresetLinks(){
  const box = $('imgPresetLinks');
  if(!box) return;
  box.innerHTML = '';
  const lab = document.createElement('span');
  lab.className = 'pl-label';
  lab.textContent = '中转站官网（含报价）：';
  box.appendChild(lab);
  IMG_PRESET_GROUPS[0].items.forEach(p => {
    const a = document.createElement('a');
    a.href = p.site;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = p.name + (p.price ? ' ' + p.price : '') + ' ↗';
    a.title = '打开 ' + p.name + ' 官网（' + p.price + '，以站内实时价格为准）';
    box.appendChild(a);
  });
}

function renderPresets(){
  const sel = $('presetSelect');
  sel.innerHTML = '';
  PRESET_GROUPS.forEach(g => {
    const og = document.createElement('optgroup');
    og.label = g.label;
    g.items.forEach(([name]) => {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  const custom = document.createElement('option');
  custom.value = CUSTOM_PRESET.name;
  custom.textContent = CUSTOM_PRESET.name + '（手动填写地址）';
  sel.appendChild(custom);
  syncPresetSelect();
}

function applyPreset(p, silent){
  activePreset = p.name;
  if(p.base){
    $('llmBaseUrl').value = p.base;
  } else {
    $('llmBaseUrl').focus();
  }
  localStorage.setItem('hf_preset', p.name);
  syncPresetSelect();
  $('testLLMResult').innerHTML = '';
  $('testIMGResult').innerHTML = '';
  $('modelStatus').textContent = '选择来源并填入 Key 后，点「读取模型」';
  renderAllModelTabs();
  updateStatusChips();
  scheduleSave();
  if(!silent){
    setStatus(p.custom ? '已切换为自定义，请手动填写路由地址' : `已切换到 ${p.name}：${p.base}`, 'ok');
  }
}

function syncPresetSelect(){
  $('presetSelect').value = activePreset || '自定义';
}

function initPresets(){
  renderPresets();
  const current = $('llmBaseUrl').value.trim();
  const hit = ALL_PRESETS.find(([, b]) => b === current);
  if(hit){
    activePreset = hit[0];
  } else if(!current){
    const savedName = localStorage.getItem('hf_preset') || '灵算';
    const saved = ALL_PRESETS.find(([n]) => n === savedName) || ALL_PRESETS.find(([n]) => n === '灵算');
    if(saved) applyPreset({ name: saved[0], base: saved[1] }, true);
  } else {
    activePreset = '自定义';
  }
  syncPresetSelect();
}

// 下拉选择接口来源
$('presetSelect').addEventListener('change', () => {
  const name = $('presetSelect').value;
  if(name === CUSTOM_PRESET.name){
    applyPreset(CUSTOM_PRESET);
  } else {
    const found = ALL_PRESETS.find(([n]) => n === name);
    if(found) applyPreset({ name: found[0], base: found[1] });
  }
});

// 手动改地址时同步下拉选中：命中预设就选中，否则切到自定义
$('llmBaseUrl').addEventListener('input', () => {
  const v = $('llmBaseUrl').value.trim();
  const hit = ALL_PRESETS.find(([, b]) => b === v);
  activePreset = hit ? hit[0] : '自定义';
  syncPresetSelect();
  renderAllModelTabs();
  updateStatusChips();
});

// 惰性绑定：loadModels 定义在后续 js/api.js，此处若直接传引用会在加载期 ReferenceError
$('btnLoadModels').addEventListener('click', () => loadModels());

// ---- 生图接口来源：可独立选择中转站，也可复用分析侧 ----
const IMG_FOLLOW = '复用分析接口';
let activeImgPreset = IMG_FOLLOW;

function renderImgPresets(){
  const sel = $('imgPresetSelect');
  sel.innerHTML = '';
  const follow = document.createElement('option');
  follow.value = IMG_FOLLOW;
  follow.textContent = '复用分析接口配置（默认）';
  sel.appendChild(follow);
  IMG_PRESET_GROUPS.forEach(g => {
    const og = document.createElement('optgroup');
    og.label = g.label;
    g.items.forEach(p => {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name + (p.price ? ' · ' + p.price : '') + (p.model ? ' · ' + p.model : '');
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
  const custom = document.createElement('option');
  custom.value = CUSTOM_PRESET.name;
  custom.textContent = '自定义（手动填写地址）';
  sel.appendChild(custom);
  syncImgPresetSelect();
}

function syncImgPresetSelect(){
  $('imgPresetSelect').value = activeImgPreset || IMG_FOLLOW;
}

function applyImgPreset(p, silent){
  activeImgPreset = p.name;
  if(p.base){
    $('imgBaseUrl').value = p.base;
    if(p.model){
      $('imgModel').value = p.model;
      $('imgEndpoint').value = '/images/edits';
      updateModelLabels();
    }
  } else if(p.name === CUSTOM_PRESET.name){
    $('imgBaseUrl').focus();
  } else {
    $('imgBaseUrl').value = '';
  }
  localStorage.setItem('hf_imgPreset', p.name);
  syncImgPresetSelect();
  $('testIMGResult').innerHTML = '';
  $('imgModelStatus').textContent = p.name === IMG_FOLLOW
    ? '沿用分析侧的 Base URL；图像 Key 留空时也复用分析侧 Key'
    : (p.base
      ? `已选择 ${p.name}${p.model ? ' · ' + p.model : ''}：填入该站 Key 后可「读取模型」`
      : '请填写该站的 Base URL');
  renderModelTabs('img');
  scheduleSave();
  updateStatusChips();
  if(!silent){
    setStatus(p.name === IMG_FOLLOW ? '生图复用分析接口配置' : `生图接口来源已切换为 ${p.name}`, 'ok');
  }
}

function initImgPresets(){
  renderImgPresets();
  renderImgPresetLinks();
  const current = $('imgBaseUrl').value.trim().replace(/\/$/, '');
  if(!current){
    activeImgPreset = IMG_FOLLOW;
  } else {
    const hit = IMG_PRESETS.find(p => p.base.replace(/\/$/, '') === current)
      || ALL_PRESETS.find(([, b]) => b.replace(/\/$/, '') === current);
    activeImgPreset = hit ? (Array.isArray(hit) ? hit[0] : hit.name) : CUSTOM_PRESET.name;
  }
  syncImgPresetSelect();
}

$('imgPresetSelect').addEventListener('change', () => {
  const name = $('imgPresetSelect').value;
  if(name === IMG_FOLLOW){
    applyImgPreset({ name: IMG_FOLLOW, base: '' });
  } else if(name === CUSTOM_PRESET.name){
    applyImgPreset(CUSTOM_PRESET);
  } else {
    const found = IMG_PRESETS.find(p => p.name === name);
    if(found) applyImgPreset(found);
  }
});

$('imgBaseUrl').addEventListener('input', () => {
  const v = $('imgBaseUrl').value.trim().replace(/\/$/, '');
  if(!v){
    activeImgPreset = IMG_FOLLOW;
  } else {
    const hit = IMG_PRESETS.find(p => p.base.replace(/\/$/, '') === v)
      || ALL_PRESETS.find(([, b]) => b.replace(/\/$/, '') === v);
    activeImgPreset = hit ? (Array.isArray(hit) ? hit[0] : hit.name) : CUSTOM_PRESET.name;
  }
  syncImgPresetSelect();
  updateStatusChips();
});

$('btnLoadImgModels').addEventListener('click', () => loadImgModels());
$('llmModelFilter').addEventListener('input', () => renderModelTabs('llm'));
$('imgModelFilter').addEventListener('input', () => renderModelTabs('img'));
$('llmModel').addEventListener('input', () => { syncModelActive('llm'); updateModelLabels(); });
$('imgModel').addEventListener('input', () => { syncModelActive('img'); updateModelLabels(); });

// 配置存 localStorage（输入即自动保存）
function setInputValue(el, val){
  if(val == null) return;
  if(el.type === 'checkbox') el.checked = val === 'true' || val === true;
  else el.value = val;
}
function loadAll(){
  CFG.forEach(id => setInputValue($(id), loadKey(id)));
  setInputValue($('llmKey'), loadKey('llmKey'));
  setInputValue($('imgKey'), loadKey('imgKey'));
  setInputValue($('tripoKey'), loadKey('tripoKey'));
  // 旧版本保存的灵算地址不是 API 域名，自动迁移
  let migrated = false;
  ['llmBaseUrl', 'imgBaseUrl'].forEach(id => {
    if(/^https:\/\/www\.lingsuan\.si/i.test($(id).value.trim())){
      $(id).value = 'https://api.lingsuan.si/v1';
      migrated = true;
    }
  });
  if(migrated) saveAll();
}
function saveAll(){
  CFG.forEach(id => {
    const el = $(id);
    localStorage.setItem('hf_' + id, el.type === 'checkbox' ? el.checked : el.value);
  });
  localStorage.setItem('hf_llmKey', $('llmKey').value);
  localStorage.setItem('hf_imgKey', $('imgKey').value);
  localStorage.setItem('hf_tripoKey', $('tripoKey').value);
}
function scheduleSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAll, 400);
}
// 关闭页面前把防抖中的配置 / 工作流立即写一次，避免最后几秒的修改丢失
window.addEventListener('beforeunload', () => {
  clearTimeout(saveTimer);
  try { saveAll(); } catch(e) {}
  try { clearTimeout(bpSaveTimer); if(bp) saveFlowNow(); } catch(e) {}
});
CFG.forEach(id => {
  const el = $(id);
  el.addEventListener('input', scheduleSave);
  el.addEventListener('change', scheduleSave);
});
$('llmKey').addEventListener('input', () => { scheduleSave(); updateStatusChips(); });
$('imgKey').addEventListener('input', () => { scheduleSave(); updateStatusChips(); });
$('tripoKey').addEventListener('input', () => { scheduleSave(); updateStatusChips(); });
$('genEngine').addEventListener('change', () => {
  syncEngineUI();
  scheduleSave();
});
$('tripoVersion').addEventListener('change', () => updateStatusChips());
$('btnTripoCheck').addEventListener('click', () => checkTripoKey());

