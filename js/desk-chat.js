/* 桌面 AI 对话条（红框区）与右侧聊天面板
 *
 * 组成：
 *   1) 底部输入条：附件按钮、上下文选择、模型选择、麦克风、发送。
 *   2) 右侧聊天面板：发送后滑入，桌面图标整体左移（= 工作台向左滚动）。
 *
 * 连接来源与模型清单沿用既有约定，不另起一套：
 *   - 云端网关：gwConn() 的 base/key，模型目录 gwModels。
 *   - 自定义接口：设置里的 llmBaseUrl / llmKey，模型清单 MODEL_CACHE。
 *   - Ollama 本地：runtime 桥的 /ollama/v1（OpenAI 兼容端点），模型清单 api/tags。
 * 选定模型时通过 llmStreamRequest 的 opts.conn 覆盖本次连接，
 * 不去改设置里的全局模型，避免「在桌面选了个模型、设置页却被改掉」。
 */
(function(){
  let msgs = [];            // 对话历史 [{role, content}]，content 可以是字符串或含图片的数组
  let atts = [];            // 待发送的图片附件（data URL）
  let busy = false;
  let srcProbing = false;   // 正在为「引擎在不在跑」做一次真探测（见 send 的生图分支）
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
      const base = ($('llmBaseUrl').value || '').trim().replace(/\/$/, '');
      const cache = (typeof MODEL_CACHE !== 'undefined' && MODEL_CACHE) ? MODEL_CACHE : { base:'', list:[] };
      const ids = new Set();
      if(cache.base === base) (cache.list || []).forEach(m => ids.add(m.id));
      const cur = ($('llmModel').value || '').trim();
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
   * 生图链路只认设置页那几个字段（wfImage 直接读 $('imgModel').value），
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
      const base = ($('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim()).replace(/\/$/, '');
      const cache = (typeof IMG_MODEL_CACHE !== 'undefined' && IMG_MODEL_CACHE) ? IMG_MODEL_CACHE : { base:'', list:[] };
      const ids = new Set();
      if(cache.base === base) (cache.list || []).forEach(m => ids.add(m.id));
      const cur = ($('imgModel').value || '').trim();
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
      const m = ($('imgModel').value || '').trim();
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
      const base = (($('imgBaseUrl') && $('imgBaseUrl').value.trim())
        || ($('llmBaseUrl') && $('llmBaseUrl').value.trim()) || '');
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
    const base = $('llmBaseUrl') ? $('llmBaseUrl').value.trim() : '';
    const key = $('llmKey') ? $('llmKey').value.trim() : '';
    const model = $('llmModel') ? $('llmModel').value.trim() : '';
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
      || ((($('llmBaseUrl') && $('llmBaseUrl').value.trim()) || ''));
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
    el('daiImgCfgBase').value = $('imgBaseUrl') ? $('imgBaseUrl').value.trim() : '';
    el('daiImgCfgKey').value = $('imgKey') ? $('imgKey').value.trim() : '';
    el('daiImgCfgModel').value = $('imgModel') ? $('imgModel').value.trim() : '';
    el('daiImgCfgEndpoint').value = ($('imgEndpoint') && $('imgEndpoint').value.trim()) || '/images/edits';
    el('daiImgCfgSize').value = ($('imgSize') && $('imgSize').value.trim()) || '1024x1024';
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
    if(!v.base && !($('llmBaseUrl') && $('llmBaseUrl').value.trim())){
      imgCfgErr('先填接口地址，例如 https://api.example.com/v1；或点「复用分析接口」');
      return;
    }
    if(!v.key && !($('llmKey') && $('llmKey').value.trim())){
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
      const base = ((v.base || $('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim()) || '').replace(/\/$/, '');
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
    const effBase = fixed.replace(/\/$/, '') || (($('llmBaseUrl') && $('llmBaseUrl').value.trim()) || '').replace(/\/$/, '');
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

  /* ---------- 上下文清单 ---------- */
  function contextOptions(){
    const out = [{ value: 'none', label: '无上下文' }];
    (typeof FLOWS !== 'undefined' ? FLOWS : []).forEach(f => {
      out.push({ value: 'flow:' + f.id, label: (f.name || '未命名工作流') });
    });
    try{
      if(typeof Editor !== 'undefined' && Editor.selection && Editor.selection.size){
        out.push({ value: 'selection', label: '画布选中 ' + Editor.selection.size + ' 项' });
      }
    }catch(e){}
    return out;
  }

  function renderContextSelect(){
    const sel = el('deskAiCtx');
    if(!sel) return;
    const list = contextOptions();
    let cur = '';
    try{ cur = localStorage.getItem(CTX_KEY) || ''; }catch(e){}
    if(!list.some(o => o.value === cur)) cur = 'none';
    sel.innerHTML = '';
    list.forEach(o => {
      const op = document.createElement('option');
      op.value = o.value;
      op.textContent = o.label;
      sel.appendChild(op);
    });
    sel.value = cur;
    try{ localStorage.setItem(CTX_KEY, cur); }catch(e){}
    syncPicker('ctx');
  }

  function contextText(value){
    if(!value || value === 'none') return '';
    if(value === 'selection'){
      let names = [];
      try{
        if(typeof bp !== 'undefined' && bp && typeof Editor !== 'undefined'){
          names = Array.from(Editor.selection).map(id => {
            const n = (bp.nodes || []).find(x => x.id === id);
            if(!n) return null;
            const t = (typeof NODE_DEFS !== 'undefined' && NODE_DEFS[n.type]) ? NODE_DEFS[n.type].title : n.type;
            return t;
          }).filter(Boolean);
        }
      }catch(e){}
      if(!names.length) return '';
      return '当前上下文：画布上选中的节点 —— ' + names.join('、');
    }
    const fid = value.slice(5);
    let f = null;
    try{ f = (typeof FLOWS !== 'undefined' ? FLOWS : []).find(x => x.id === fid); }catch(e){}
    if(!f) return '';
    let d = null;
    try{ d = describeFlow(f); }catch(e){}
    if(!d) return '当前上下文：工作流「' + (f.name || '未命名') + '」';
    let s = '当前上下文：工作流「' + d.title + '」（' + d.stats + '）';
    if(d.types && d.types.length) s += '；节点类型：' + d.types.join('、');
    return s;
  }

  /* ---------- 连接 ---------- */
  function connFor(value){
    const v = value || '';
    const i = v.indexOf(':');
    const src = i >= 0 ? v.slice(0, i) : 'local';
    const id = i >= 0 ? v.slice(i + 1) : v;
    if(src === 'gw'){
      return { base: gwBase() + '/v1', key: gwToken(), model: id, via: 'gateway' };
    }
    if(src === 'oll'){
      return { base: rtBase() + '/ollama/v1', key: 'ollama', model: id, via: 'ollama' };
    }
    return {
      base: ($('llmBaseUrl').value || '').trim().replace(/\/$/, ''),
      key: ($('llmKey').value || '').trim(),
      model: id,
      via: 'local'
    };
  }

  /* ---------- 附件 ---------- */
  function renderAtts(){
    const box = el('deskAiAtts');
    if(!box) return;
    box.innerHTML = '';
    atts.forEach((src, i) => {
      const chip = document.createElement('span');
      chip.className = 'dai-chip';
      const img = document.createElement('img');
      img.src = src;
      img.alt = '附件 ' + (i + 1);
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'dai-chip-x';
      x.textContent = '×';
      x.title = '移除附件';
      x.addEventListener('click', () => { atts.splice(i, 1); renderAtts(); });
      chip.append(img, x);
      box.appendChild(chip);
    });
  }

  /* ---------- 消息渲染 ---------- */
  /* 行缓存：流式聊天每收一片就 renderLog 一次，如果每次都重建全部行，
     之前那些生成图（dataURL 动辄几 MB）的 <img> 也会跟着重新挂载，
     一轮对话下来光解码就能把帧率拖垮。签名没变的行直接复用原节点。 */
  const rowCache = new Map();      // mid -> { el, sig }

  function msgSig(m){
    if(m.kind === 'image') return 'img|' + (m.phase || '') + '|' + (m.image ? 1 : 0) + '|' + (m.error ? 1 : 0) + '|' + (m.content || '').length;
    const c = m.content;
    const cSig = Array.isArray(c)
      ? c.map(p => p.type === 'text' ? 't:' + String(p.text || '').length : 'i').join(',')
      : String(c == null ? '' : c);
    /* 来源列表在正文之外单独渲染，签名里也要带上：不带的话，流式回复结束后
       补上的来源永远画不出来（行被判定为「没变」而直接复用旧节点）。 */
    const srcSig = (m.sources && m.sources.length)
      ? m.sources.map(s => s.url).join('|').length + '#' + m.sources.length
      : '';
    return 'txt|' + cSig + '|' + (m.error ? 1 : 0) + '|' + (m.reasoning ? m.reasoning.length : 0)
      + '|' + srcSig + '|' + (m.searchNote ? m.searchNote.length : 0);
  }

  function buildRow(m){
    const isUser = m.role === 'user';
    const row = document.createElement('div');
    row.className = 'dchat-msg ' + (isUser ? 'user' : 'ai');
    if(m.id) row.dataset.mid = m.id;
    // QQ 式布局：AI 头像在左、用户头像在右；AI 默认头像是 Ollama 的羊驼
    if(!isUser){
      const ava = document.createElement('span');
      ava.className = 'dchat-ava ai';
      const img = document.createElement('img');
      img.src = 'vendor/ollama-llama.png';
      img.alt = 'AI';
      img.draggable = false;
      ava.appendChild(img);
      row.appendChild(ava);
    }
    const body = document.createElement('div');
    body.className = 'dchat-body';
    // 只有图片、没有文字时不要让灰气泡再包一层——卡片自己带边框，套两层很难看
    if(m.kind === 'image' && !m.content) body.classList.add('is-gen');
    if(m.error) body.classList.add('error');
    if(m.reasoning){
      const det = document.createElement('details');
      det.className = 'dchat-think';
      const sum = document.createElement('summary');
      sum.textContent = '思考过程 · ' + m.reasoning.length + ' 字';
      const pre = document.createElement('div');
      pre.textContent = m.reasoning;
      det.append(sum, pre);
      body.appendChild(det);
    }
    if(typeof m.content === 'string'){
      if(m.content || !m.kind){
        const t = document.createElement('div');
        t.className = 'dchat-text';
        // 流式回复刚开始时内容是空串，给个省略号，别留一个空气泡
        t.textContent = m.content || (m.error ? '' : '…');
        body.appendChild(t);
      }
    }else if(Array.isArray(m.content)){
      (m.content || []).forEach(part => {
        if(part.type === 'text'){
          const t = document.createElement('div');
          t.className = 'dchat-text';
          t.textContent = part.text || '';
          body.appendChild(t);
        }else if(part.type === 'image_url'){
          const img = document.createElement('img');
          img.className = 'dchat-img';
          img.src = (part.image_url && part.image_url.url) || '';
          img.alt = '图片';
          body.appendChild(img);
        }
      });
    }
    /* 联网搜索的痕迹：搜到了就列来源（点开是原网页），没搜到/失败了给一句话说明。
       失败说明是灰色小字、不挂在正文里——它不该占正文的位置，但也不能悄悄消失。 */
    if(m.searchNote){
      const n = document.createElement('div');
      n.className = 'dchat-srcnote';
      n.textContent = m.searchNote;
      body.appendChild(n);
    }
    if(m.sources && m.sources.length){
      const box = document.createElement('div');
      box.className = 'dchat-sources';
      const lab = document.createElement('span');
      lab.className = 'dchat-src-label';
      lab.textContent = '联网来源';
      box.appendChild(lab);
      m.sources.forEach((s, i) => {
        const a = document.createElement('a');
        a.className = 'dchat-src';
        a.href = s.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = '[' + (i + 1) + '] ' + (s.title || s.host || '网页');
        const snip = s.snippet || '';
        a.title = (snip ? (snip.length > 160 ? snip.slice(0, 159) + '…' : snip) + '\n' : '') + s.url;
        box.appendChild(a);
      });
      body.appendChild(box);
    }
    if(m.kind === 'image') body.appendChild(genCard(m));
    row.appendChild(body);
    if(isUser){
      const ava = document.createElement('span');
      ava.className = 'dchat-ava user';
      ava.textContent = '我';
      row.appendChild(ava);
    }
    return row;
  }

  /* 旧记录兜底：以前漏在正文里的裸 JSON 还躺在会话里，重开一看依旧刺眼。
     渲染前统一洗一遍（洗过就打标，别每条消息每次重建都过正则）。 */
  function scrubMsg(m){
    if(m.__clean) return;
    if(typeof m.content === 'string' && m.content.indexOf('"type"') >= 0
      && typeof deskImage !== 'undefined' && deskImage.strip){
      const t = deskImage.strip(m.content, true);
      if(t !== m.content) m.content = t;
      m.__clean = true;
    }
  }

  function renderLog(){
    const log = el('deskChatLog');
    if(!log) return;
    log.innerHTML = '';
    if(!msgs.length){
      rowCache.clear();
      const e = document.createElement('div');
      e.className = 'dchat-empty';
      e.textContent = '还没有对话。可以直接问，也可以说「画一只在雨里的猫」——会自动出图。';
      log.appendChild(e);
      return;
    }
    msgs.forEach(m => {
      scrubMsg(m);
      const sig = msgSig(m);
      const hit = m.id ? rowCache.get(m.id) : null;
      if(hit && hit.sig === sig){
        log.appendChild(hit.el);      // 复用原节点（图片不会被重新解码）
        return;
      }
      const row = buildRow(m);
      if(m.id) rowCache.set(m.id, { el: row, sig: sig });
      log.appendChild(row);
    });
    log.scrollTop = log.scrollHeight;
  }

  /* ==================== 对话内生图 ====================
   * 一条图片消息的生命周期：plan（理解需求 / 改写提示词）→ gen（出图）→ done/error/cancel。
   * 卡片按 msg id 局部替换：阶段变了才重建 DOM，每秒的计时只在原地改一行文字，
   * 否则 <img> 会被反复重建，出图过程中整块区域一直在闪。 */

  function imgSourceInfo(){
    if(typeof deskImage === 'undefined' || !deskImage.source){
      return { kind:'none', label:'未加载', ready:false, where:'image', hint:'生图模块（desk-image.js）未加载' };
    }
    return deskImage.source();
  }

  /* 同上，但会先校准一次「引擎到底在不在跑」。
   * 只在缓存说不 ready 时才真去探（见 desk-image.js 的 dimgCheck），
   * 所以快路径不多等一毫秒，而不会因为开机时的旧快照把能用的引擎判死。 */
  async function imgSourceAsync(){
    if(typeof deskImage === 'undefined' || !deskImage.check) return imgSourceInfo();
    try{ return await deskImage.check(); }
    catch(e){ return imgSourceInfo(); }
  }

  function hasDesk(){ return !!(window.openagiDesktop && typeof window.openagiDesktop.assetPut === 'function'); }

  function lockSend(on){
    const b = el('deskAiSend');
    if(b) b.disabled = !!on;
  }

  function fmtSec(ms){
    const s = Math.max(0, Number(ms) || 0) / 1000;
    return (s >= 10 ? Math.round(s) : Math.round(s * 10) / 10) + 's';
  }

  /* 重绘强度的四档：0 = 自动（按提示词猜），其余是写死的百分比。
     自动档不能只显示「自动」——用户要的是「这次到底改得狠不狠」，所以把实际值算出来给他看。 */
  const DGEN_LEVELS = [0, 0.35, 0.52, 0.7];
  function dgenStrengthPct(m){
    const v = Number(m.denoise) || 0;
    if(v) return Math.round(v * 100);
    const auto = (typeof comfyDenoiseFor === 'function') ? comfyDenoiseFor(m.prompt || m.raw || '') : 45;
    return Math.round((Number(auto) || 0.45) * 100);
  }
  function dgenStrengthLabel(m){
    return '重绘 ' + dgenStrengthPct(m) + '%' + (Number(m.denoise) ? '' : ' · 自动');
  }

  function genCard(m){
    const running = m.phase === 'plan' || m.phase === 'gen';
    const card = document.createElement('div');
    card.className = 'dgen is-' + (m.phase || 'plan');
    card.dataset.mid = m.id;
    card.dataset.phase = m.phase || 'plan';

    if(m.image){
      const img = document.createElement('img');
      img.className = 'dgen-img';
      img.src = m.image;
      img.alt = m.prompt ? ('生成图：' + m.prompt.slice(0, 40)) : '生成的图片';
      img.draggable = false;
      img.title = '点击放大';
      img.addEventListener('click', () => openViewer(m.image));
      card.appendChild(img);
    }else if(running){
      const sk = document.createElement('div');
      sk.className = 'dgen-skel';
      card.appendChild(sk);
    }

    if(m.ref){
      const ref = document.createElement('div');
      ref.className = 'dgen-ref';
      const im = document.createElement('img');
      im.src = m.ref;
      im.alt = '参考图';
      im.draggable = false;
      const t = document.createElement('span');
      t.textContent = '参考图 · 图生图';
      ref.append(im, t);
      card.appendChild(ref);
    }

    const st = document.createElement('div');
    st.className = 'dgen-st';
    if(running){
      const sp = document.createElement('span');
      sp.className = 'dgen-spin';
      st.appendChild(sp);
    }
    const ph = document.createElement('span');
    ph.className = 'dgen-phase';
    ph.textContent = m.phase === 'done'
      ? ('已出图 · ' + fmtSec(m.ms) + ' · ' + (m.srcLabel || '生图模型'))
      : (m.phase === 'error' ? (m.error || '生成失败')
        : m.phase === 'cancel' ? '已停止'
        : (m.phaseText || '生成中…'));
    st.appendChild(ph);
    if(running){
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'dgen-act stop';
      stop.dataset.act = 'stop';
      stop.dataset.mid = m.id;
      stop.textContent = '停止';
      st.appendChild(stop);
    }
    card.appendChild(st);

    if(m.prompt && (m.phase === 'done' || m.phase === 'error')){
      const p = document.createElement('div');
      p.className = 'dgen-prompt';
      p.textContent = m.prompt;
      p.title = m.prompt;
      card.appendChild(p);
    }
    if(m.trState && (m.phase === 'done' || m.phase === 'error')){
      const h = document.createElement('div');
      h.className = 'dgen-hint' + (m.trState === 'fail' ? ' warn' : '');
      const t = m.tr || {};
      if(m.trState === 'fail'){
        /* 原因必须写出来。原来那句「（语言模型没配好）」把人往设置里带，
           可实测的常见原因是「填了 Ollama 直连地址，被 CORS 拦了」——重填十次也没用。 */
        h.textContent = '本地模型只认英文：这句没译成（' + (t.reason || '原因未知') + '），出图可能和描述无关';
      }else{
        h.textContent = '本地模型只认英文：已自动译成英文再生成'
          + (t.via === 'ollama' ? '（本机 ' + (t.model || 'Ollama') + '）' : '');
      }
      card.appendChild(h);
    }

    if(m.phase === 'done' && m.image){
      const acts = document.createElement('div');
      acts.className = 'dgen-acts';
      const list = [
        ['save', hasDesk() ? '保存到图库' : '保存图片', 'primary'],
        ['down', '下载', ''],
        ['ref', '用作参考图', ''],
        ['again', '再生成', ''],
        ['copy', '复制提示词', '']
      ];
      /* 图生图给一个「重绘强度」开关。
       * 本地这套没有 mask / ControlNet，强度就是唯一的构图约束：
       * 调高了构图会跑、调低了改不动。自动档按提示词猜（换背景 62% / 换风格 52% / 微调 35%），
       * 但猜不准是常态——把旋钮交给用户，比让他反复重试碰运气强。 */
      if(m.ref && /^本地/.test(String(m.srcLabel || ''))){
        list.splice(4, 0, ['denoise', dgenStrengthLabel(m), '']);
      }
      list.forEach(([act, label, cls]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dgen-act' + (cls ? ' ' + cls : '');
        b.dataset.act = act;
        b.dataset.mid = m.id;
        b.textContent = label;
        b.title = act === 'denoise'
          ? (Number(m.denoise)
              ? '当前手动 ' + dgenStrengthPct(m) + '%：越低越像原图、越高改得越狠。点一下切换 自动 → 轻改 35% → 标准 52% → 大改 70%'
              : '自动 ' + dgenStrengthPct(m) + '%（按这句话里的「换背景 / 换风格 / 只微调」猜的）。点一下改成手动')
          : '';
        acts.appendChild(b);
      });
      card.appendChild(acts);
    }else if(m.phase === 'error'){
      const acts = document.createElement('div');
      acts.className = 'dgen-acts';
      [['again', '重试'], ['save', '去设置', '']].forEach(([act, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dgen-act' + (act === 'again' ? ' primary' : '');
        b.dataset.act = act === 'save' ? 'cfg' : act;
        b.dataset.mid = m.id;
        b.textContent = label;
        acts.appendChild(b);
      });
      card.appendChild(acts);
    }
    return card;
  }

  /* 局部刷新：阶段没变只改文字；阶段变了（plan→gen→done）整卡替换一次 */
  function patchGen(m){
    const log = el('deskChatLog');
    if(!log) return;
    const card = log.querySelector('.dgen[data-mid="' + m.id + '"]');
    if(!card){ renderLog(); return; }
    if(card.dataset.phase !== (m.phase || '')){
      card.replaceWith(genCard(m));
      log.scrollTop = log.scrollHeight;
      return;
    }
    const ph = card.querySelector('.dgen-phase');
    if(ph && m.phaseText && ph.textContent !== m.phaseText) ph.textContent = m.phaseText;
  }

  function openViewer(src){
    let mask = el('dgenView');
    if(!mask){
      mask = document.createElement('div');
      mask.id = 'dgenView';
      mask.className = 'dgen-view hidden';
      mask.setAttribute('role', 'dialog');
      mask.setAttribute('aria-label', '查看大图');
      mask.addEventListener('click', () => mask.classList.add('hidden'));
      document.body.appendChild(mask);
    }
    mask.innerHTML = '';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '生成的图片';
    mask.appendChild(img);
    mask.classList.remove('hidden');
  }

  function stopTick(){
    if(genTick){ clearInterval(genTick); genTick = 0; }
  }

  function startTick(m, token){
    stopTick();
    genTick = setInterval(() => {
      if(token !== genSeq || !m) return stopTick();
      if(m.phase !== 'plan' && m.phase !== 'gen') return stopTick();
      const from = m.phase === 'plan' ? (m.p0 || Date.now()) : (m.t0 || Date.now());
      const sec = Math.round((Date.now() - from) / 1000);
      /* 前 6 秒不改文案：提示词正在流式改写时，字数是更有效的信息；
         一直没动静（模型在想 / 排队）才切成读秒，让用户知道没死。 */
      if(sec < 6) return;
      m.phaseText = (m.phase === 'plan' ? '理解需求' : '生成中') + ' · ' + sec + 's';
      patchGen(m);
    }, 1000);
  }

  async function runGen(m, opts){
    const o = opts || {};
    const token = ++genSeq;
    busy = true;
    lockSend(true);
    setDot('busy', '出图中…');
    renderImgLabel();          // 来源可能刚在设置里改过，别显示上次的
    m.phase = 'plan';
    m.p0 = Date.now();
    m.phaseText = '理解需求…';
    patchGen(m);
    startTick(m, token);

    let prompt = String(m.prompt || '');
    /* ① 提示词改写：把「一只在雨里的猫」这种口语扩成能画的描述。
       失败不算错——原话照样能生，绝不因为改写不通而让用户拿不到图。 */
    /* ⚠️ 图生图（有参考图）**不改写**。
       改写的目标是「写清主体+动作+环境+光线+材质+镜头+风格+色调」——那是给「从零生成」用的，
       喂给图生图等于把参考图丢掉、照一段全新描述重画：用户明明只说了「把背景换成海边日落」，
       改写却补出整套构图与光线，于是主体挪了位置、姿态也变了（「构图和原图不吻合」的头号原因）。
       改图指令本来就具体，直接翻译比扩写可靠。 */
    if(!o.skipRefine && refineOn && !prompt && !m.ref && canChat()){
      try{
        const sel = el('deskAiModel');
        const conn = connFor(sel ? sel.value : '');
        prompt = await deskImage.refine(m.raw, {
          conn: conn,
          onDelta: acc => {
            if(token !== genSeq) return;
            m.phaseText = '理解需求 · ' + String(acc || '').length + ' 字';
            patchGen(m);
          }
        });
      }catch(e){ prompt = ''; }
    }
    if(token !== genSeq) return;
    if(!prompt) prompt = deskImage.cleanPrompt(m.raw);
    m.prompt = prompt;
    if(!prompt){ m.phase = 'error'; m.error = '没读懂要画什么，换个说法再试一次'; return finishGen(m, token); }

    /* ② 出图 */
    m.phase = 'gen';
    m.t0 = Date.now();
    m.phaseText = '生成中 · 0s';
    patchGen(m);
    startTick(m, token);
    try{
      imgCtrl = new AbortController();
      const r = await deskImage.generate({ prompt: prompt, ref: m.ref, denoise: m.denoise, signal: imgCtrl.signal, timeoutSec: 300 });
      if(token !== genSeq) return;
      m.image = r.src;
      m.ms = r.ms;
      m.phase = 'done';
      /* 本地模型只认英文：provider 会把中文翻成英文再送（SD1.5 的 CLIP 没有中文）。
         翻没翻成要如实告诉用户，否则下次还是「图和描述无关」而不知道为什么。 */
      const tr = (typeof comfyLastLocalize === 'function') ? comfyLastLocalize() : null;
      if(tr && tr.zh === prompt && !tr.skipped && /^本地/.test(String(m.srcLabel || ''))){
        m.trState = tr.ok ? 'ok' : 'fail';
        m.tr = { via: tr.via || '', model: tr.model || '', reason: tr.reason || '' };   // 卡片上要说清「谁翻的 / 为什么没翻成」
      }
      lastImage = r.src;
      setDot('ok', '已出图 · ' + (m.srcLabel || ''));
      /* 在线接口给的是远程地址：后面「把这张再改改」「用作参考图」「保存到图库」
         都要本地能取到像素，后台先转成 dataURL 备好。显示用的 <img> 不动（同一张图）。 */
      if(/^https?:/i.test(String(r.src || ''))){
        deskImage.toDataUrl(r.src).then(u => {
          if(!u) return;
          m.image = u;
          if(lastImage === r.src) lastImage = u;
        }).catch(() => {});
      }
    }catch(e){
      if(token !== genSeq) return;
      m.phase = 'error';
      m.error = (typeof friendlyErr === 'function') ? friendlyErr(e) : String((e && e.message) || e);
      setDot('err', '生图失败');
      deskToast('生图失败：' + String(m.error).slice(0, 80));
    }
    return finishGen(m, token);
  }

  function finishGen(m, token){
    if(token !== genSeq) return;
    stopTick();
    imgCtrl = null;
    busy = false;
    lockSend(false);
    patchGen(m);
    renderImgLabel();
  }

  function cancelGen(){
    const m = msgs.slice().reverse().find(x => x.kind === 'image' && (x.phase === 'plan' || x.phase === 'gen'));
    if(!m) return;
    genSeq++;
    if(imgCtrl){ try{ imgCtrl.abort(); }catch(e){} imgCtrl = null; }
    stopTick();
    m.phase = 'cancel';
    m.phaseText = '已停止';
    busy = false;
    lockSend(false);
    setDot('', '已停止');
    patchGen(m);
  }

  /* 重新生成：新开一条消息而不是覆盖原来的——原图还能留着对比 */
  function retryGen(m){
    if(busy) return;
    const n = {
      id: ++msgSeq, role:'assistant', kind:'image', content:'',
      raw: m.raw, prompt: m.prompt, ref: m.ref || '', image:'',
      denoise: Number(m.denoise) || 0,      // 保持用户选定的重绘强度
      phase:'plan', phaseText:'重新生成…', ms:0, srcLabel: m.srcLabel
    };
    msgs.push(n);
    renderLog();
    runGen(n, { skipRefine: true });
  }

  function downloadDataUrl(dataUrl, name){
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function genFileName(m){
    const t = new Date();
    const p2 = n => String(n).padStart(2, '0');
    const stamp = '' + t.getFullYear() + p2(t.getMonth() + 1) + p2(t.getDate()) + '-' + p2(t.getHours()) + p2(t.getMinutes()) + p2(t.getSeconds());
    const head = String(m.prompt || '生成图').slice(0, 20).replace(/[\\/:*?"<>|\s，,。]+/g, '-').replace(/^-+|-+$/g, '') || '生成图';
    return head + '-' + stamp + '.png';
  }

  async function saveImg(m, btn){
    if(!m.image) return;
    const name = genFileName(m);
    const label = btn ? btn.textContent : '';
    if(btn){ btn.disabled = true; btn.textContent = '保存中…'; }
    try{
      const dataUrl = await deskImage.toDataUrl(m.image);
      if(hasDesk()){
        const r = await window.openagiDesktop.assetPut({ kind:'image', data: dataUrl, name: name, ext:'png', source:'chat' });
        if(!r || !r.ok) throw new Error((r && r.message) || '写入图库失败');
        deskToast('已保存到图库：' + name);
        if(typeof libRefresh === 'function'){ try{ libRefresh(false); }catch(e){} }
      }else{
        downloadDataUrl(dataUrl, name);
        deskToast('已下载：' + name);
      }
    }catch(e){
      deskToast('保存失败：' + String((e && e.message) || e));
    }finally{
      if(btn){ btn.disabled = false; btn.textContent = label || '保存到图库'; }
    }
  }

  async function downloadImg(m){
    try{
      if(/^data:/i.test(String(m.image || ''))) downloadDataUrl(m.image, genFileName(m));
      else downloadDataUrl(await deskImage.toDataUrl(m.image), genFileName(m));
    }catch(e){ deskToast('下载失败：' + String((e && e.message) || e)); }
  }

  async function copyText(t){
    try{
      await navigator.clipboard.writeText(String(t || ''));
      deskToast('提示词已复制');
    }catch(e){ deskToast('复制失败：' + String((e && e.message) || e)); }
  }

  function genAction(act, mid, btn){
    const m = msgs.find(x => String(x.id) === String(mid));
    if(!m) return;
    if(act === 'stop'){ cancelGen(); return; }
    if(act === 'again'){ retryGen(m); return; }
    if(act === 'denoise'){
      /* 循环四档，换一档就按新强度重画一张（不是改当前这张的样式，是重新采样）。 */
      const cur = DGEN_LEVELS.indexOf(Number(m.denoise) || 0);
      m.denoise = DGEN_LEVELS[(cur + 1) % DGEN_LEVELS.length];
      deskToast(m.denoise ? '重绘强度 ' + Math.round(m.denoise * 100) + '%，正在重画' : '重绘强度：自动，正在重画');
      retryGen(m);
      return;
    }
    if(act === 'view'){ if(m.image) openViewer(m.image); return; }
    if(act === 'copy'){ copyText(m.prompt); return; }
    if(act === 'down'){ downloadImg(m); return; }
    if(act === 'save'){ saveImg(m, btn); return; }
    if(act === 'cfg'){
      /* 走到这里说明「刚才判断为不就绪」。缓存可能是旧快照，先校准再决定往哪儿跳，
         否则会出现「引擎明明起来了，还被推去启动引擎」。 */
      imgSourceAsync().then(s => {
        renderImgLabel();
        if(s.ready) return;                      // 已经好了：不用跳，直接让用户再说一次
        if(s.where === 'comfy'){
          deskToast(s.hint || '先在「本地生图」里启动引擎');
          if(typeof openComfyApp === 'function') openComfyApp();
        }else if(typeof openSettings === 'function') openSettings('image');
      }).catch(() => {});
      return;
    }
    if(act === 'ref'){
      if(!m.image) return;
      atts.push(m.image);
      renderAtts();
      deskToast('已加入参考图，接着说想怎么改');
      const input = el('deskAiText');
      if(input) input.focus();
    }
  }

  /* 头部显示当前出图来源（本地 ComfyUI / Tripo / 在线）——出图走哪条路必须一眼可见，
     否则「为什么生成的图和设置里的模型对不上」永远说不清。 */
  function renderImgLabel(){
    const box = el('deskChatImg');
    if(!box) return;
    paintImgLabel(imgSourceInfo());
    /* 先按缓存画（打开面板不能等），再校准一次：缓存里那半分钟前的「未就绪」
       不该一直挂在这个 chip 上。校准只在不 ready 时才真的发请求。 */
    imgSourceAsync().then(s => { if(opened || box.isConnected) paintImgLabel(s); }).catch(() => {});
    /* 来源/模型变了，输入条上的生图模型下拉要跟着换（签名相同就不动，避免反复问引擎）。 */
    syncImgModelPicker();
  }

  function paintImgLabel(s){
    const box = el('deskChatImg');
    if(!box) return;
    box.textContent = '生图 · ' + s.label;
    box.classList.toggle('off', !s.ready);
    box.title = s.ready
      ? ('当前出图来源：' + s.label + (s.shared ? '（图像侧未单独配置，沿用了语言模型的接口）' : '') + '（点一下去设置）')
      : (s.hint || '生图模型未就绪');
  }

  /* 来源或模型变了 → 输入条上的生图模型下拉要跟着换。
   *
   * 为什么用签名缓存而不是每次都刷：刷下拉要去问引擎拿 ckpt 清单（一次网络往返），
   * 而 renderImgLabel 在出图流程里被调得很勤（每张图、每次校准都调），
   * 每次都去问一遍会把引擎打爆。
   *
   * 签名 = 来源模式 + 当前模型名 + 清单本身没变时不动。
   * 引擎起了（清单从空变成有）也算一次变化——这时本地 ckpt 才冒出来。 */
  let imgModelSig = '';
  function syncImgModelPicker(){
    const sig = [
      (function(){ try{ return imgMode(); }catch(e){ return 'online'; } })(),
      (function(){ try{ return $('imgModel').value.trim(); }catch(e){ return ''; } })(),
      (function(){ try{ return comfyCkptChoice(); }catch(e){ return ''; } })()
    ].join('|');
    if(sig === imgModelSig) return false;
    imgModelSig = sig;
    renderImgModelSelect();
    return true;
  }

  /* 生图模式按钮：自动 → 总是生图 → 仅对话 */
  const CHAT_IMG_MODES = [
    { v:'auto',  t:'自动', tip:'生图：自动判断这句话要不要出图（点一下 → 总是生图）' },
    { v:'image', t:'生图', tip:'生图：每条消息都出图（点一下 → 仅对话）' },
    { v:'chat',  t:'对话', tip:'生图：只聊天不出图（点一下 → 自动）' }
  ];

  function renderImgMode(){
    const b = el('deskAiImage');
    if(!b) return;
    const cur = CHAT_IMG_MODES.find(x => x.v === chatImgMode) || CHAT_IMG_MODES[0];
    b.dataset.mode = cur.v;
    b.title = cur.tip;
    b.setAttribute('aria-pressed', chatImgMode === 'image' ? 'true' : 'false');
    const t = el('deskAiModeTxt');
    if(t) t.textContent = cur.t;
    const input = el('deskAiText');
    if(input){
      input.placeholder = chatImgMode === 'image'
        ? '描述你想要的画面…（Enter 生成，Shift+Enter 换行）'
        : '问点什么…（Enter 发送，Shift+Enter 换行）';
    }
  }

  function cycleImgMode(){
    const i = CHAT_IMG_MODES.findIndex(x => x.v === chatImgMode);
    chatImgMode = CHAT_IMG_MODES[(i + 1) % CHAT_IMG_MODES.length].v;
    try{ localStorage.setItem(IMG_MODE_KEY, chatImgMode); }catch(e){}
    renderImgMode();
    const cur = CHAT_IMG_MODES.find(x => x.v === chatImgMode);
    deskToast('生图模式：' + cur.t);
  }

  /* ---------- 联网搜索 ----------
   * 按钮只是一个开关：开着时，这条消息在交给模型之前先搜一次，
   * 把摘要拼进这一轮的系统提示（见 send 里的 searchPack）。
   * 默认关：每句话都去搜既慢、又容易被站方限流，要不要事实由用户决定。 */
  function renderWebSearch(){
    const b = el('deskAiWeb');
    if(!b) return;
    b.classList.toggle('is-on', !!webSearchOn);
    b.setAttribute('aria-pressed', webSearchOn ? 'true' : 'false');
    b.title = webSearchOn
      ? '联网搜索：开（回答前先检索网页，引用会标 [1][2]；点一下关闭）'
      : '联网搜索：关（点一下打开，回答前先检索网页）';
  }

  function toggleWebSearch(on){
    webSearchOn = (on === undefined) ? !webSearchOn : !!on;
    try{ localStorage.setItem(WEB_KEY, webSearchOn ? '1' : '0'); }catch(e){}
    renderWebSearch();
    if(webSearchOn && typeof deskSearch === 'undefined'){
      deskToast('搜索模块没加载，联网不会生效');
      return webSearchOn;
    }
    const p = (typeof deskSearch !== 'undefined' && deskSearch.cfg) ? deskSearch.cfg() : null;
    deskToast(webSearchOn
      ? ('联网搜索：开 · ' + (p ? deskSearch.labelOf(p.provider) : '') + '（可在设置 → 联网搜索里换来源）')
      : '联网搜索：关');
    return webSearchOn;
  }

  /* 这条消息走哪条路：显式模式优先，auto 交给意图判断 */
  function routeOf(text, hasAtt){
    if(chatImgMode === 'image'){
      return { on:true, why:'已锁定生图模式', edit: hasAtt || (deskImage && deskImage.intent(text, hasAtt).edit) };
    }
    if(chatImgMode === 'chat') return { on:false, why:'已锁定仅对话' };
    if(typeof deskImage === 'undefined' || !deskImage.intent) return { on:false, why:'生图模块未加载' };
    return deskImage.intent(text, hasAtt);
  }

  function canChat(){
    const sel = el('deskAiModel');
    const c = connFor(sel ? sel.value : '');
    return !!(c && c.base && c.key && c.model);
  }

  function userContent(text, list){
    if(!list || !list.length) return text;
    const parts = [];
    if(text) parts.push({ type:'text', text: text });
    list.forEach(src => parts.push({ type:'image_url', image_url:{ url: src } }));
    return parts;
  }

  /* 对话历史回灌：图片消息不能把地址塞给模型（有的模型会照着 URL 编内容），
     换成一句事实说明——「我生成过一张图，描述是 …」。 */
  function historyForModel(){
    return msgs.map(m => {
      if(m.kind === 'image' && m.role === 'assistant'){
        const note = '（我生成了一张图片：' + String(m.prompt || m.raw || '').slice(0, 60) + '）';
        return { role:'assistant', content: m.content ? (m.content + '\n' + note) : note };
      }
      return { role: m.role, content: m.content };
    });
  }

  /* ---------- 面板开合 ----------
   * 对话现在是桌面上的一个普通 App（和其他 App 同一套翻页动效与返回按钮），
   * 所以开合走的是 deskMountApp / deskAppLeave，而不是自己那套 chat-open。
   *
   * 输入条跟着**窗口**走，不跟着「用户点了哪个按钮」走：
   *   窗口被挂进 App 页 → 输入条搬进对话窗口底部；
   *   窗口被放回原位   → 输入条搬回桌面底部。
   * 之前绑在 closePanel() 上会漏：App 页那个统一的 << 返回按钮走的是
   * deskAppLeave()，根本不经过对话模块的 close，输入条就被留在窗口里一起被隐藏了
   * （桌面上下次想打字就没框了）。所以改成监听窗口生命周期事件。 */
  function mountInput(target, before){
    const wrap = el('deskAiWrap');
    if(!wrap || !target) return;
    if(wrap.parentElement === target) return;
    if(before && before.parentElement === target) target.insertBefore(wrap, before);
    else target.appendChild(wrap);
  }
  /* 输入条回桌面时的落点：桌面页内、图标画布之后（Dock 已移除，那里就是空白带） */
  function mountInputHome(){
    const canvas = el('deskCanvas');
    mountInput(el('deskPage1'), canvas ? canvas.nextElementSibling : (el('deskIcons') && el('deskIcons').nextSibling));
  }
  function openPanel(){
    const win = el('chatWin');
    if(typeof deskMountApp === 'function' && win){
      deskMountApp(win, 'AI 对话', '问点什么，或让它画一张');
    }
    opened = true;
    closeMenus();
    mountInput(el('deskChatFoot'));
    renderCtxLabel();
    renderImgLabel();
    renderLog();
  }
  function closePanel(){
    opened = false;
    closeMenus();
    // 回到桌面：把对话窗口放回原位（输入条由 app-restored 事件搬回桌面）
    if(typeof deskAppLeave === 'function') deskAppLeave();
    else mountInputHome();
    renderCtxLabel();
  }

  /* 面板头部显示当前上下文（对应参考图里的分支/上下文指示） */
  function renderCtxLabel(){
    const box = el('deskChatCtx');
    if(!box) return;
    const sel = el('deskAiCtx');
    const v = sel && sel.value ? sel.value : 'none';
    if(v === 'none' || !v){ box.textContent = '无上下文'; return; }
    const opt = sel && sel.selectedOptions.length ? sel.selectedOptions[0].textContent : '';
    box.textContent = opt ? '上下文 · ' + opt : '';
  }

  /* ---------- 发送 ---------- */
  function setDot(state, title){
    const d = el('deskAiDot');
    if(!d) return;
    d.className = 'dai-dot ' + (state || '');
    d.title = title || '';
  }

  /* 发送前的兜底预热：确保本地模型已经驻留显存。
   *
   * 这一层解决的是「等」，不是「黑窗」：
   *   预热调度器在**客户端启动阶段**预热，但有几条路会绕过它——
   *     ① 用户启动后先聊了十分钟才想起本地模型（调度器 12 次轮询早就收手了）；
   *     ② 预热失败（显存当时被 ComfyUI 占满、模型文件缺失）；
   *     ③ 换了模型（换模型事件会重新调度，但那一轮也可能失败）；
   *     ④ 模型驻留超过 keep_alive 被 Ollama 卸载。
   *   这些情况下「提问那一刻」会冷加载，用户要干等 4-5 秒（实测 4210 ms）。
   *   这里在真正发起请求前再确认一次，让等待发生在看得见的状态点文案上。
   *
   * 判断依据只有一个：连接是不是本地的。云端模型（gw:/local:）直接跳过，零影响。 */
  /* 发送前的本地模型兜底：确保模型在显存里。
   *
   * 为什么需要：模型可能已被 Ollama 卸载（keep_alive 到期），
   * 这时提问会触发一次冷加载 —— 用户看到的是「点了发送之后卡住四五秒」。
   *
   * ⚠ 这里绝不能无脑「强制预热」：预热一个没驻留的模型 = 一次冷加载 =
   *   一次 GPU 探测 = **又闪一次黑窗口**（实测冷加载 6 个曾可见窗口，
   *   续期 0 个）。所以先问一句「模型在不在显存里」：
   *     在   → 只续期（26ms，不闪窗）
   *     不在 → 才真的加载（不可避免，但有了保活后这种情况极少出现）
   */
  async function ensureLocalModelWarm(conn){
    if(!conn || conn.via !== 'ollama' || !conn.model) return true;
    if(typeof window.engineAuto === 'undefined' || !window.engineAuto.warmNow) return true;
    try{
      const st = window.engineAuto.status ? window.engineAuto.status() : null;
      // 引擎都没就绪就别试了，让后面正常的报错路径去提示「引擎没在运行」
      if(st && st.ollama !== 'ready' && st.ollama !== 'already') return true;
      // 先问驻留状态：已驻留就只续期（不冷加载 → 不弹黑窗口）
      // force=true：模型可能已经被卸载（keep_alive 到期），必须真的把它拉回来
      if(typeof window.engineAuto.keepAlive === 'function'){
        const done = await window.engineAuto.keepAlive(conn.model, true);
        if(done) return true;    // 已续期，模型在显存里，直接发
      }
      setDot('busy', '正在加载本地模型…');
      const ok = await window.engineAuto.warmNow(conn.model, true);
      if(ok) setDot('busy', '生成中…');
      return true;
    }catch(e){
      return true;   // 预热失败不该拦住对话，让请求自己报错更有信息量
    }
  }

  async function send(){
    if(busy) return;
    const input = el('deskAiText');
    if(!input) return;
    const text = input.value.trim();
    if(!text && !atts.length) return;

    const hasAtt = atts.length > 0;
    const sentAtts = atts.slice();          // 清空前留一份：图生图的参考图来自这里
    const route = routeOf(text, hasAtt);

    /* ---------- ① 生图 ---------- */
    if(route.on){
      /* 缓存说「就绪」就直接用，零延迟。说不就绪时才真探一次——开机自动启动那一百秒里
         探到的是 false，引擎起来之后没人再探，旧快照会把能用的引擎判死（卡片写着运行中，
         一出图却弹「没在运行」）。探测最长 3 秒，这期间再点一次会建出两条消息，所以先按住。 */
      let src = imgSourceInfo();
      if(!src.ready){
        if(srcProbing) return;
        srcProbing = true;
        lockSend(true);
        try{ src = await imgSourceAsync(); }
        finally{ srcProbing = false; lockSend(false); }
      }
      if(!src.ready){
        deskToast(src.hint || '生图模型未就绪');
        if(src.where === 'comfy' && typeof openComfyApp === 'function') openComfyApp();
        else if(typeof openSettings === 'function') openSettings('image');
        return;
      }
      // 参考图：本条附带的图优先；没有附件但话里在说「这张 / 改成」时，接上一张生成图
      const ref = hasAtt ? sentAtts[0] : (route.edit ? lastImage : '');
      /* 只丢一张图、一句话都不说：别拿「（只给了参考图）」去生图，
         按最常见的意图——保留主体、提升质感——给一个可用的起点。 */
      const preset = (!text && ref) ? '参考这张图，保持主体、构图与色调不变，提升清晰度与质感，细节更丰富' : '';
      msgs.push({ id: ++msgSeq, role: 'user', content: userContent(text, sentAtts) });
      input.value = '';
      if(typeof autoGrowTextarea === 'function') autoGrowTextarea(input);
      atts = [];
      renderAtts();
      openPanel();

      const m = {
        id: ++msgSeq, role: 'assistant', kind: 'image', content: '',
        raw: text || preset || '（只给了参考图，没有文字）',
        prompt: preset, ref: ref || '', image: '',
        denoise: 0,          // 0 = 自动：由 provider 按「想改多少」猜
        phase: 'plan', phaseText: '理解需求…', ms: 0, srcLabel: src.label, error: ''
      };
      msgs.push(m);
      renderLog();
      runGen(m);
      return;
    }

    /* ---------- ② 纯对话 ---------- */
    const sel = el('deskAiModel');
    const conn = connFor(sel ? sel.value : '');
    if(!conn.base || !conn.key || !conn.model){
      deskToast('聊天需要语言模型：先在设置里填好接口地址、Key 和模型（生图用的是另一套配置）');
      if(typeof openSettings === 'function') openSettings('llm');
      return;
    }
    if(!text){
      deskToast('附件要先配一句话：比如「把这张图改成水彩风格」');
      return;
    }

    const ctxSel = el('deskAiCtx');
    const ctx = contextText(ctxSel ? ctxSel.value : 'none');

    msgs.push({ id: ++msgSeq, role: 'user', content: userContent(text, sentAtts) });

    input.value = '';
    if(typeof autoGrowTextarea === 'function') autoGrowTextarea(input);
    atts = [];
    renderAtts();
    openPanel();
    renderLog();

    // 仅对话模式下不教模型出图，省得它每句都想画
    /* 联网：先把「刚搜到的网页摘要」拿到，再交给模型。
       失败**不拦**——搜不到还照常聊，才是用户要的行为；失败原因挂在这条回复下面，
       不弹框、不打断（一次 403 / 超时就把话堵死，用户会以为「开了联网就不能聊了」）。 */
    let pack = null;
    if(webSearchOn && typeof deskSearch !== 'undefined' && text){
      setDot('busy', '联网搜索…');
      pack = await deskSearch.run(text);
      if(pack && pack.ok){
        setDot('busy', pack.results.length ? ('搜到 ' + pack.results.length + ' 条 · 生成中…') : '没搜到结果 · 生成中…');
      }
    }

    const sys = '你是 The seed 的桌面助手。回答准确、简洁，能给可执行的下一步，别编造不确定的信息。'
      + (pack && pack.ok ? deskSearch.contextBlock(pack.results) : '')
      + (pack && pack.ok && !(pack.results || []).length
        ? '\n【联网搜索】这次没取回可用结果；涉及时效/事实的问题要直说没搜到，别用旧知识硬凑。'
        : '')
      + (pack && !pack.ok
        ? '\n【联网搜索】这次检索失败（' + (pack.error || '未知原因') + '），只能按你已知的信息回答，必要时说明可能不是最新。'
        : '')
      + (ctx ? '\n' + ctx : '')
      + (chatImgMode === 'chat' ? '' : '\n' + IMG_SYS);
    const sent = historyForModel();

    busy = true;
    lockSend(true);
    setDot('busy', '生成中…');
    const reply = { id: ++msgSeq, role: 'assistant', content: '' };
    if(pack){
      if(pack.ok && pack.results.length) reply.sources = pack.results.slice(0, 5);
      else if(!pack.ok) reply.searchNote = '联网搜索失败：' + (pack.error || '未知原因') + '（已按离线回答）';
      else reply.searchNote = '联网搜索没有取回结果（可到设置 → 联网搜索里换来源或关键词）';
      /* 换了源要说出来：不静默替换，否则用户以为原来那个是通的 */
      if(pack.ok && pack.fellBackFrom){
        reply.searchNote = '原来源 ' + deskSearch.labelOf(pack.fellBackFrom)
          + ' 连不上（' + (pack.fellBackWhy || '未知原因') + '），这次自动改用 '
          + deskSearch.labelOf(pack.provider) + ' 取回 ' + pack.results.length + ' 条';
      }
    }
    msgs.push(reply);
    renderLog();
    try{
      /* 兜底预热：确认本地模型已经驻留显存，再发真正的请求。
       * 放在这里（而不是请求内部）是为了让「加载模型」这件事发生在
       * 用户看得见的状态点文案上，而不是在请求飞行途中悄悄派生一批
       * 带终端窗口的 runner 进程。云端模型这里直接跳过，零影响。 */
      await ensureLocalModelWarm(conn);
      const text2 = await llmChatMessagesStream(sys, sent, (acc, piece, info) => {
        // 出图指令必须挡在显示之外：让用户看着一行 JSON 一点点长出来很出戏
        reply.content = (typeof deskImage !== 'undefined' && deskImage.live) ? deskImage.live(acc) : acc;
        if(info && info.reasoning) reply.reasoning = info.reasoning;
        // 和工作流节点同一套阶段文案：先「思考中 N 字」再「生成中 N 字」
        setDot('busy', (typeof streamPhaseText === 'function')
          ? streamPhaseText(acc, info)
          : ('生成中 ' + acc.length + ' 字'));
        renderLog();
      }, { conn: conn });
      if(!text2) throw new Error('模型没有返回内容');
      const seg = (typeof deskImage !== 'undefined' && deskImage.segment)
        ? deskImage.segment(text2)
        : { text: text2, direct: null };
      reply.content = seg.text;
      setDot('ok', '已返回 · ' + conn.model);
      /* 模型决定要出图：它写提示词，系统去真正生成。
         「仅对话」模式下不执行，只把指令摘掉，避免误扣生图额度。 */
      if(seg.direct){
        if(chatImgMode === 'chat'){
          reply.content = seg.text || '（当前是「对话」模式，已忽略出图请求；切到「自动」或「生图」后重发即可生成）';
        }else{
          await runChatImage(reply, seg.direct, sentAtts);
        }
      }
    }catch(e){
      const i = msgs.findIndex(m => m === reply && !m.content);
      if(i >= 0) msgs.splice(i, 1);
      const msg = (typeof friendlyErr === 'function') ? friendlyErr(e) : String(e && e.message || e);
      msgs.push({ id: ++msgSeq, role: 'assistant', content: msg, error: true });
      setDot('err', msg);
      deskToast(msg);
    }finally{
      busy = false;
      lockSend(false);
      renderLog();
    }
  }

  /* 对话中途模型要求出图：把这条回复升级成图片消息，接着跑同一条生图管线 */
  async function runChatImage(reply, direct, sentAtts){
    const src = imgSourceInfo();
    if(!src.ready){
      deskToast(src.hint || '生图模型未就绪');
      return;
    }
    const wantImage = direct.mode === 'image';
    reply.kind = 'image';
    // 兜一层：正文里不该再有任何一行裸 JSON（指令可能有重复，见 deskImage.strip）
    if(typeof deskImage !== 'undefined' && deskImage.strip && reply.content){
      reply.content = deskImage.strip(reply.content);
    }
    reply.raw = direct.prompt;
    reply.prompt = direct.prompt;
    reply.ref = wantImage ? ((sentAtts && sentAtts[0]) || lastImage || '') : '';
    reply.image = '';
    reply.phase = 'plan';
    reply.phaseText = '理解需求…';
    reply.ms = 0;
    reply.srcLabel = src.label;
    renderLog();
    await runGen(reply, { skipRefine: true });
  }

  /* ---------- 初始化 ---------- */
  function init(){
    // 自绘下拉要最先就位：下面两个 render* 会调 syncPicker 刷触发器文字
    initPicker('ctx', {
      sel: 'deskAiCtx', btn: 'deskAiCtxBtn', label: 'deskAiCtxLabel',
      storeKey: CTX_KEY, title: '对话上下文', placeholder: '无上下文',
      empty: '没有可用的上下文'
    });
    initPicker('model', {
      sel: 'deskAiModel', btn: 'deskAiBtn', label: 'deskAiLabel', tag: 'deskAiTag',
      storeKey: MODEL_KEY, title: '对话模型', placeholder: '未选择模型', config: true, align: 'right',
      empty: '还没有可用模型 —— 点下面的「配置自定义模型」接一个'
    });
    /* 生图模型下拉：没有 storeKey（值由 applyImgModel 写进真正生效的配置），
       对齐到左侧（它挨着生图模式按钮，不贴右边缘）。
       底部挂「配置自定义云端生图」——在线那一组来自设置页读过的清单，
       没配过接口时下拉里只剩本地 ckpt，看着像云端生图没做。 */
    initPicker('imgmodel', {
      sel: 'deskAiImgModel', btn: 'deskAiImgBtn', label: 'deskAiImgLabel',
      title: '生图模型', placeholder: '未选生图模型',
      config: true, configLabel: '配置自定义云端生图', configId: 'daiImgCfgOpen',
      onConfig: openImgCfg, footEntry: imgSiteMenuEntry,
      empty: '没有可用的生图模型 —— 点下面的「配置自定义云端生图」接一个，或启动本地 ComfyUI'
    });
    renderContextSelect();
    renderAtts();
    renderLog();

    const input = el('deskAiText');
    if(input){
      input.addEventListener('input', () => { if(typeof autoGrowTextarea === 'function') autoGrowTextarea(input); });
      input.addEventListener('keydown', e => {
        if(e.key === 'Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); send(); }
      });
    }
    const btn = el('deskAiSend');
    if(btn) btn.addEventListener('click', send);

    const add = el('deskAiAdd');
    const file = el('deskAiFile');
    if(add && file){
      add.addEventListener('click', () => file.click());
      file.addEventListener('change', () => {
        const f = file.files && file.files[0];
        if(!f) return;
        const reader = new FileReader();
        reader.onload = async () => {
          let src = String(reader.result || '');
          if(typeof shrinkImageDataUrl === 'function'){
            try{ src = await shrinkImageDataUrl(src, 1400, .82); }catch(e){}
          }
          atts.push(src);
          renderAtts();
        };
        reader.onerror = () => deskToast('读取图片失败');
        reader.readAsDataURL(f);
        file.value = '';
      });
    }

    const mic = el('deskAiMic');
    if(mic) mic.addEventListener('click', () => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if(!SR){ deskToast('当前环境不支持语音输入'); return; }
      try{
        const rec = new SR();
        rec.lang = 'zh-CN';
        rec.interimResults = false;
        rec.onresult = ev => {
          const said = Array.from(ev.results).map(r => r[0].transcript).join('');
          input.value = (input.value ? input.value + ' ' : '') + said;
          if(typeof autoGrowTextarea === 'function') autoGrowTextarea(input);
        };
        rec.onerror = () => deskToast('语音识别失败');
        rec.start();
        deskToast('开始录音，说完再点一次麦克风结束');
      }catch(e){ deskToast('语音输入不可用'); }
    });

    const msel = el('deskAiModel');
    if(msel) msel.addEventListener('change', () => {
      try{ localStorage.setItem(MODEL_KEY, msel.value); }catch(e){}
      renderChatModelLabel();
      syncPicker('model');
      /* 换了本地模型 = 新的权重要读进显存。不预热的话，提问那一刻会冷加载，
       * 用户要干等四五秒（实测 4210 ms）。提前读进来，这条等待就没了。 */
      try{ window.dispatchEvent(new CustomEvent('hf-desk-model-changed')); }catch(e){}
    });

    const csel = el('deskAiCtx');
    if(csel) csel.addEventListener('change', () => {
      try{ localStorage.setItem(CTX_KEY, csel.value); }catch(e){}
      renderCtxLabel();
      syncPicker('ctx');
    });

    /* 生图模型：选中后写进真正生效的那处配置（本地 ckpt / 在线 imgModel）。
     * 写完要重刷页头标签，否则「生图 · xxx」还停在旧模型上。 */
    const isel = el('deskAiImgModel');
    if(isel) isel.addEventListener('change', () => {
      if(!applyImgModel(isel.value)) return;
      syncPicker('imgmodel');
      /* 来源可能跟着变了（选了本地 ckpt → 切本地；选了在线模型 → 切在线），
       * 页头标签要按新来源重画一遍。 */
      renderImgLabel();
    });

    /* 设置页切了生图来源（本地 / 在线）→ 页头标签与生图模型下拉跟着换。
     * 事件由 js/models-console.js 的 mcSetScope 之后派发。 */
    window.addEventListener('hf-img-source-changed', () => {
      imgModelSig = '';        // 强制重刷（签名没变但来源确实换了）
      renderImgLabel();
    });

    /* 引擎状态变了 → 本地 ckpt 清单可能变了（引擎起来了，ckpt 才冒出来）。
     * 强制重刷一次下拉，否则用户启动引擎后还得手动点一下才能看到本地模型。 */
    window.addEventListener('engines-status', () => {
      imgModelSig = '';
      renderImgModelSelect();
    });

    /* 返回按钮：对话现在是普通 App，返回走 App 页统一的 << 按钮（deskAppLeave）。
       这里只保留「对话窗口自己的 × 关闭」——它是 .os-win 的标配按钮，
       语义和别的 App 一样（关掉这个窗口，而不是「退回上一页」）。 */
    const close = el('btnChatWinClose');
    if(close) close.addEventListener('click', closePanel);

    /* 输入条跟着对话窗口的归属走（详见 mountInput 处的说明）：
       挂载 → 搬进对话窗口底部；放回 → 搬回桌面底部。 */
    window.addEventListener('openagi:app-mounted', e => {
      const id = (e && e.detail && e.detail.win) || '';
      if(id === 'chatWin') mountInput(el('deskChatFoot'));
    });
    window.addEventListener('openagi:app-restored', e => {
      const id = (e && e.detail && e.detail.win) || '';
      if(id === 'chatWin') mountInputHome();
    });

    /* ---- 生图：模式按钮 / 来源按钮 / 卡片动作 ---- */
    try{
      const m = localStorage.getItem(IMG_MODE_KEY);
      if(m === 'auto' || m === 'image' || m === 'chat') chatImgMode = m;
      const r = localStorage.getItem(REFINE_KEY);
      if(r === '0') refineOn = false;
    }catch(e){}
    renderImgMode();
    renderImgLabel();

    /* ---- 联网搜索开关 ---- */
    try{ webSearchOn = localStorage.getItem(WEB_KEY) === '1'; }catch(e){}
    renderWebSearch();
    const webBtn = el('deskAiWeb');
    if(webBtn) webBtn.addEventListener('click', () => toggleWebSearch());

    const imgBtn = el('deskAiImage');
    if(imgBtn) imgBtn.addEventListener('click', cycleImgMode);
    const imgChip = el('deskChatImg');
    if(imgChip) imgChip.addEventListener('click', () => {
      const s = imgSourceInfo();
      if(s.where === 'comfy' && typeof openComfyApp === 'function') openComfyApp();
      else if(typeof openSettings === 'function') openSettings('image');
    });
    // 卡片上的动作按钮走事件委托：卡片会被整块替换，逐个 addEventListener 必然漏
    const logBox = el('deskChatLog');
    if(logBox) logBox.addEventListener('click', e => {
      const b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if(!b || !logBox.contains(b)) return;
      genAction(b.dataset.act, b.dataset.mid, b);
    });

    // 点空白 / Esc / 滚日志 / 改窗口大小 → 收起自绘弹层
    document.addEventListener('pointerdown', e => {
      Object.keys(PICKERS).forEach(k => {
        const p = PICKERS[k];
        if(!p.menu || p.menu.classList.contains('hidden')) return;
        if(p.menu.contains(e.target) || p.btn.contains(e.target)) return;
        closeMenu(k);
      });
    }, true);
    document.addEventListener('keydown', e => {
      if(e.key !== 'Escape') return;
      const v = el('dgenView');
      if(v && !v.classList.contains('hidden')){ v.classList.add('hidden'); return; }
      closeMenus();
      closeModelCfg();
      closeImgCfg();
    });
    // 菜单自己内部滚动（当前项 scrollIntoView）不算「页面滚动」，否则一打开就自我关闭
    document.addEventListener('scroll', e => {
      const t = e.target;
      Object.keys(PICKERS).forEach(k => {
        const p = PICKERS[k];
        if(!p.menu || p.menu.classList.contains('hidden')) return;
        if(t && (t === p.menu || p.menu.contains(t))) return;
        closeMenu(k);
      });
    }, true);
    window.addEventListener('resize', () => closeMenus());

    /* 引擎被「别人」起好了（开机自动启动 / 模型控制台 / 本地生图 app）——这里要立刻跟上。
     * 不然缓存一直停在启动那一刻的 false，用户在卡片上看到「运行中」，
     * 到对话里出图却被拦一次「引擎没在运行」，只能靠点一下「去配置」自愈。 */
    window.addEventListener('engines-status', e => {
      const d = e && e.detail;
      if(!d || !d.comfy) return;
      if(d.comfy !== 'ready' && d.comfy !== 'already') return;
      if(typeof rtRefresh !== 'function') return;
      rtRefresh().then(() => {
        if(el('deskChatImg')) paintImgLabel(imgSourceInfo());
      }).catch(() => {});
    });

    renderModelSelect();
    /* 生图模型下拉首次渲染：清单要问引擎（一次往返），慢一点没关系，
     * 但必须渲染 —— 否则按钮上永远写着「未选生图模型」。 */
    renderImgModelSelect();
    setDot('', '就绪');
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 给测试与其它模块用
  window.deskChat = {
    send: send,
    open: openPanel,
    close: closePanel,
    refresh: function(){
      renderContextSelect(); renderModelSelect(); renderCtxLabel(); renderImgLabel();
      /* 生图模型下拉也要刷：设置页改了生图接口 / 读了新清单后，
       * 对话这边得能看到新模型（配置 hydrate 是异步的，不刷就永远停在旧清单）。 */
      imgModelSig = '';
      renderImgModelSelect();
    },
    msgs: function(){ return msgs; },
    atts: function(){ return atts; },
    ctxText: contextText,
    connFor: connFor,
    /* ---- 生图相关的对外接口（测试与其它面板用） ---- */
    imgMode: function(v){
      if(!v) return chatImgMode;
      if(v === 'auto' || v === 'image' || v === 'chat'){
        chatImgMode = v;
        try{ localStorage.setItem(IMG_MODE_KEY, v); }catch(e){}
        renderImgMode();
      }
      return chatImgMode;
    },
    imgSource: imgSourceInfo,
    /* 联网搜索开关（测试与别的面板用） */
    webSearch: toggleWebSearch,
    /* 配置自定义云端生图（测试与别的面板可以用，不必去点菜单） */
    imgCfg: { open: openImgCfg, close: closeImgCfg, values: imgCfgValues, save: imgCfgSave },
    /* 语言模型的配置弹层。设置页已经不再摆 Key / 地址输入框，
     * 「去配置」就是调这里——两边操作的是同一批设置字段，不另存。 */
    modelCfg: { open: openModelCfg, close: closeModelCfg },
    refine: function(on){
      if(on === undefined) return refineOn;
      refineOn = !!on;
      try{ localStorage.setItem(REFINE_KEY, refineOn ? '1' : '0'); }catch(e){}
      return refineOn;
    },
    cancelGen: cancelGen,
    lastImage: function(){ return lastImage; },
    setLastImage: function(src){ lastImage = src || ''; return lastImage; },
    route: routeOf,
    // 仅供截图/测试：塞入示例消息
    seed: function(){
      msgs.push({ id: ++msgSeq, role: 'user', content: '帮我看看这个工作流的结构' });
      msgs.push({ id: ++msgSeq, role: 'assistant', content: '这是一个 3 节点的流程：开始 → 生成图像 → 结束。\n右侧面板已经接管了输入框，可以继续追问。' });
      renderLog();
    }
  };
})();
