/* 桌面 AI 对话：共享状态 / 模型清单 / 自绘下拉 / 配置弹层
 *
 * 原 js/desk-chat.js（2026-11-01 按职责拆成四个文件）：
 *   1) desk-chat-core.js  本文件：共享状态、模型清单、自绘下拉、模型/生图配置弹层
 *   2) desk-chat-log.js   上下文清单、附件条、消息渲染与持久化、存成流程
 *   3) desk-chat-gen.js   对话内生图的计划 / 出图 / 卡片动作
 *   4) desk-chat-send.js  顶部标签、输入模式、发送、init 与对外接口（最后加载）
 *
 * ⚠ 四个文件都是普通脚本顶层代码（原来的 IIFE 已拆掉）：状态和函数靠全局脚本
 *   作用域共享，等价于拆之前住在同一个闭包里。拆分只去掉两级缩进，逻辑未改；
 *   对外接口仍是 window.deskChat，入口顺序由 index.html 保证。
 */
let msgs = [];            // 对话历史 [{role, content}]，content 可以是字符串或含图片的数组
let atts = [];            // 待发送的图片附件（data URL）
let srcProbing = false;   // 正在为「引擎在不在跑」做一次真探测（见 send 的生图分支）

/* ---- 「对话 / 生图正在跑」的唯一真源 ----
 * 以前是一个裸布尔 `let busy`，5 处赋值散在 3 个文件里。两个真实缺陷：
 *   ① **嵌套被提前清零**：send() 里会 `await runGen()`（模型自己要求出图），
 *      runGen 的 finishGen 把布尔置 false 时**外层 send 还没跑完**，
 *      发送按钮已经解锁 —— 这时再点一次就是两条并发的 send。
 *   ② **没有任何地方能查出「谁漏了收尾」**：任一处忘了配 false 就是永久卡死，
 *      症状是「发不出消息」，而代码里看不出是谁干的。
 * 所以改成 计数（嵌套不误清） + 代次（按过「停止」之后，旧请求的退出一律作废）。
 *   写：只有 chatBusyEnter / chatBusyLeave / chatBusyReset；
 *   读：只有 isChatBusy()。别处直读写 busy 会被 tools/conf-guard.js 拦下。 */
let busyDepth = 0;      // 在途请求的层数：send 一层，它内部 await 的 runGen 再加一层
let busyEpoch = 0;      // 代次：cancelGen 换一代，旧代的 leave 不得影响新一轮
function isChatBusy(){ return busyDepth > 0; }
function chatBusyEnter(){
  busyDepth++;
  if(busyDepth === 1) lockSend(true);
  return busyEpoch;                 // 返回「票」：收尾时验代次
}
function chatBusyLeave(epoch){
  if(epoch !== busyEpoch) return;   // 旧代收尾：用户已按停止（或已开新一轮），别解锁别人的
  if(busyDepth > 0) busyDepth--;
  if(busyDepth === 0) lockSend(false);
}
/* 用户按「停止」：不再等任何在途请求，立刻回到可操作状态 */
function chatBusyReset(){
  busyEpoch++;
  busyDepth = 0;
  lockSend(false);
}
let opened = false;
let toastTimer = 0;

/* ---- 生图相关状态 ----
 * msgSeq：每条消息的唯一 id。图片卡片要按 id 局部更新——整段重绘会让 <img> 反复
 *   重建，出图过程中每秒闪一次。
 * genSeq：生图批次号。取消 / 重新生成时 +1，旧那批回来的结果一律丢弃。
 * chatImgMode：只决定「这条消息要不要出图」，不影响用哪个模型。 */
let msgSeq = 0;
let genSeq = 0;
let imgCtrl = null;
let lastImage = '';       // 最近一张生成图，作为「把刚才那张……」的参考图
let genTick = 0;
let chatImgMode = 'auto'; // auto | image | chat
let refineOn = true;      // 提示词改写：口语 → 可生图的描述
let webSearchOn = false;  // 联网搜索：这一轮回答前先去搜一遍（默认关）

const CTX_KEY = 'hf_desk_ctx';
const MODEL_KEY = 'hf_desk_model';
const IMG_MODE_KEY = 'hf_desk_imgmode';
const REFINE_KEY = 'hf_desk_imgrefine';
const WEB_KEY = 'hf_desk_websearch';

/* 教模型「它其实能出图」。模型不该假装自己画不了，也不该编图片链接；
   由它写提示词、由系统真正去调生图模型，是唯一不会说谎的分工。 */
const IMG_SYS = '你还接了一个生图模型：当用户想要的是一张图（文生图），或想修改一张图（图生图）时，'
  + '不要说自己画不了、不要输出图片链接或 Markdown 图片、也不要在正文里宣称"已经生成好了"。'
  + '做法：用一句话说明你打算画什么，然后在回复的最后单独一行输出一个 JSON 对象：\n'
  + '{"type":"image","prompt":"<完整画面描述：主体 / 动作 / 环境 / 光线 / 风格>","mode":"text"}\n'
  + '用户给了参考图并要求修改时 mode 用 "image"。其他话题照常回答，不要输出这一行。';


function el(id){ return document.getElementById(id); }

/* ---------- 轻提示（bpToast 的元素在蓝图视图里，桌面用不了） ---------- */
function deskToast(msg){
  let t = el('deskToast');
  if(!t){
    t = document.createElement('div');
    t.id = 'deskToast';
    t.className = 'desk-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg || '';
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ---------- 模型清单 ---------- */
async function modelOptions(){
  const out = [];
  // 云端网关目录
  if(typeof gwLogged === 'function' && gwLogged()){
    let list = (typeof gwModels !== 'undefined' && Array.isArray(gwModels)) ? gwModels : [];
    if(!list.length && typeof gwLoadModels === 'function'){
      try{ list = await gwLoadModels(); }catch(e){ list = []; }
    }
    (list || []).forEach(m => out.push({ value: 'gw:' + m.id, label: m.label || m.id, group: '云端模型' }));
  }
  // 自定义接口：设置里已读取的清单 + 当前填的模型名
  try{
    const base = confGet('llmBaseUrl').replace(/\/$/, '');
    const cache = (typeof MODEL_CACHE !== 'undefined' && MODEL_CACHE) ? MODEL_CACHE : { base:'', list:[] };
    const ids = new Set();
    if(cache.base === base) (cache.list || []).forEach(m => ids.add(m.id));
    const cur = confGet('llmModel');
    if(cur) ids.add(cur);
    ids.forEach(id => out.push({ value: 'local:' + id, label: id, group: '自定义接口' }));
  }catch(e){}
  // Ollama 本地已安装模型
  try{
    if(typeof rtRefresh === 'function') await rtRefresh();
    const p = providerFor('llm', 'ollama-llm');
    if(p && p.status && p.status()){
      const ms = await p.listModels();
      (ms || []).forEach(m => out.push({ value: 'oll:' + m.id, label: m.id, group: 'Ollama 本地' }));
    }
  }catch(e){ /* 本地引擎没起就当没有本地模型 */ }
  return out;
}

/* ---------- 生图模型清单 ----------
 *
 * 和语言模型分开列，因为**它们写进的地方不一样**：
 *   语言模型 → localStorage 的 hf_desk_model（只影响这一条输入框）
 *   生图模型 → 真正生效的配置（本地写 mc_comfy_ckpt，在线写 hf_imgModel）
 *
 * 为什么在线这一侧要写 hf_imgModel 而不是自己存一份：
 * 生图链路只认设置页那几个字段（一律经 config.js 的 confImg() 读），
 * 这里另存一份就会出现「下拉显示的是 A、实际出图用的是 B」——最难查的那种不一致。
 *
 * 只有两类来源：
 *   本地 ComfyUI → 桥上问 /comfy/object_info/CheckpointLoaderSimple 拿 ckpt 清单
 *   在线接口     → IMG_MODEL_CACHE（设置页「读取生图模型」时已经存过）
 *
 * ⚠ **这里没有 Tripo**（2026-10-29 用户明确要求）：
 * Tripo 在本项目里是**独立的网页操作节点**（tripoImg / tripoModel / tripoModelMulti），
 * 不是「对话生图时挑一个模型」这件事的一部分。
 * 而且 Tripo 的模型选择有自己的位置：
 *   - 网页版（tripo-web）：模型在 Tripo 网页里选，wfTripoWebImage 根本不读 imgModel；
 *   - API 版：设置页有专门的 renderTripoImageModels()（js/api.js）负责。
 * 把 Tripo 塞进这个下拉会造成两个问题：
 *   ① 选了也不生效（网页版那条路压根不看 imgModel）；
 *   ② 与设置页的 Tripo 模型 UI 各存一份，两边必然对不上。
 */
/* 引擎当前是不是 Tripo（API 版 tripo / 网页版 tripo-web）。
 *
 * 两种都算「Tripo 走网页操作节点」：模型选择在 Tripo 页面里选（网页版）
 * 或设置页的 Tripo 模型区选（API 版），都不是这个下拉该管的事。 */
function tripoEngineActive(){
  try{
    const v = $('genEngine').value;
    return v === 'tripo' || v === 'tripo-web';
  }catch(e){ return false; }
}

async function imgModelOptions(){
  const out = [];

  /* ---- 本地 ComfyUI：ckpt 清单 ---- */
  try{
    if(typeof rtRefresh === 'function') await rtRefresh();
    const p = providerFor('image', 'comfy-image');
    if(p && p.status && p.status()){
      const list = await p.listModels();          // provider 已封装 /comfy/object_info
      /* provider 统一返回 { id, owned_by }（和云端清单同构），
       * 但老 provider 可能直接给字符串数组——两种都认。 */
      (list || []).forEach(m => {
        const id = (m && typeof m === 'object') ? (m.id || '') : String(m || '');
        if(id) out.push({ value: 'comfy:' + id, label: id, group: '本地 ComfyUI' });
      });
    }
  }catch(e){ /* 引擎没起就没有本地模型，不算错误 */ }

  /* ---- 在线接口：设置页读过的生图模型清单 ---- */
  try{
    const base = (confGet('imgBaseUrl') || confGet('llmBaseUrl')).replace(/\/$/, '');
    const cache = (typeof IMG_MODEL_CACHE !== 'undefined' && IMG_MODEL_CACHE) ? IMG_MODEL_CACHE : { base:'', list:[] };
    const ids = new Set();
    if(cache.base === base) (cache.list || []).forEach(m => ids.add(m.id));
    const cur = confGet('imgModel');
    if(cur) ids.add(cur);
    ids.forEach(id => out.push({ value: 'online:' + id, label: id, group: '在线接口' }));
  }catch(e){}

  return out;
}

/* 下拉当前选中项的存储值。
 *
 * 存在哪取决于**当前生图来源**：
 *   本地 → mc_comfy_ckpt（provider.js 读的键）
 *   在线 → hf_imgModel（设置页的生图模型字段）
 *
 * ⚠ 不处理 Tripo：Tripo 是独立的网页操作节点，模型选择有它自己的位置
 *   （网页版在 Tripo 页面里选，API 版在设置页的 renderTripoImageModels 里选）。
 *   引擎停在 Tripo 时这个下拉不参与，返回空让它显示占位文字。 */
function currentImgModelValue(){
  try{
    const mode = (typeof imgMode === 'function') ? imgMode() : 'online';
    if(mode === 'local'){
      const ck = (typeof comfyCkptChoice === 'function') ? comfyCkptChoice() : '';
      if(ck) return 'comfy:' + ck;
    }
    /* 引擎停在 Tripo 上时，imgModel 由设置页的 Tripo 模型 UI 管，
       这个下拉不参与（避免两处各存一份、必然对不上）。 */
    if(tripoEngineActive()) return '';
    const m = confGet('imgModel');
    if(m) return 'online:' + m;
  }catch(e){}
  return '';
}

/* 选中某个生图模型 → 写进真正生效的那处配置。
 *
 * 写完必须让设置页与页头标签同步：设置页的输入框直接被改了（用户看得见），
 * 页头的「生图 · xxx」也要跟着变（否则用户不知道实际会用哪个）。 */
function applyImgModel(value){
  const v = String(value || '');
  const i = v.indexOf(':');
  if(i < 0) return false;
  const src = v.slice(0, i);
  const name = v.slice(i + 1);
  if(!name) return false;
  try{
    if(src === 'comfy'){
      if(typeof setComfyCkpt !== 'function') return false;
      setComfyCkpt(name);
      /* 本地生图走 imgMode()=='local' 这条路，与 genEngine 无关。 */
      if(typeof setImgMode === 'function') setImgMode('local');
    }else{
      /* 在线写 hf_imgModel。引擎必须切到 openai —— 否则「引擎还停在 Tripo」
       * 时会把请求发给 Tripo，而不是用户刚选的在线接口。
       * genEngine 是生图引擎的总开关（openai / tripo / tripo-web）。 */
      const field = $('imgModel');
      if(!field) return false;
      field.value = name;
      const eng = $('genEngine');
      if(eng && eng.value !== 'openai'){
        eng.value = 'openai';
        eng.dispatchEvent(new Event('change', { bubbles: true }));  // 触发 syncEngineUI + scheduleSave
      }
      if(typeof setImgMode === 'function') setImgMode('online');
      try{ localStorage.setItem('hf_imgModel', name); }catch(e){}
      /* 设置页的模型高亮与标签要跟着走 */
      try{
        if(typeof syncModelActive === 'function') syncModelActive('img');
        if(typeof updateModelLabels === 'function') updateModelLabels();
      }catch(e){}
    }
  }catch(e){ return false; }
  renderImgLabel();
  return true;
}

async function renderModelSelect(){
  const sel = el('deskAiModel');
  if(!sel) return;
  const list = await modelOptions();
  const saved = (function(){ try{ return localStorage.getItem(MODEL_KEY) || ''; }catch(e){ return ''; } })();
  let cur = saved;
  if(!list.some(o => o.value === cur)) cur = list.length ? list[0].value : '';
  sel.innerHTML = '';
  if(!list.length){
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '未配置模型';
    sel.appendChild(o);
    sel.disabled = true;
  }else{
    sel.disabled = false;
    const groups = new Map();
    list.forEach(o => {
      if(!groups.has(o.group)) groups.set(o.group, []);
      groups.get(o.group).push(o);
    });
    groups.forEach((items, name) => {
      const g = document.createElement('optgroup');
      g.label = name;
      items.forEach(o => {
        const op = document.createElement('option');
        op.value = o.value;
        op.textContent = o.label;
        g.appendChild(op);
      });
      sel.appendChild(g);
    });
    sel.value = cur;
    try{ localStorage.setItem(MODEL_KEY, cur); }catch(e){}
    /* 首次渲染时这里会写入默认模型（localStorage 里原本可能是空的）。
     * 这时候要通知预热器：模型清单刚从桥上问回来，这是「对话选中本地模型」
     * 这件事第一次成立的时刻——不通知的话，预热器会一直空等到轮询超时。 */
    try{ window.dispatchEvent(new CustomEvent('hf-desk-model-changed')); }catch(e){}
  }
  renderChatModelLabel();
  syncPicker('model');
}

/* 生图模型下拉：把清单填进 select，保留当前选中项。
 *
 * 保留不了当前项的情况有两种，都得处理：
 *   ① 当前来源是本地，但引擎没起 → 清单里没有本地 ckpt，
 *      此时**不能**把选中项改掉（用户选的模型仍然有效，
 *      只是引擎没跑而已）；所以先把当前值塞回去，引擎起来后再刷。
 *   ② 用户从没选过 → 取第一个可用的。 */
async function renderImgModelSelect(){
  const sel = el('deskAiImgModel');
  if(!sel) return;
  const list = await imgModelOptions();
  const cur = currentImgModelValue();
  sel.innerHTML = '';

  /* 引擎停在 Tripo 上：这个下拉不参与（Tripo 是独立的网页操作节点，
     模型选择在 Tripo 页面 / 设置页的 Tripo 模型区）。
     给一条说明而不是留空 —— 空下拉会让人以为功能坏了。 */
  const tripoMode = tripoEngineActive();
  if(tripoMode){
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'Tripo（网页节点）';
    sel.appendChild(o);
    sel.disabled = true;
    syncPicker('imgmodel');
    const btn = el('deskAiImgBtn');
    if(btn) btn.title = '当前引擎是 Tripo：它是独立的网页操作节点，模型在 Tripo 页面里选';
    return;
  }

  if(!list.length){
    const o = document.createElement('option');
    o.value = cur || '';
    o.textContent = '没有可用生图模型';
    sel.appendChild(o);
    sel.disabled = true;
  }else{
    sel.disabled = false;
    const groups = new Map();
    list.forEach(o => {
      if(!groups.has(o.group)) groups.set(o.group, []);
      groups.get(o.group).push(o);
    });
    groups.forEach((items, name) => {
      const g = document.createElement('optgroup');
      g.label = name;
      items.forEach(o => {
        const op = document.createElement('option');
        op.value = o.value;
        op.textContent = o.label;
        g.appendChild(op);
      });
      sel.appendChild(g);
    });
    /* 当前值不在清单里也保留它（引擎没起 / 清单没读），只是加一个提示项。
     * 强行跳到第一个可用项 = 用户选的模型被悄悄换掉，是最难查的一类问题。 */
    if(cur && !list.some(o => o.value === cur)){
      const g = document.createElement('optgroup');
      g.label = '当前选择';
      const op = document.createElement('option');
      op.value = cur;
      op.textContent = cur.slice(cur.indexOf(':') + 1) + '（当前）';
      g.appendChild(op);
      sel.appendChild(g);
    }
    sel.value = cur || (list.length ? list[0].value : '');
  }
  syncPicker('imgmodel');
}

function renderChatModelLabel(){
  const box = el('deskChatModel');
  if(!box) return;
  const sel = el('deskAiModel');
  const v = sel && sel.value ? sel.value : '';
  const label = sel && sel.selectedOptions.length ? sel.selectedOptions[0].textContent : '';
  const src = v.indexOf(':') >= 0 ? v.slice(0, v.indexOf(':')) : '';
  const tag = src === 'gw' ? '云端' : src === 'oll' ? 'Ollama' : src === 'local' ? '自定义' : '';
  box.textContent = label ? (tag ? tag + ' · ' + label : label) : '未选择模型';
}

/* ---------- 自绘下拉 ----------
 * 原生 <select> 的弹层是操作系统画的（蓝底高亮、行高、分组标题都改不了），
 * 所以只把它当「值容器」藏起来，露在外面的是 .dai-pick 按钮 + 挂到 body 的 .dai-menu。
 * 点选项 → 写回 select → 派发 change，原有 change 监听（存 localStorage、刷新页头标签）照常跑。
 */
const PICKERS = {};
const SRC_LABEL = { gw: '云端', oll: 'Ollama', local: '自定义' };

/* 菜单底部第二行：直接打开**当前站的官网**。
 * 只在「已经配过在线接口、且这个地址能对上官网」时出现 ——
 * 刚起步的用户先看到的是「配置自定义云端生图」，配过的人看到的是「去官网充值 / 看新模型」。
 * Tripo 模式下不给（引擎是 Tripo，在线接口的站不是当前在用的东西）。 */
function imgSiteMenuEntry(){
  try{
    if(tripoEngineActive()) return null;
    const base = (confGet('imgBaseUrl')
      || confGet('llmBaseUrl') || '');
    const s = imgSiteFor(base);
    if(!s) return null;
    const a = document.createElement('a');
    a.className = 'dai-menu-cfg dai-menu-site';
    a.id = 'daiImgSiteOpen';
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = '在浏览器打开 ' + s.url + '（注册 / 建 Key / 看报价）';
    a.textContent = '打开 ' + s.name + ' 官网 ↗';
    a.addEventListener('click', () => { closeMenus(); });
    return a;
  }catch(e){ return null; }
}

function initPicker(key, cfg){
  const sel = el(cfg.sel), btn = el(cfg.btn);
  if(!sel || !btn) return;
  const p = { key, sel, btn, label: el(cfg.label), tag: cfg.tag ? el(cfg.tag) : null, menu: null, cfg };
  PICKERS[key] = p;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if(p.menu && !p.menu.classList.contains('hidden')) closeMenu(key);
    else openMenu(key);
  });
  btn.addEventListener('keydown', e => {
    if(e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' '){ e.preventDefault(); openMenu(key); }
  });
  syncPicker(key);
}

function menuEl(p){
  if(p.menu) return p.menu;
  const m = document.createElement('div');
  m.className = 'dai-menu hidden';
  m.setAttribute('role', 'listbox');
  document.body.appendChild(m);
  p.menu = m;
  return m;
}

function tickSvg(){
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'dai-menu-tick');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M3 8.4 6.4 12 13 4.5');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.9');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

function menuItem(p, opt){
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'option');
  b.dataset.value = opt.value;
  const on = opt.value === p.sel.value;
  b.className = 'dai-menu-item' + (on ? ' is-on' : '');
  b.setAttribute('aria-selected', on ? 'true' : 'false');
  const t = document.createElement('span');
  t.className = 'dai-menu-txt';
  t.textContent = opt.textContent;
  t.title = opt.textContent;
  b.append(t, tickSvg());
  b.addEventListener('click', () => {
    if(p.sel.value !== opt.value){
      p.sel.value = opt.value;
      /* storeKey 是可选的：语言模型 / 上下文存 localStorage，
       * 而生图模型存的是**合成前缀值**（comfy: / online: / tripo:），
       * 真正生效的位置由 applyImgModel 决定 —— 另存一份必然对不上。 */
      if(p.cfg.storeKey){
        try{ localStorage.setItem(p.cfg.storeKey, opt.value); }catch(e){}
      }
      p.sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeMenus();
    syncPicker(p.key);
  });
  return b;
}

function buildMenu(p){
  const m = menuEl(p);
  m.innerHTML = '';
  const body = document.createElement('div');
  body.className = 'dai-menu-body';
  const groups = Array.from(p.sel.querySelectorAll('optgroup'));
  if(!p.sel.options.length){
    const e = document.createElement('div');
    e.className = 'dai-menu-empty';
    e.textContent = p.cfg.empty || '暂无可选项';
    body.appendChild(e);
  }else if(groups.length){
    groups.forEach(g => {
      const h = document.createElement('div');
      h.className = 'dai-menu-group';
      h.textContent = g.label;
      body.appendChild(h);
      Array.from(g.children).forEach(o => body.appendChild(menuItem(p, o)));
    });
  }else{
    Array.from(p.sel.options).forEach(o => body.appendChild(menuItem(p, o)));
  }
  m.appendChild(body);
  if(p.cfg.config){
    const foot = document.createElement('div');
    foot.className = 'dai-menu-foot';
    foot.appendChild(configEntry(
      p.cfg.configLabel || '配置自定义模型',
      p.cfg.onConfig,
      p.cfg.configId || 'daiCfgOpen'
    ));
    /* 可选第二行（生图模型：直接去当前站的官网）。返回 null 就不占位。 */
    const extra = (typeof p.cfg.footEntry === 'function') ? p.cfg.footEntry() : null;
    if(extra) foot.appendChild(extra);
    m.appendChild(foot);
  }
  return m;
}

function placeMenu(p){
  const m = p.menu;
  const r = p.btn.getBoundingClientRect();
  // 模型下拉贴着右边缘，弹层也右对齐；上下文在左侧，左对齐更自然
  m.style.minWidth = Math.round(Math.max(p.cfg.align === 'right' ? 252 : 224, r.width)) + 'px';
  m.style.left = '0px';
  m.style.top = '0px';
  const mw = m.offsetWidth, mh = m.offsetHeight, gap = 8, pad = 10;
  const vw = window.innerWidth, vh = window.innerHeight;
  const rawLeft = p.cfg.align === 'right' ? (r.right - mw) : r.left;
  m.style.left = Math.round(Math.min(Math.max(pad, rawLeft), Math.max(pad, vw - mw - pad))) + 'px';
  // 输入条贴着底边，弹层优先向上展开；上方放不下才翻到下面
  let top = r.top - mh - gap;
  if(top < pad) top = Math.min(r.bottom + gap, vh - mh - pad);
  m.style.top = Math.round(Math.max(pad, top)) + 'px';
}

function openMenu(key){
  const p = PICKERS[key];
  if(!p) return;
  closeMenus(key);
  const m = buildMenu(p);
  m.classList.remove('hidden');
  p.btn.classList.add('is-open');
  p.btn.setAttribute('aria-expanded', 'true');
  placeMenu(p);
  const on = m.querySelector('.dai-menu-item.is-on');
  if(on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
}

function closeMenu(key){
  const p = PICKERS[key];
  if(!p) return;
  if(p.menu) p.menu.classList.add('hidden');
  p.btn.classList.remove('is-open');
  p.btn.setAttribute('aria-expanded', 'false');
}

function closeMenus(except){
  Object.keys(PICKERS).forEach(k => { if(k !== except) closeMenu(k); });
}

/* 触发器上的文字 / 来源角标跟着 select 走；菜单开着时同步重建（勾选状态要跟着变） */
function syncPicker(key){
  const p = PICKERS[key];
  if(!p) return;
  const o = (p.sel.selectedOptions && p.sel.selectedOptions.length) ? p.sel.selectedOptions[0] : null;
  const text = o ? o.textContent : '';
  if(p.label) p.label.textContent = text || (p.cfg.placeholder || '未选择');
  if(p.tag){
    const v = p.sel.value || '';
    const i = v.indexOf(':');
    const src = i >= 0 ? v.slice(0, i) : '';
    if(SRC_LABEL[src]){
      p.tag.hidden = false;
      p.tag.textContent = SRC_LABEL[src];
      p.tag.dataset.src = src;
    }else{
      p.tag.hidden = true;
      p.tag.removeAttribute('data-src');
    }
  }
  p.btn.classList.toggle('is-empty', !p.sel.value);
  p.btn.title = (p.cfg.title || '选择') + (text ? '：' + text : '');
  if(p.menu && !p.menu.classList.contains('hidden')){ buildMenu(p); placeMenu(p); }
}

/* ---------- 配置外接大模型 ----------
 * 写的就是设置页那三个字段（llmBaseUrl / llmKey / llmModel），保存即等于在设置里改过，
 * 工作流里的 LLM 节点也会跟着用新接口，不是只影响桌面这一条输入框。
 */
function cfgField(label, id, opt){
  const box = document.createElement('label');
  box.className = 'dai-cfg-field';
  const t = document.createElement('span');
  t.textContent = label;
  const inp = document.createElement('input');
  inp.type = (opt && opt.password) ? 'password' : 'text';
  inp.id = id;
  inp.placeholder = (opt && opt.ph) || '';
  inp.autocomplete = 'off';
  inp.spellcheck = false;
  box.append(t, inp);
  return box;
}

function buildModelCfg(){
  const mask = document.createElement('div');
  mask.id = 'daiCfgMask';
  mask.className = 'dai-cfg-mask hidden';

  const card = document.createElement('div');
  card.className = 'dai-cfg';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', '配置自定义模型');

  const head = document.createElement('div');
  head.className = 'dai-cfg-head';
  const title = document.createElement('span');
  title.textContent = '配置自定义模型';
  const sub = document.createElement('span');
  sub.className = 'dai-cfg-sub';
  sub.textContent = '任意 OpenAI 兼容接口';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'dai-cfg-x';
  x.textContent = '×';
  x.setAttribute('aria-label', '关闭');
  x.addEventListener('click', closeModelCfg);
  head.append(title, sub, x);

  const body = document.createElement('div');
  body.className = 'dai-cfg-body';
  body.append(
    cfgField('接口地址（Base URL）', 'daiCfgBase', { ph: 'https://api.example.com/v1' }),
    cfgField('API Key', 'daiCfgKey', { ph: 'sk-…', password: true }),
    cfgField('模型名称', 'daiCfgModel', { ph: 'deepseek-chat / qwen-plus …' })
  );
  const list = document.createElement('div');
  list.className = 'dai-cfg-list';
  list.id = 'daiCfgList';
  const hint = document.createElement('div');
  hint.className = 'dai-cfg-hint';
  hint.id = 'daiCfgHint';
  hint.textContent = '填好地址和 Key 后点「读取模型」，可从服务商返回的清单里点选；也可以直接手填模型名。';
  const err = document.createElement('div');
  err.className = 'dai-cfg-err hidden';
  err.id = 'daiCfgErr';
  body.append(list, hint, err);

  const foot = document.createElement('div');
  foot.className = 'dai-cfg-foot';
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'btn sm';
  test.id = 'daiCfgTest';
  test.textContent = '读取模型';
  test.addEventListener('click', cfgReadModels);
  const grow = document.createElement('span');
  grow.className = 'grow';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn sm';
  cancel.id = 'daiCfgCancel';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeModelCfg);
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn primary sm';
  save.id = 'daiCfgSave';
  save.textContent = '保存并使用';
  save.addEventListener('click', cfgSave);
  foot.append(test, grow, cancel, save);

  card.append(head, body, foot);
  mask.appendChild(card);
  mask.addEventListener('pointerdown', e => { if(e.target === mask) closeModelCfg(); });
  mask.addEventListener('keydown', e => {
    if(e.key === 'Enter' && e.target && e.target.tagName === 'INPUT'){ e.preventDefault(); cfgSave(); }
  });
  document.body.appendChild(mask);
  return mask;
}

function openModelCfg(){
  closeMenus();
  const mask = el('daiCfgMask') || buildModelCfg();
  const base = confGet('llmBaseUrl');
  const key = confGet('llmKey');
  const model = confGet('llmModel');
  el('daiCfgBase').value = base;
  el('daiCfgKey').value = key;
  el('daiCfgModel').value = model;
  el('daiCfgList').innerHTML = '';
  el('daiCfgHint').textContent = '填好地址和 Key 后点「读取模型」，可从服务商返回的清单里点选；也可以直接手填模型名。';
  cfgErr('');
  mask.classList.remove('hidden');
  setTimeout(() => { try{ el('daiCfgBase').focus(); }catch(e){} }, 60);
}

function closeModelCfg(){
  const mask = el('daiCfgMask');
  if(mask) mask.classList.add('hidden');
}

function cfgErr(msg){
  const box = el('daiCfgErr');
  if(!box) return;
  box.textContent = msg || '';
  box.classList.toggle('hidden', !msg);
}

function cfgValues(){
  return {
    base: (el('daiCfgBase').value || '').trim(),
    key: (el('daiCfgKey').value || '').trim(),
    model: (el('daiCfgModel').value || '').trim()
  };
}

/* 写回设置页字段，并派发 input（让预设同步、状态胶囊、防抖保存都跑起来） */
function cfgPush(){
  const v = cfgValues();
  const fixed = (typeof fixUrl === 'function' ? fixUrl(v.base) : '') || v.base;
  if($('llmBaseUrl')) $('llmBaseUrl').value = fixed;
  if($('llmKey')) $('llmKey').value = v.key;
  if($('llmModel')) $('llmModel').value = v.model;
  ['llmBaseUrl', 'llmKey', 'llmModel'].forEach(id => {
    const n = $(id);
    if(n) n.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return { base: fixed, key: v.key, model: v.model };
}

async function cfgReadModels(){
  const v = cfgValues();
  cfgErr('');
  if(!v.base){ cfgErr('先填接口地址，例如 https://api.example.com/v1'); return; }
  if(!v.key){ cfgErr('先填 API Key'); return; }
  cfgPush();
  const btn = el('daiCfgTest');
  const hint = el('daiCfgHint');
  const box = el('daiCfgList');
  btn.disabled = true;
  btn.textContent = '读取中…';
  if(hint) hint.textContent = '正在请求 ' + v.base.replace(/\/$/, '') + '/models …';
  try{
    if(typeof loadModels === 'function') await loadModels();
    const base = v.base.replace(/\/$/, '');
    const cache = (typeof MODEL_CACHE !== 'undefined' && MODEL_CACHE) ? MODEL_CACHE : null;
    const list = (cache && cache.base === base && Array.isArray(cache.list)) ? cache.list : [];
    box.innerHTML = '';
    const cur = (el('daiCfgModel').value || '').trim();
    list.slice(0, 80).forEach(m => {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'dai-cfg-chip' + (m.id === cur ? ' on' : '');
      c.textContent = m.id;
      c.addEventListener('click', () => {
        el('daiCfgModel').value = m.id;
        Array.from(box.children).forEach(n => n.classList.toggle('on', n === c));
      });
      box.appendChild(c);
    });
    if(hint){
      hint.textContent = list.length
        ? '已读到 ' + list.length + ' 个模型，点上面的名字填入（也可以自己敲）。'
        : '没读到模型清单：' + (($('modelStatus') && $('modelStatus').textContent) || '接口没有返回模型 id') + '。手填模型名也能用。';
    }
  }catch(e){
    cfgErr('读取失败：' + (e && e.message || e));
  }finally{
    btn.disabled = false;
    btn.textContent = '读取模型';
  }
}

function cfgSave(){
  const v = cfgValues();
  cfgErr('');
  if(!/^https?:\/\/[^\s]+$/i.test((typeof fixUrl === 'function' ? fixUrl(v.base) : '') || v.base)){
    cfgErr('接口地址要以 http:// 或 https:// 开头');
    return;
  }
  if(!v.key){ cfgErr('请填写 API Key'); return; }
  if(!v.model){ cfgErr('请填写模型名称'); return; }
  const w = cfgPush();
  try{ if(typeof saveAll === 'function') saveAll(); }catch(e){}
  if(typeof updateStatusChips === 'function') updateStatusChips();
  try{ localStorage.setItem(MODEL_KEY, 'local:' + w.model); }catch(e){}
  closeModelCfg();
  const want = 'local:' + w.model;
  Promise.resolve(renderModelSelect()).then(() => {
    const sel = el('deskAiModel');
    if(sel && Array.from(sel.options).some(o => o.value === want)){
      sel.value = want;
      renderChatModelLabel();
      syncPicker('model');
    }
    deskToast('已接入自定义模型 ' + w.model);
  }).catch(() => deskToast('配置已保存，模型清单刷新失败'));
}

/* 菜单底部那一行「＋ 配置自定义…」。
 * 语言模型与生图模型共用这一个构造函数，只换文案与点击动作（id 也随之区分，
 * 否则同一时刻两个菜单都在 DOM 里时 getElementById 会拿错那个）。 */
function configEntry(label, onOpen, id){
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dai-menu-cfg';
  b.id = id || 'daiCfgOpen';
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p1 = document.createElementNS(NS, 'path');
  p1.setAttribute('d', 'M12 5.5v13M5.5 12h13');
  svg.appendChild(p1);
  const t = document.createElement('span');
  t.textContent = label || '配置自定义模型';
  b.append(svg, t);
  b.addEventListener('click', e => {
    e.stopPropagation();
    if(typeof onOpen === 'function') onOpen();
    else openModelCfg();
  });
  return b;
}

/* ---------- 配置自定义云端生图（中转站） ----------
 *
 * 落点和「配置自定义模型」一样：写的全是设置页那几个字段
 * （imgBaseUrl / imgKey / imgModel / imgEndpoint / imgSize），保存即等于在设置里改过，
 * 节点里的「图像生成」立刻走新站——不另存一份，避免「下拉 A、出图 B」。
 *
 * 为什么必须补这个入口：生图模型下拉的「在线接口」组来自 IMG_MODEL_CACHE，
 * 用户没去设置页配过接口时它是空的，下拉里就只剩本地 ckpt，看着像「云端生图没做」。
 * 语言模型下拉早就挂着「配置自定义模型」，两边不对称更会让人以为生图那边没这能力。
 *
 * 中转站兼容性（实测记录见 LOCAL-ENGINES.md「云端生图中转站」一节）：
 * 绝大多数是 OpenAI 兼容的 /images/generations + /images/edits，Key 走 Bearer，
 * 差异只有三处 —— ① gpt-image 系恒返回 b64_json 且不接受 response_format；
 * ② 部分站（Kunavo 等）图生图只收 JSON、不收 multipart；③ banana 系的 size
 * 既收 1024x1024，也收 1:1 / 2K 这类档位串。所以「端点 / 尺寸」直接露在弹层里，
 * 而不是逼用户回设置页翻「高级参数」。
 */
const IMG_CFG_FIELDS = ['imgBaseUrl', 'imgKey', 'imgModel', 'imgEndpoint', 'imgSize'];

function imgPresetList(){
  try{
    const groups = (typeof IMG_PRESET_GROUPS !== 'undefined' && IMG_PRESET_GROUPS) ? IMG_PRESET_GROUPS : [];
    /* 组内展开并带上组名，弹层里按组排一行，用户一眼看出「中转站 / 官方直连」 */
    return groups.reduce((acc, g) => acc.concat((g.items || []).map(it => Object.assign({ group: g.label }, it))), []);
  }catch(e){ return []; }
}

/* 「这个地址该去哪个官网拿 Key？」
 *
 * 优先级：命中预设 → 用预设里登记的官网；否则退回 Base URL 的 origin
 * （任意站都能给出一个可点的地址，用户不用自己去搜）。
 * 本机地址没有官网可去 —— 给 127.0.0.1 一个「打开官网」的链接纯属骗人，直接不给。
 */
function imgSiteFor(base){
  const b = String(base || '').trim().replace(/\/$/, '');
  const hit = imgPresetList().find(p => (p.base || '').replace(/\/$/, '') === b);
  if(hit && hit.site) return { url: hit.site, name: hit.name };
  if(!/^https?:\/\//i.test(b)) return null;
  try{
    const u = new URL(b);
    if(!u.hostname) return null;
    if(/^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(u.hostname)) return null;
    return { url: u.origin, name: u.hostname.replace(/^www\./i, '') };
  }catch(e){ return null; }
}

/* 「还没有 Key？打开 xx 官网 ↗」——中转站都要先去官网注册、建 Key、充值，
 * 让用户自己回去搜站名是最没必要的摩擦。地址留空（复用分析接口）时
 * 指向分析侧那家；都拿不到就整行隐藏，不摆一个点不动的死链。 */
function renderImgSite(){
  const row = el('daiImgCfgGetKey');
  const a = el('daiImgCfgSite');
  if(!row || !a || !el('daiImgCfgBase')) return;
  const base = (el('daiImgCfgBase').value || '').trim()
    || ((confGet('llmBaseUrl') || ''));
  const s = imgSiteFor(base);
  if(!s){
    row.classList.add('hidden');
    a.removeAttribute('href');
    a.textContent = '';
    return;
  }
  row.classList.remove('hidden');
  a.href = s.url;
  a.textContent = '打开 ' + s.name + ' 官网 ↗';
  a.title = '在浏览器打开 ' + s.url + ' · 注册账号并创建 API Key（本应用不保存账号密码）';
}

function buildImgCfg(){
  const mask = document.createElement('div');
  mask.id = 'daiImgCfgMask';
  mask.className = 'dai-cfg-mask hidden';

  const card = document.createElement('div');
  card.className = 'dai-cfg';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', '配置自定义云端生图');

  const head = document.createElement('div');
  head.className = 'dai-cfg-head';
  const title = document.createElement('span');
  title.textContent = '配置自定义云端生图';
  const sub = document.createElement('span');
  sub.className = 'dai-cfg-sub';
  sub.textContent = 'OpenAI 兼容生图接口 / 中转站';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'dai-cfg-x';
  x.textContent = '×';
  x.setAttribute('aria-label', '关闭');
  x.addEventListener('click', closeImgCfg);
  head.append(title, sub, x);

  const body = document.createElement('div');
  body.className = 'dai-cfg-body';

  /* 来源芯片：点一下就填好地址 + 模型 + 端点，省掉手敲一长串 URL */
  const srcBox = document.createElement('div');
  srcBox.className = 'dai-cfg-field';
  const srcLab = document.createElement('span');
  srcLab.textContent = '快捷选择（中转站 / 官方直连）';
  const chips = document.createElement('div');
  chips.className = 'dai-cfg-list';
  chips.id = 'daiImgCfgSrc';
  srcBox.append(srcLab, chips);

  /* 「还没有 Key？」紧跟 Key 输入框：中转站的 Key 只能去它自己官网建，
     这一行就是「访问官网」的落点——用户不用回设置页、也不用自己去搜站名。 */
  const getKey = document.createElement('div');
  getKey.className = 'dai-cfg-getkey';
  getKey.id = 'daiImgCfgGetKey';
  const getKeyTxt = document.createElement('span');
  getKeyTxt.textContent = '还没有 Key？';
  const site = document.createElement('a');
  site.id = 'daiImgCfgSite';
  site.className = 'dai-cfg-site';
  site.target = '_blank';
  site.rel = 'noopener noreferrer';
  getKey.append(getKeyTxt, site);

  body.append(
    srcBox,
    cfgField('接口地址（Base URL）', 'daiImgCfgBase', { ph: 'https://api.example.com/v1' }),
    cfgField('API Key', 'daiImgCfgKey', { ph: 'sk-…（留空则复用分析侧 Key）', password: true }),
    getKey,
    cfgField('生图模型', 'daiImgCfgModel', { ph: 'nano-banana-2.1 / gpt-image-1 / seedream_v5 …' })
  );

  const row = document.createElement('div');
  row.className = 'dai-cfg-row';
  const epField = cfgField('生图端点', 'daiImgCfgEndpoint', { ph: '/images/edits' });
  const sizeField = cfgField('尺寸', 'daiImgCfgSize', { ph: '1024x1024' });
  row.append(epField, sizeField);
  body.appendChild(row);

  const list = document.createElement('div');
  list.className = 'dai-cfg-list';
  list.id = 'daiImgCfgList';
  const hint = document.createElement('div');
  hint.className = 'dai-cfg-hint';
  hint.id = 'daiImgCfgHint';
  hint.textContent = '填好地址和 Key 后点「读取模型」，可从该站返回的清单里点选；也可以直接手填模型名。';
  /* 价目参考只写量级，不写死单站报价——中转站调价比模型还快，写死了就是错误信息 */
  const priceNote = document.createElement('div');
  priceNote.className = 'dai-cfg-hint';
  priceNote.textContent = '成本口径：中转站多按张计价（banana 系约 ¥0.05–0.35/张），官方接口按 token 计（2K 输出约 $0.05–0.14/张）。以站内实时价格为准。';
  const err = document.createElement('div');
  err.className = 'dai-cfg-err hidden';
  err.id = 'daiImgCfgErr';
  body.append(list, hint, priceNote, err);

  const foot = document.createElement('div');
  foot.className = 'dai-cfg-foot';
  const read = document.createElement('button');
  read.type = 'button';
  read.className = 'btn sm';
  read.id = 'daiImgCfgRead';
  read.textContent = '读取模型';
  read.addEventListener('click', imgCfgReadModels);
  const grow = document.createElement('span');
  grow.className = 'grow';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn sm';
  cancel.id = 'daiImgCfgCancel';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeImgCfg);
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn primary sm';
  save.id = 'daiImgCfgSave';
  save.textContent = '保存并使用';
  save.addEventListener('click', imgCfgSave);
  foot.append(read, grow, cancel, save);

  card.append(head, body, foot);
  mask.appendChild(card);
  mask.addEventListener('pointerdown', e => { if(e.target === mask) closeImgCfg(); });
  mask.addEventListener('keydown', e => {
    if(e.key === 'Enter' && e.target && e.target.tagName === 'INPUT'){ e.preventDefault(); imgCfgSave(); }
  });
  /* 手工改地址时官网链接要跟着走（命中预设给登记官网，否则给 origin）。
     ⚠ 必须挂在 appendChild 之后：挂之前 `el()` 在 document 里还查不到这些节点。 */
  document.body.appendChild(mask);
  el('daiImgCfgBase').addEventListener('input', renderImgSite);
  return mask;
}

function openImgCfg(){
  closeMenus();
  const mask = el('daiImgCfgMask') || buildImgCfg();
  el('daiImgCfgBase').value = confGet('imgBaseUrl');
  el('daiImgCfgKey').value = confGet('imgKey');
  el('daiImgCfgModel').value = confGet('imgModel');
  el('daiImgCfgEndpoint').value = confGet('imgEndpoint') || '/images/edits';
  el('daiImgCfgSize').value = confGet('imgSize') || '1024x1024';
  el('daiImgCfgList').innerHTML = '';
  el('daiImgCfgHint').textContent = '填好地址和 Key 后点「读取模型」，可从该站返回的清单里点选；也可以直接手填模型名。';
  imgCfgErr('');
  renderImgCfgChips();
  renderImgSite();
  mask.classList.remove('hidden');
  setTimeout(() => {
    const node = el('daiImgCfgBase').value ? el('daiImgCfgModel') : el('daiImgCfgBase');
    try{ node.focus(); }catch(e){}
  }, 60);
}

function closeImgCfg(){
  const mask = el('daiImgCfgMask');
  if(mask) mask.classList.add('hidden');
}

function imgCfgErr(msg){
  const box = el('daiImgCfgErr');
  if(!box) return;
  box.textContent = msg || '';
  box.classList.toggle('hidden', !msg);
}

/* 芯片：第一枚「复用分析接口」，中间是各中转站/官方直连，最后一枚「自定义」。
 * 点芯片只**填字段**，不落盘——用户还得点「保存并使用」，避免点错一下就改了线上配置。 */
function renderImgCfgChips(){
  const box = el('daiImgCfgSrc');
  if(!box) return;
  box.innerHTML = '';
  const curBase = (el('daiImgCfgBase').value || '').trim().replace(/\/$/, '');

  const mk = (label, onPick, on) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'dai-cfg-chip' + (on ? ' on' : '');
    c.textContent = label;
    c.addEventListener('click', () => {
      onPick();
      Array.from(box.children).forEach(n => n.classList.toggle('on', n === c));
      renderImgSite();      // 换了站 → 「打开 xx 官网」跟着换
    });
    box.appendChild(c);
  };

  mk('复用分析接口', () => {
    el('daiImgCfgBase').value = '';
    el('daiImgCfgEndpoint').value = '/images/edits';
    el('daiImgCfgHint').textContent = '留空即沿用分析侧 Base URL；图像 Key 留空时也复用分析侧 Key。';
  }, !curBase);

  imgPresetList().forEach(p => {
    const base = (p.base || '').replace(/\/$/, '');
    /* 芯片只写名字：带上「约 $0.027/张」会把一排芯片撑成三四行，
       而价格适合读、不适合扫。价格的去处是 hint —— 点中之后才看细节。 */
    mk(p.name, () => {
      el('daiImgCfgBase').value = base;
      if(p.model) el('daiImgCfgModel').value = p.model;
      el('daiImgCfgEndpoint').value = p.endpoint || '/images/edits';
      if(p.size) el('daiImgCfgSize').value = p.size;
      const price = p.price ? ('计费：' + p.price + '，以站内实时为准。') : '';
      el('daiImgCfgHint').textContent = price + (p.note || ('接口 ' + base));
      /* 该站没给端点/尺寸偏好时保持当前值，别把用户手改过的参数冲掉 */
    }, !!curBase && base === curBase);
  });

  mk('自定义', () => {
    el('daiImgCfgHint').textContent = '直接填任意 OpenAI 兼容站的 Base URL（一般以 /v1 结尾），Key 填该站的 sk-…';
    try{ el('daiImgCfgBase').focus(); }catch(e){}
  }, !!curBase && !imgPresetList().some(p => (p.base || '').replace(/\/$/, '') === curBase));
}

function imgCfgValues(){
  return {
    base: (el('daiImgCfgBase').value || '').trim(),
    key: (el('daiImgCfgKey').value || '').trim(),
    model: (el('daiImgCfgModel').value || '').trim(),
    endpoint: (el('daiImgCfgEndpoint').value || '').trim(),
    size: (el('daiImgCfgSize').value || '').trim()
  };
}

/* 写回设置页字段并派发 input（预设同步、状态胶囊、防抖保存都靠这些监听） */
function imgCfgPush(){
  const v = imgCfgValues();
  const fixed = (typeof fixUrl === 'function' ? fixUrl(v.base) : '') || v.base;
  const ep = v.endpoint || '/images/edits';
  if($('imgBaseUrl')) $('imgBaseUrl').value = fixed;
  if($('imgKey')) $('imgKey').value = v.key;
  if($('imgModel')) $('imgModel').value = v.model;
  if($('imgEndpoint')) $('imgEndpoint').value = ep.charAt(0) === '/' ? ep : '/' + ep;
  if($('imgSize')) $('imgSize').value = v.size || '1024x1024';
  IMG_CFG_FIELDS.forEach(id => {
    const n = $(id);
    if(n) n.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return {
    base: fixed.replace(/\/$/, ''),
    key: v.key,
    model: v.model,
    endpoint: ep,
    size: v.size || '1024x1024'
  };
}

async function imgCfgReadModels(){
  const v = imgCfgValues();
  imgCfgErr('');
  if(!v.base && !confGet('llmBaseUrl')){
    imgCfgErr('先填接口地址，例如 https://api.example.com/v1；或点「复用分析接口」');
    return;
  }
  if(!v.key && !confGet('llmKey')){
    imgCfgErr('先填 API Key（留空时需要有分析侧 Key 可复用）');
    return;
  }
  imgCfgPush();
  const btn = el('daiImgCfgRead');
  const hint = el('daiImgCfgHint');
  const box = el('daiImgCfgList');
  btn.disabled = true;
  btn.textContent = '读取中…';
  if(hint) hint.textContent = '正在请求 ' + (v.base || '分析侧地址').replace(/\/$/, '') + '/models …';
  try{
    if(typeof loadImgModels === 'function') await loadImgModels();
    const base = ((v.base || confGet('imgBaseUrl') || confGet('llmBaseUrl')) || '').replace(/\/$/, '');
    const cache = (typeof IMG_MODEL_CACHE !== 'undefined' && IMG_MODEL_CACHE) ? IMG_MODEL_CACHE : null;
    const list = (cache && cache.base === base && Array.isArray(cache.list)) ? cache.list : [];
    box.innerHTML = '';
    const cur = (el('daiImgCfgModel').value || '').trim();
    list.slice(0, 80).forEach(m => {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'dai-cfg-chip' + (m.id === cur ? ' on' : '');
      c.textContent = m.id;
      c.addEventListener('click', () => {
        el('daiImgCfgModel').value = m.id;
        Array.from(box.children).forEach(n => n.classList.toggle('on', n === c));
      });
      box.appendChild(c);
    });
    if(hint){
      hint.textContent = list.length
        ? '已读到 ' + list.length + ' 个模型，点上面的名字填入（生图模型常混在对话模型里，挑带 image / banana / flux / seedream 字样的）。'
        : '没读到模型清单：' + (($('imgModelStatus') && $('imgModelStatus').textContent) || '接口没有返回模型 id') + '。手填模型名也能用。';
    }
  }catch(e){
    imgCfgErr('读取失败：' + (e && e.message || e));
  }finally{
    btn.disabled = false;
    btn.textContent = '读取模型';
  }
}

function imgCfgSave(){
  const v = imgCfgValues();
  imgCfgErr('');
  const fixed = (typeof fixUrl === 'function' ? fixUrl(v.base) : '') || v.base;
  /* 地址可以留空（=复用分析侧），留空时分析侧必须已经有地址 */
  const effBase = fixed.replace(/\/$/, '') || (confGet('llmBaseUrl') || '').replace(/\/$/, '');
  if(!effBase){
    imgCfgErr('请填接口地址，或点「复用分析接口」（那样需要分析侧已经配好 Base URL）');
    return;
  }
  if(!/^https?:\/\/[^\s]+$/i.test(effBase)){
    imgCfgErr('接口地址要以 http:// 或 https:// 开头');
    return;
  }
  if(!v.model){ imgCfgErr('请填写生图模型名，例如 nano-banana-2.1 / gpt-image-1'); return; }
  const w = imgCfgPush();

  /* 引擎总开关必须切回 openai：停在 Tripo 时请求会发给 Tripo，而不是刚配的站 */
  try{
    const eng = $('genEngine');
    if(eng && eng.value !== 'openai'){
      eng.value = 'openai';
      eng.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }catch(e){}
  if(typeof setImgMode === 'function') setImgMode('online');
  try{ localStorage.setItem('hf_imgModel', w.model); }catch(e){}
  /* 清单里补一条，否则刚配好的模型会落进「当前选择」这个临时分组 */
  try{
    if(typeof IMG_MODEL_CACHE !== 'undefined' && IMG_MODEL_CACHE){
      if(IMG_MODEL_CACHE.base !== w.base) IMG_MODEL_CACHE = { base: w.base, list: [] };
      if(!IMG_MODEL_CACHE.list.some(m => m && m.id === w.model)) IMG_MODEL_CACHE.list.push({ id: w.model, owned_by: '' });
    }
  }catch(e){}
  try{ if(typeof saveAll === 'function') saveAll(); }catch(e){}
  try{ if(typeof updateStatusChips === 'function') updateStatusChips(); }catch(e){}

  closeImgCfg();
  try{ window.dispatchEvent(new CustomEvent('hf-img-source-changed')); }catch(e){}

  const want = 'online:' + w.model;
  Promise.resolve(renderImgModelSelect()).then(() => {
    const sel = el('deskAiImgModel');
    if(sel && Array.from(sel.options).some(o => o.value === want)){
      if(sel.value !== want){
        sel.value = want;
        sel.dispatchEvent(new Event('change', { bubbles: true }));   // → applyImgModel
      }
    }
    syncPicker('imgmodel');
    renderImgLabel();
    deskToast('已接入云端生图 ' + w.model + '（' + (w.base || '复用分析接口') + '）');
  }).catch(() => deskToast('配置已保存，生图模型刷新失败'));
}