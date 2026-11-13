/* 桌面 AI 对话：顶部标签 / 输入模式 / 发送 / init / 对外接口
 *
 * 从 js/desk-chat.js 拆出（2026-11-01），见 desk-chat-core.js 顶部说明。
 * ⚠ 这是四段里唯一带顶层可执行代码的文件（事件绑定、init 调用、window.deskChat），
 *   必须最后加载：先前三段把函数声明就位后才能跑。
 */
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
    (function(){ try{ return confGet('imgModel'); }catch(e){ return ''; } })(),
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
  if(isChatBusy()) return;
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
    /* 搜索也进轨迹。它没有对应节点，所以不会写进流程，
     * 但要出现在「没映射的步骤」里 —— 用户得知道存下来的流程少了哪一段。 */
    traceCap('webSearch', {
      ok: !!(pack && pack.ok),
      ms: Number(pack && pack.ms) || 0,
      engine: String((pack && pack.provider) || ''),
      inputs: { query: text, count: Number(pack && pack.results && pack.results.length) || 0 },
      outKind: 'web',
      error: (pack && !pack.ok) ? String(pack.error || '') : ''
    });
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

  /* 进锁：lockSend(true) 在 chatBusyEnter 里，别在外面再锁一次——
     两处都写就会出现「谁先谁后」的隐性依赖。票在 finally 里交回去。 */
  const busyTicket = chatBusyEnter();
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
    }, { conn: conn, app: 'chat' });
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
    chatBusyLeave(busyTicket);
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

  /* ---- 存成流程：按钮 + 上一次对话恢复 ---- */
  const sfBtn = el('btnChatSaveFlow');
  if(sfBtn) sfBtn.addEventListener('click', () => saveChatFlow(sfBtn));
  const sfX = el('btnChatSaveFlowX');
  if(sfX) sfX.addEventListener('click', () => {
    saveFlowDismissed = true;
    refreshSaveFlow();
  });

  /* 恢复上一次对话（含轨迹）。
   * ?nostore=1 是测试模式：只禁写不禁读，但**对话恢复要跳过** ——
   * 否则上一条用例留下的消息会让「空白态」断言全红（这个坑踩过一次）。 */
  try {
    const nostore = /[?&]nostore=1\b/.test(location.search);
    if(!nostore && typeof chatLoad === 'function'){
      chatLoad().then(r => {
        if(!r || !Array.isArray(r.msgs) || !r.msgs.length) return;
        if(msgs.length) return;              // 已经开聊了，别覆盖
        r.msgs.forEach(m => {
          if(!m || typeof m !== 'object') return;
          /* 大图没入库（超过 260KB 的 data URL）：不要让它渲染成一张破图，
           * 明确说「这张没存下来」，用户点重新生成即可。 */
          if(m.imgDropped){
            m.image = '';
            m.phase = 'error';
            m.error = '这张图太大，没能存进本地缓存（重新生成即可）';
          }
          msgs.push(m);
          const n = Number(m.id);
          if(isFinite(n) && n > msgSeq) msgSeq = n;
        });
        renderLog();
      }).catch(() => {});
    }
  } catch(e){}

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

/* 模型库 →「发到 AI 对话」：把结构参考 / 着色参考当附件带进来。
 * 为什么走事件而不是模型库直接调：atts 是对话的私有状态，模型库不该伸手进来改；
 * 事件是唯一不越界的接缝，而且对话没开也能收（openPanel 顺手把它挂起来）。 */
window.addEventListener('openagi:model-refs', function (e) {
  const d = (e && e.detail) || {};
  const refs = d.refs || {};
  const list = [refs.structure, refs.color].filter(Boolean);
  if (!list.length) return;
  openPanel();
  const added = [];
  list.forEach(function (r) {
    if (!r || !r.dataURL) return;
    /* 同一张图重复点两次不叠两份附件；但结构 / 着色是两张不同的图时才两件都要 */
    if (atts.indexOf(r.dataURL) >= 0) return;
    atts.push(r.dataURL);
    added.push(r);
  });
  renderAtts();
  const input = el('deskAiText');
  if (added.length && input && !input.value.trim()) {
    /* 按实际带了哪几张写提示：只有着色参考时不能说「第一张是结构参考」 */
    const parts = [];
    const hasStruct = added.some(function (r) { return r === refs.structure; });
    const hasColor = added.some(function (r) { return r === refs.color; });
    if (hasStruct) parts.push('结构参考（按它的形体、比例、剪影来做）');
    if (hasColor) parts.push('着色参考（配色、贴图、材质按它）');
    input.value = '附件里给了' + parts.join('和') + '。模型：' + (d.modelName || d.modelId || '未命名') + '。';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  deskToast(added.length ? ('已带入 ' + added.length + ' 张参考图') : '这两张参考图已经在附件里了');
});

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