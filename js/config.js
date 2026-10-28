/* 配置持久化 / 本地中转 / 接口来源预设 / 生图中转站
 * 原 index.html 1336-1778 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
// 中转地址可用 ?relay=http://127.0.0.1:xxxx 覆盖（自动化测试指向自己的 mock 中转，
// 也方便多开一套中转时切换）
const RELAY_PARAM = (location.search.match(/[?&]relay=([^&]+)/) || [])[1];
const STORE_BASE = RELAY_PARAM ? decodeURIComponent(RELAY_PARAM).replace(/\/$/, '') : 'http://127.0.0.1:8787';
// 本地中转会把 hf_* 配置落盘；浏览器存储被清空或预览端口变化时，从这里回填
//
// ⚠️ 两个关键约束（2026-10-24 事故后加）：
// 1) localStorage 按 origin 隔离，同一个 index.html 用不同方式打开（file:// /
//    预览面板的随机端口 / TRAE 内置预览）就是**不同的源**，彼此的 localStorage 不互通，
//    而磁盘上 openagi-store.json 只有一份 → 谁后写谁赢。
//    所以 hf_flows 的写入与回填都必须**合并**（按流程 id 取较新版本），
//    否则任一源的一次写入都会抹掉其他源的流程。
// 2) 自动化测试一律加 ?nostore=1，禁止把测试产生的数据写进真实存储。
const STORE_SYNC_OFF = /(^|[?&])nostore=1(&|$)/.test(location.search);

// 合并两个工作流列表：按 id 归并，同 id 取 updated 更大的那份；两边都没有的保留
function mergeFlowLists(a, b){
  const pa = Array.isArray(a) ? a : [];
  const pb = Array.isArray(b) ? b : [];
  const map = new Map();
  const put = f => {
    if(!f || !f.id) return;
    const old = map.get(f.id);
    if(!old || (Number(f.updated) || 0) > (Number(old.updated) || 0)) map.set(f.id, f);
  };
  pa.forEach(put);
  pb.forEach(put);
  return Array.from(map.values()).sort((x, y) => (Number(y.updated) || 0) - (Number(x.updated) || 0));
}
function parseFlowList(str){
  try { const v = JSON.parse(str); return Array.isArray(v) ? v : null; } catch(e) { return null; }
}

(function(){
  const rawSet = Storage.prototype.setItem;
  const isHf = k => String(k).indexOf('hf_') === 0;

  // 所有 hf_* 写入同步到本地中转（中转没开时静默失败，不影响页面）
  Storage.prototype.setItem = function(k, v){
    rawSet.call(this, k, v);
    if(!isHf(k)) return;
    if(STORE_SYNC_OFF) return;
    try{
      if(String(v).length > 4 * 1024 * 1024) return;
      fetch(STORE_BASE + '/store/' + encodeURIComponent(k), { method:'POST', body:String(v), keepalive:true }).catch(() => {});
    }catch(e){}
  };

  // 异步读取落盘配置；中转可能比页面晚启动，因此带几次重试。
  // 只补齐本地缺失的键，不覆盖浏览器里已有的新值。
  // hf_flows 特殊处理：与本地列表**合并**（并把合并结果写回本地与磁盘）。
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
          if(k === 'hf_flows'){
            const disk = parseFlowList(data[k]);
            const mine = parseFlowList(localStorage.getItem('hf_flows'));
            let merged = null;
            if(disk && mine){
              merged = mergeFlowLists(mine, disk);
            }else if(disk && !mine){
              merged = disk;
            }
            if(merged){
              const js = JSON.stringify(merged);
              if(js !== localStorage.getItem('hf_flows')){
                rawSet.call(localStorage, 'hf_flows', js);
                filled++;
                // 合并结果回写磁盘，保证各源最终收敛到同一份
                if(!STORE_SYNC_OFF) fetch(STORE_BASE + '/store/' + encodeURIComponent(k), { method:'POST', body:js, keepalive:true }).catch(() => {});
              }
              // ⚠️ 关键：FLOWS 是在脚本加载时同步读 localStorage 的，
              // hydrate 是异步的 → 不刷新内存列表的话，界面仍然是空的，
              // 而且此后任何一次保存都会把「空列表」写回去，把磁盘上的流程抹掉。
              if(typeof FLOWS !== 'undefined' && Array.isArray(FLOWS)){
                const before = FLOWS.length;
                FLOWS = merged;
                // 合并进来的流程里可能带着存根（大块数据在 IndexedDB），要解析回原文
                if(typeof blobResolveFlowsAsync === 'function'){
                  blobResolveFlowsAsync(FLOWS).then(() => {
                    try { if(typeof renderFlowsWindow === 'function') renderFlowsWindow(); } catch(e){}
                  });
                }
                if(FLOWS.length !== before && typeof renderFlowsWindow === 'function'){
                  try { renderFlowsWindow(); } catch(e){}
                }
                /* 桌面对话的「上下文」下拉是按 FLOWS 生成的，
                   hydrate 是异步的 → 流程到位后要让它重画一次，否则下拉里永远是空的 */
                try { if(window.deskChat && typeof window.deskChat.refresh === 'function') window.deskChat.refresh(); } catch(e){}
              }
            }
            return;
          }
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
const CFG = ['llmBaseUrl','llmModel','llmThink','imgBaseUrl','imgEndpoint','imgModel','imgSize','respPath','sendImage','genEngine','tripoVersion','tripoWebUrl','relayUrl','relayOn'];
let saveTimer = null;

// ---- 本地中转（绕过服务商 CORS 限制）----
const RELAY_DEFAULT = 'http://127.0.0.1:8787';
function relayEnabled(){
  return !!($('relayOn') && $('relayOn').checked);
}
// 中转地址必须是 http(s) 地址。输入框里混进别的内容（比如一段提示词）时不能直接拿去发请求，
// 否则 relay 明明在跑，页面却报「中转未连接」——实际是请求打到了一个不存在的地址。
function isHttpUrl(s){ return /^https?:\/\/[^\s]+$/i.test(String(s || '').trim()); }
// 少写了协议头的域名（api.xxx.com/v1）自动补上，补不上（中文、空格等）才认为无效
function fixUrl(v){
  v = String(v || '').trim();
  if(!v) return '';
  if(isHttpUrl(v)) return v;
  if(!/^[\w.-]+(:\d+)?(\/\S*)?$/.test(v)) return '';
  return (/^(127\.0\.0\.1|localhost)(:|$|\/)/i.test(v) ? 'http://' : 'https://') + v;
}
function relayRaw(){
  return ($('relayUrl') && $('relayUrl').value.trim()) || '';
}
function relayBase(){
  const v = relayRaw();
  return (v && isHttpUrl(v) ? v : RELAY_DEFAULT).replace(/\/$/, '');
}
// 地址有问题时返回说明文字，没有问题返回 ''
function relayUrlIssue(){
  const v = relayRaw();
  if(!v) return '';
  return isHttpUrl(v) ? '' : '中转地址「' + v + '」不是合法的 http 地址，已改用默认 ' + RELAY_DEFAULT;
}
/* 本机引擎地址要透明地搬到 8794 的桥上。
 *
 * 实测（真页面、file:// 打开）：
 *   fetch('http://127.0.0.1:11434/api/tags')            → Failed to fetch
 *   fetch('http://127.0.0.1:11434/v1/chat/completions') → Failed to fetch
 * 控制台写得很清楚：origin 'null' 被 CORS 拒（Ollama 默认只放行 127.0.0.1 / localhost 来源）。
 * 也就是说 —— 设置里填 Ollama 的直连地址，本地对话和「中文提示词翻译」**一定会失败**，
 * 而用户看到的只是「语言模型没配好」，去设置里重填一遍仍然没用。
 *
 * 桥（8794）存在的唯一理由就是替浏览器绕开这件事，所以这里把地址搬过去。
 * 用户在设置里照旧填 http://127.0.0.1:11434/v1，一个字都不用改。 */
function bridgedEngineUrl(url){
  const s = String(url || '');
  const m = s.match(/^http:\/\/(?:127\.0\.0\.1|localhost):(11434|8188)\b/i);
  if(!m) return '';
  const base = (typeof rtBase === 'function') ? rtBase() : 'http://127.0.0.1:8794';
  const prefix = m[1] === '11434' ? '/ollama' : '/comfy';
  return s.replace(/^http:\/\/(?:127\.0\.0\.1|localhost):\d+/i, base + prefix);
}

function apiRequest(url, opts){
  const bridged = bridgedEngineUrl(url);
  if(bridged) url = bridged;
  // 本地助手（127.0.0.1 / localhost）不经过中转，避免被代理转发
  if(!relayEnabled() || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) return { url, init: opts || {} };
  const headers = Object.assign({}, (opts && opts.headers) || {}, { 'X-Relay-Target': url });
  return { url: relayBase() + '/proxy', init: Object.assign({}, opts || {}, { headers }) };
}
// 客户端重试：浏览器 fetch 抛 TypeError 说明请求根本没送达（网络瞬断 / 中转刚重启），
// 重试是安全的；上游返回 502/503/504（网关抖动）同样重试一次。
// 超时（AbortError）不重试——请求可能已在服务端执行中，重放会造成重复计费。
const API_RETRY_MAX = 2;
async function apiFetch(url, opts, timeoutMs){
  const ms = timeoutMs || 180000;
  const req = apiRequest(url, opts);
  let lastErr = null;
  for(let attempt = 0; attempt <= API_RETRY_MAX; attempt++){
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try{
      const res = await fetch(req.url, Object.assign({}, req.init, { signal: ctrl.signal }));
      if(res.status >= 502 && res.status <= 504 && attempt < API_RETRY_MAX){
        lastErr = new Error('HTTP ' + res.status);
        await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      return res;
    }catch(e){
      if(e && e.name === 'AbortError'){
        throw new Error('请求超时（' + Math.round(ms / 1000) + ' 秒）：服务商没有响应');
      }
      lastErr = e;
      if(attempt >= API_RETRY_MAX) throw e;
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }finally{
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('请求失败');
}

// ---- Tripo v3（图像编辑 / 3D 建模）----
const TRIPO_BASE = 'https://openapi.tripo3d.com/v3';
const TRIPO_IMAGE_MODELS = ['seedream_v5','banana_pro','banana2','chat_image_2.5_sunburst','chat_image_2.5_flare','chat_image_2'];
const isTripo = () => $('genEngine').value === 'tripo';
// 桌面版会把桥的端口告诉前端（8787/8790 被占用时会顺延），用 ?tripo= 覆盖
const TRIPO_PARAM = (location.search.match(/[?&]tripo=([^&]+)/) || [])[1];
const TRIPO_WEB_BASE = TRIPO_PARAM ? decodeURIComponent(TRIPO_PARAM).replace(/\/$/, '') : 'http://127.0.0.1:8790';
const isTripoWeb = () => $('genEngine').value === 'tripo-web';
/* 生图走本机 ComfyUI。判定只在 provider.js 的 imgMode() 里，这里只是薄封装——
 * 状态栏文案和实际执行的引擎必须来自同一个来源，否则会出现
 * 「显示 Tripo、其实在跑 ComfyUI」这种自相矛盾的提示。 */
const isLocalImg = () => typeof imgMode === 'function' && imgMode() === 'local';
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
/* 配置自愈：地址/尺寸这类字段被填进别的内容（误把提示词粘进来）时，
 * 不改掉的话请求会一直打到非法地址，表现为「服务明明开着却连不上」。
 * 只修格式明确不合法的字段；模型名这类自由文本只提示、不擅自改。 */
function sanitizeCfg(){
  const fixed = [], warned = [];
  const set = (id, val, why) => { $(id).value = val; fixed.push(why + '（原值「' + $(id).dataset.badVal + '」）'); };
  ['llmBaseUrl', 'imgBaseUrl', 'relayUrl'].forEach(id => {
    const v = $(id).value.trim();
    if(!v || isHttpUrl(v)) return;
    const name = id === 'relayUrl' ? '中转地址' : id === 'llmBaseUrl' ? '分析 Base URL' : '生图 Base URL';
    const ok = fixUrl(v);
    $(id).dataset.badVal = v;
    set(id, ok, ok ? name + '缺少协议头，已补全为 ' + ok : name + '不是 http(s) 地址，已清空');
  });
  const ep = $('imgEndpoint').value.trim();
  if(ep && ep[0] !== '/'){ $('imgEndpoint').dataset.badVal = ep; set('imgEndpoint', '/images/edits', '生图接口路径应以 / 开头，已恢复默认'); }
  const sz = $('imgSize').value.trim();
  if(sz && !/^\d{2,5}\s*[x×]\s*\d{2,5}$/i.test(sz)){ $('imgSize').dataset.badVal = sz; set('imgSize', '1024x1024', '图片尺寸格式应为 宽x高，已恢复默认'); }
  const rp = $('respPath').value.trim();
  if(rp && /[\u4e00-\u9fa5\s]/.test(rp)){ $('respPath').dataset.badVal = rp; set('respPath', 'data[0].url', '取图路径应是字段表达式（如 data[0].url），已恢复默认'); }
  ['llmModel', 'imgModel'].forEach(id => {
    const v = $(id).value.trim();
    if(v && /[\u4e00-\u9fa5\s]/.test(v)) warned.push((id === 'llmModel' ? '分析模型' : '生图模型') + '「' + v + '」不像模型 id，请到模型列表里点选');
  });
  return { fixed, warned };
}

function loadAll(){
  CFG.forEach(id => setInputValue($(id), loadKey(id)));
  setInputValue($('llmKey'), loadKey('llmKey'));
  setInputValue($('imgKey'), loadKey('imgKey'));
  setInputValue($('tripoKey'), loadKey('tripoKey'));
  try{
    const r = sanitizeCfg();
    if(r.fixed.length) saveAll();
    const msg = r.fixed.concat(r.warned).join('；');
    if(msg && typeof setStatus === 'function') setStatus('配置异常已处理：' + msg, 'warn');
  }catch(e){}
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

