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
// delSet（可选）：被删除流程的 id 集合（墓碑）。凡是进了墓碑的，合并时一律排除——
// 否则多源 union 会把磁盘上还没清掉的旧副本并回来，造成「删了又复活」。
function mergeFlowLists(a, b, delSet){
  const pa = Array.isArray(a) ? a : [];
  const pb = Array.isArray(b) ? b : [];
  const map = new Map();
  const put = f => {
    if(!f || !f.id) return;
    if(delSet && delSet.has(f.id)) return;          // 墓碑：已删除的绝不再回来
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
// 删除墓碑是字符串 id 数组（不是流程对象），单独一套解析
function parseIdList(str){
  try { const v = JSON.parse(str); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch(e){ return []; }
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
            // 删除墓碑：本地 + 磁盘两边都看，合并去重 —— 这样「别的源删的」当前源也能收到，
            // 当前源删的也不会因为磁盘上还有旧副本而被并回
            // （2026-10-29 用户实测：删一个刷新又恢复，根因就是 union 把磁盘旧副本并了回来）
            const delMine = parseIdList(localStorage.getItem('hf_flows_del'));
            const delDisk = parseIdList(data['hf_flows_del']);
            const del = new Set([...(delMine || []), ...(delDisk || [])]);
            let merged = null;
            if(disk && mine){
              merged = mergeFlowLists(mine, disk, del);
            }else if(disk && !mine){
              merged = (disk || []).filter(f => f && !del.has(f.id));
            }
            if(merged){
              const js = JSON.stringify(merged);
              if(js !== localStorage.getItem('hf_flows')){
                rawSet.call(localStorage, 'hf_flows', js);
                filled++;
                // 合并结果回写磁盘，保证各源最终收敛到同一份
                if(!STORE_SYNC_OFF) fetch(STORE_BASE + '/store/' + encodeURIComponent(k), { method:'POST', body:js, keepalive:true }).catch(() => {});
              }
              // 墓碑集也回写：让各源最终收敛到同一份删除记录，别让已删的在某源死灰复燃
              if(del.size){
                const delJs = JSON.stringify(Array.from(del));
                if(delJs !== localStorage.getItem('hf_flows_del')){
                  rawSet.call(localStorage, 'hf_flows_del', delJs);
                  if(!STORE_SYNC_OFF) fetch(STORE_BASE + '/store/hf_flows_del', { method:'POST', body:delJs, keepalive:true }).catch(() => {});
                }
              }
              // ⚠️ 关键：FLOWS 是在脚本加载时同步读 localStorage 的，
              // hydrate 是异步的 → 不刷新内存列表的话，界面仍然是空的，
              // 而且此后任何一次保存都会把「空列表」写回去，把磁盘上的流程抹掉。
              if(typeof FLOWS !== 'undefined' && Array.isArray(FLOWS)){
                const before = FLOWS.length;
                FLOWS = merged;
                // 流程状态已确认：此后 persistFlows 的「空列表防抹」安全网不再生效，
                // 用户删光工作流必须落盘，否则删除会在下次加载时复活
                if(typeof markFlowsLoaded === 'function') markFlowsLoaded();
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
          // hf_flows_del 由上面的 hf_flows 分支统一读取 / 回填，这里不再单独处理
          if(k === 'hf_flows_del') return;
          if(localStorage.getItem(k) == null){ rawSet.call(localStorage, k, data[k]); filled++; }
        }catch(e){}
      });
      if(filled && typeof loadAll === 'function'){
        loadAll();
        if(typeof syncEngineUI === 'function') syncEngineUI();
        if(typeof updateStatusChips === 'function') updateStatusChips();
        /* loadAll 是**直接赋值** value，不触发 change 事件 → 依赖「当前选中来源」
         * 的显隐不会自己跟上：磁盘里明明是 SearXNG，界面上却只露出 DDG 的说明，
         * 看起来就像设置没保存。这里补一次同步。 */
        if(typeof syncWsUI === 'function') syncWsUI();
        if(typeof updateModelLabels === 'function') updateModelLabels();
      }
      if(filled) return;
    }
  }
  hydrate();
})();

const $ = id => document.getElementById(id);
const loadKey = k => localStorage.getItem('hf_' + k);

// ---- 配置持久化 ----
const CFG = ['llmBaseUrl','llmModel','llmThink','imgBaseUrl','imgEndpoint','imgModel','imgSize','respPath','sendImage','genEngine','tripoVersion','tripoWebUrl','relayUrl','relayOn','wsProvider','wsBase','wsCount'];
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
// 可选字段：endpoint（图生图端点）、size（该站习惯的尺寸写法）、note（弹层里的一句话说明）
// ⚠ price 只是下单时的参考，价格变得比模型还快，别在别处再抄一遍、更别当承诺。
const IMG_PRESET_GROUPS = [
  { label: '生图中转站', items: [
    { name: 'Crazyrouter', base: 'https://cn.crazyrouter.com/v1', model: 'nano-banana', price: '约 $0.02/张', site: 'https://crazyrouter.com',
      note: 'Banana 系按张计价，图生图走 multipart /images/edits；size 也收 1:1 / 2K 这类档位串。' },
    { name: 'Kunavo', base: 'https://api.kunavo.com/v1', model: 'nano-banana', price: '约 $0.027/张', site: 'https://kunavo.com',
      note: '这家图生图只收 JSON（image 传 base64），端点要改成 /images/generations 或按站内文档填。' },
    { name: 'API易', base: 'https://api.apiyi.com/v1', model: 'gemini-3.1-flash-lite-image', price: '约 $0.025/张起', site: 'https://apiyi.com',
      note: 'Gemini 图像模型（banana 系）多档位，尺寸习惯写 1K / 2K / 4K 或 1024x1024。' },
    { name: 'AIHubMix', base: 'https://aihubmix.com/ai/v1', model: 'gemini-nano-banana-2.1', price: '按 token 计费', site: 'https://aihubmix.com',
      note: '按 token 计费，单张成本随分辨率变；2.1 的 2K/4K 输出比 1K 贵一截。' }
  ] },
  { label: '官方直连', items: [
    { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-image-1', price: '按质量计费', site: 'https://platform.openai.com',
      endpoint: '/images/generations', size: '1024x1024',
      note: 'gpt-image 系只认 1024x1024 / 1024x1536 / 1536x1024，恒返回 b64_json 且不接受 response_format；图生图用 /images/edits（multipart）。' },
    { name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Kwai-Kolors/Kolors', price: '', site: 'https://cloud.siliconflow.cn',
      note: '国内直连，Flux / Kolors 系；size 按该站文档写，别照抄 OpenAI 的三种。' }
  ] }
];
const IMG_PRESETS = IMG_PRESET_GROUPS.flatMap(g => g.items);

/* 设置页的「访问官网」一行：**每一类来源都给链接**（原来只列中转站，
   官方直连那两家反而要用户自己去搜）。去官网注册、建 Key、充值，
   顺手看清报价；价格以站内为准，这里只作提示。 */
function renderImgPresetLinks(){
  const box = $('imgPresetLinks');
  if(!box) return;
  box.innerHTML = '';
  const lab = document.createElement('span');
  lab.className = 'pl-label';
  lab.textContent = '访问官网（注册 / 建 Key / 看报价）：';
  box.appendChild(lab);
  IMG_PRESET_GROUPS.forEach(g => (g.items || []).forEach(p => {
    if(!p.site) return;
    const a = document.createElement('a');
    a.href = p.site;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = p.name + (p.price ? ' ' + p.price : '') + ' ↗';
    a.title = '打开 ' + p.name + ' 官网' + (p.price ? '（' + p.price + '，以站内实时价格为准）' : '');
    box.appendChild(a);
  }));
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
  /* Key / 地址输入框已经挪到对话输入条的配置弹层里，这里不再提示「填入 Key」 */
  $('modelStatus').textContent = '点「读取模型」拉取这个站点的清单';
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
      /* 端点/尺寸按该站的脾气来：gpt-image 只认三种固定尺寸，
         banana 系还收 1:1、2K 这类档位串，统一写 1024x1024 会有一半的站不认。 */
      $('imgEndpoint').value = p.endpoint || '/images/edits';
      if(p.size) $('imgSize').value = p.size;
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
    ? '沿用分析侧地址与 Key；点「读取模型」拉清单'
    : (p.base
      ? `已选择 ${p.name}${p.model ? ' · ' + p.model : ''}；点「读取模型」拉清单`
      : '该站还没配地址，去「去配置」里填');
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
$('imgModel').addEventListener('change', () => {
  syncModelActive('img'); updateModelLabels();
  /* 生图模型名改了，对话那边的下拉与标签要跟着变。
   * 挂 change 而不是 input：input 每敲一个字符就派发一次，
   * 而对话那边要去问引擎拿清单（一次网络往返），敲「seedream」会打 8 次。 */
  try{ window.dispatchEvent(new CustomEvent('hf-img-source-changed')); }catch(e){}
});
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
  setInputValue($('wsKey'), loadKey('wsKey'));
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
  localStorage.setItem('hf_wsKey', $('wsKey').value);
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
  /* 生图引擎换了（openai / tripo / tripo-web），对话那边的生图模型下拉与
   * 「生图 · xxx」标签都要跟着换 —— 不通知的话，界面上两处显示的模型会对不上。 */
  try{ window.dispatchEvent(new CustomEvent('hf-img-source-changed')); }catch(e){}
});
$('tripoVersion').addEventListener('change', () => updateStatusChips());
$('btnTripoCheck').addEventListener('click', () => checkTripoKey());


// ---- 联网搜索（对话用）----
/* 三个来源的差别只在「要填什么」：bing / ddg 什么都不用，searxng 要地址，tavily 要 Key。
   所以按选中的来源只露对应的输入框，而不是把三个框全摆出来让人猜哪个生效。 */
function syncWsUI(){
  const sel = $('wsProvider');
  const p = (sel && sel.value) || 'bing';
  const baseBox = $('wsBaseBox'), keyBox = $('wsKeyBox');
  if(baseBox) baseBox.classList.toggle('hidden', p !== 'searxng');
  if(keyBox) keyBox.classList.toggle('hidden', p !== 'tavily');
}
if($('wsProvider')) $('wsProvider').addEventListener('change', () => { syncWsUI(); scheduleSave(); });
if($('wsKey')) $('wsKey').addEventListener('input', () => scheduleSave());
if($('wsCount')) $('wsCount').addEventListener('input', () => scheduleSave());
syncWsUI();

if($('btnTestSearch')) $('btnTestSearch').addEventListener('click', async () => {
  const box = $('wsStatus');
  const btn = $('btnTestSearch');
  if(typeof deskSearch === 'undefined'){ if(box) box.textContent = '搜索模块（desk-search.js）没加载'; return; }
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '搜索中…';
  saveAll();            // 先落盘：deskSearch 读的是 localStorage，不是输入框
  if(box) box.textContent = '正在检索「OpenAGI 是什么」…';
  try{
    /* force：测试按钮是**用户主动要求再试一次**，必须绕过失败熔断，
     * 否则刚改完设置点「测试搜索」还是回放上次的旧错误。 */
    const r = await deskSearch.run('OpenAGI 是什么', { force: true });
    if(!box) return;
    if(r.ok){
      box.textContent = '来源 ' + deskSearch.labelOf(r.provider) + ' · ' + r.ms + 'ms · 取回 ' + r.results.length + ' 条'
        + (r.results.length ? '：' + r.results.slice(0, 2).map(x => x.title).join(' / ') : '（0 条，换来源或换关键词再试）');
    }else{
      box.textContent = '搜索失败（' + deskSearch.labelOf(r.provider) + '）：' + r.error;
    }
  }finally{
    btn.disabled = false;
    btn.textContent = old;
  }
});
