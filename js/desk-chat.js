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

  const CTX_KEY = 'hf_desk_ctx';
  const MODEL_KEY = 'hf_desk_model';
  const IMG_MODE_KEY = 'hf_desk_imgmode';
  const REFINE_KEY = 'hf_desk_imgrefine';

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
        try{ localStorage.setItem(p.cfg.storeKey, opt.value); }catch(e){}
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
      foot.appendChild(configEntry());
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

  /* 模型菜单底部那一行「＋ 配置自定义模型」 */
  function configEntry(){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dai-menu-cfg';
    b.id = 'daiCfgOpen';
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
    t.textContent = '配置自定义模型';
    b.append(svg, t);
    b.addEventListener('click', e => { e.stopPropagation(); openModelCfg(); });
    return b;
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
    return 'txt|' + cSig + '|' + (m.error ? 1 : 0) + '|' + (m.reasoning ? m.reasoning.length : 0);
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
    const sys = '你是 The seed 的桌面助手。回答准确、简洁，能给可执行的下一步，别编造不确定的信息。'
      + (ctx ? '\n' + ctx : '')
      + (chatImgMode === 'chat' ? '' : '\n' + IMG_SYS);
    const sent = historyForModel();

    busy = true;
    lockSend(true);
    setDot('busy', '生成中…');
    const reply = { id: ++msgSeq, role: 'assistant', content: '' };
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
    setDot('', '就绪');
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // 给测试与其它模块用
  window.deskChat = {
    send: send,
    open: openPanel,
    close: closePanel,
    refresh: function(){ renderContextSelect(); renderModelSelect(); renderCtxLabel(); renderImgLabel(); },
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
