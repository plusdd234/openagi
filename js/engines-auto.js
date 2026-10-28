/* 本地引擎自动启动（前端侧）
 *
 * 真正启动引擎的是主进程（electron/engine-autostart.js）。这个文件只做三件事：
 *   ① 把主进程推来的状态攒成一份，并广播成 window 事件 —— 引擎卡片、生图来源、
 *      对话页头都要读同一个结论，各存一份必然互相打架。
 *   ② Ollama 就绪后，把「桌面对话当前选中的那个本地模型」预热进显存。
 *   ③ 盯住「保活」：模型一直留在显存里，提问永不冷加载 → 永不弹黑窗口。
 *
 * ② 为什么必须做（实测，不是推测）：
 *   Ollama 冷加载模型要 4-5 秒（实测 4210 ms），热请求只要 42 ms。
 *   差别在于冷加载要派生 runner 进程把权重读进显存。第一条消息干等五秒，
 *   用户会以为程序卡死了。
 *
 * ③ 为什么必须做（这是「黑窗口」的治本，见 LOCAL-ENGINES.md 的完整证据链）：
 *   黑窗口 = Ollama **冷加载**时派生 GPU 探测子进程，那个子进程要新分配一个
 *   console → 触发 Windows 11 的默认终端委托 → 弹出 Windows Terminal 深色窗口。
 *   实测：冷加载 GPU 模型 = 6 个「曾经可见」的窗口；模型驻留后热请求 = 0 个。
 *   所以只要模型一直驻留，提问时就永远走热请求 → 黑窗口彻底绝迹。
 *   驻留由主进程每 10 分钟续一次期维持（electron/engine-keepalive.js）。
 *
 *   ⚠ 别再把这两件事拆开记：
 *   - 「预热」= 把那一次冷加载从「用户提问那一刻」挪到「客户端启动那一刻」；
 *   - 「保活」= 让它在那之后永远不再发生。
 *   两件都做完，黑窗口才真的没有了（早期只做了预热、且误以为黑窗与预热无关，
 *   那个判断后来被实测推翻了）。
 *
 * 为什么预热要放在前端：选中的模型存在 localStorage（hf_desk_model = "oll:<模型名>"），
 * 主进程根本看不到。所以由这里点名，主进程只负责转发给 11434。
 *
 * 预热默认开着（主进程 engines.json 的 warm:true）。它只对 `oll:` 开头的本地模型生效，
 * 用云端模型的用户完全不受影响，也不会白占显存。
 */
(function(){
  const ST = {
    idle:    { text: '待定',   tone: 'off' },
    off:     { text: '已关闭', tone: 'off' },
    absent:  { text: '未安装', tone: 'off' },
    already: { text: '已在运行', tone: 'ok' },
    starting:{ text: '启动中', tone: 'wait' },
    ready:   { text: '已就绪', tone: 'ok' },
    failed:  { text: '未启动', tone: 'wait' }
  };
  const WARM_KEY = 'hf_desk_model';   // 与 desk-chat.js 同一个键
  const WARMED_KEY = 'hf_desk_warmed'; // 同一模型不重复预热（同一会话内）

  const state = { ollama: 'idle', comfy: 'idle', note: '', ollamaNote: '', comfyNote: '', run: false, done: false, at: 0 };
  let primed = false;      // 已经跟主进程要过一次当前状态
  let warmTask = null;     // 在途的预热任务 { target, promise }
  let warmTimer = null;    // 排队中的调度定时器（同时只允许一个，见 scheduleWarm 注释）
  let warmFails = 0;       // 同一个模型连续预热失败次数（退避用）
  let warmFailModel = '';  // 上面那次失败对应的模型（用来区分「换了模型」和「同一次失败」）
  let keepModel = '';      // 已经登记进主进程保活器的模型
  let keepOk = false;      // 那次登记成功了没
  let warmed = '';
  /* 预热是「在对话真正开始之前」就要做完的事，所以不能只等一次 engines-status 事件：
   * ① 引擎就绪的时机和对话模型下拉框的取值时机不一定挨着（首次启动时后者更晚）；
   * ② 只用云端模型的用户永远没有 `oll:` 模型，不该一直重试。
   * 这里用一个「每 5 秒看一眼、最多 12 次」的轻量轮询把两件事对上，
   * 一旦选中的是本地模型就立刻预热；连续失败就放弃，不给用户添乱。 */
  let warmTries = 0;
  const WARM_POLL_MS = 5000;
  const WARM_MAX_TRIES = 12;
  const WARM_MAX_FAILS = 3;   // 连续失败几次就放弃这一轮（避免反复冷加载）

  function desk(){
    const d = window.openagiDesktop;
    return d && typeof d === 'object' ? d : null;
  }

  function label(key){
    const s = ST[state[key]] || ST.idle;
    return s.text;
  }
  function tone(key){
    const s = ST[state[key]] || ST.idle;
    return s.tone;
  }

  function broadcast(){
    try{
      window.dispatchEvent(new CustomEvent('engines-status', { detail: status() }));
    }catch(e){ /* 老浏览器没有 CustomEvent 构造器也无所谓，卡片会自己轮询 */ }
  }

  function status(){
    return {
      ollama: state.ollama, comfy: state.comfy,
      note: state.note, ollamaNote: state.ollamaNote, comfyNote: state.comfyNote,
      run: state.run, done: state.done, at: state.at,
      ollamaText: label('ollama'), comfyText: label('comfy'),
      ollamaTone: tone('ollama'), comfyTone: tone('comfy')
    };
  }

  function apply(next){
    if(!next || typeof next !== 'object') return;
    if(typeof next.ollama === 'string') state.ollama = next.ollama;
    if(typeof next.comfy === 'string') state.comfy = next.comfy;
    if(typeof next.note === 'string') state.note = next.note;
    if(typeof next.ollamaNote === 'string') state.ollamaNote = next.ollamaNote;
    if(typeof next.comfyNote === 'string') state.comfyNote = next.comfyNote;
    state.run = !!next.run;
    state.done = !!next.done;
    state.at = Number(next.at) || Date.now();
    broadcast();
    // 引擎状态一变就重新看一眼预热：可能是刚就绪（该预热了），
    // 也可能只是别的字段变了（那这次调用会很快返回，什么也不做）。
    scheduleWarm();
  }

  /* 读出「当前选中的本地模型名」（非本地模型返回空串）。
   * 只认 `oll:` 前缀——云端网关（gw:）和自定义接口（local:）都在远端，
   * 预热它们既做不到也没意义。 */
  function currentLocalModel(){
    try{
      const v = localStorage.getItem(WARM_KEY) || '';
      if(v.indexOf('oll:') === 0) return v.slice(4);
    }catch(e){}
    return '';
  }

  /* Ollama 就绪后预热当前本地模型。失败一律静默：
   * 用户可能用的是云端模型，预热成不成功和他接下来要干的事毫无关系。
   *
   * model 参数：传了就预热指定的模型（对话发送前的兜底会点名具体模型），
   * 不传就预热「当前选中的那个本地模型」（启动阶段的调度器用这个）。
   * force：true 表示「哪怕这个会话预热过也要再来一次」。
   *   为什么需要 force：模型驻留超过 keep_alive 会被 Ollama 卸载，
   *   这时「本会话预热过」这个记忆就过期了，照着它跳过 = 又一次冷加载。
   *
   * 并发：预热进行中时再来请求，不是不等就是直接返回 false——
   * 后者最坏（发送前兜底以为「预过了」，其实正卡在加载中途）。
   * 所以这里记下在途的 promise，后来者 await 同一个任务。 */
  async function maybeWarm(model, force){
    if(state.ollama !== 'ready' && state.ollama !== 'already') return false;
    const d = desk();
    if(!d || typeof d.enginesWarm !== 'function') return false;
    const target = String(model || currentLocalModel() || '').trim();
    if(!target) return false;
    if(!force && warmed === target) return false;
    // 同一个模型只在这个会话里预热一次：Ollama 自己会 keep_alive，重复打过来纯属浪费显存
    if(!force){
      try{
        if(sessionStorage.getItem(WARMED_KEY) === target) { warmed = target; return false; }
      }catch(e){ /* sessionStorage 不可用就退化成内存判断 */ }
    }
    // 已经在预热同一个模型了：等它完事，不要并发打两次
    if(warmTask && warmTask.target === target) return warmTask.promise;
    const task = { target };
    task.promise = (async () => {
      try{
        const r = await d.enginesWarm({ model: target });
        if(r && r.ok){
          warmed = target;
          warmFails = 0;
          warmFailModel = '';
          try{ sessionStorage.setItem(WARMED_KEY, target); }catch(e){}
          /* 主进程在预热成功时已经把这个模型登记进保活器了（它会每 10 分钟续期），
           * 模型就一直留在显存里 → 提问走热请求 → 不会冷加载 → 不会弹黑窗口。
           * 这里不用重复登记，主进程那边是幂等的。 */
          return true;
        }
      }catch(e){ /* 预热不是功能，别让它冒泡 */ }
      finally{ if(warmTask === task) warmTask = null; }
      return false;
    })();
    warmTask = task;
    return task.promise;
  }

  /* 预热的调度器：把「引擎就绪」和「模型已选定」这两件各自独立的事对上。
   *
   * 为什么要有轮询而不是只听事件：
   *   引擎就绪（主进程推 engines-status）和模型下拉框取到值（渲染进程读 localStorage）
   *   谁的时序都不保证。首次启动时前者早（开机 1.2 秒就起引擎），后者要等
   *   renderModelSelect() 跑完（要先去桥上问一遍模型清单）。只听一次事件必然漏。
   *
   * 为什么轮询有上限：
   *   用云端模型的用户永远没有 `oll:` 模型，不该每 5 秒醒一次。
   *   连续 12 次（约 1 分钟）还没等到，就认为这个会话不需要预热，安静收手。
   *
   * ⚠ 为什么必须「同时只允许一个定时器」（warmTimer）：
   *   scheduleWarm 会被多处触发——apply()（每次引擎状态变化）、onModelChanged()、
   *   以及它自己的递归。早期没有这个约束，结果是：
   *     一次选模型 → 并行 9 个定时器 → 打了 9 次预热 → 每次都重置 keep_alive，
   *     彼此把对方顶掉 → 模型始终没驻留（实测 /api/ps 为空），
   *     而且每次预热都是一次冷加载 = 一次黑窗口。
   *   这不是理论风险，是实测出来的。教训：预热这种「有副作用的幂等操作」
   *   必须有单一调度点。 */
  function scheduleWarm(){
    if(warmTries >= WARM_MAX_TRIES) return;
    if(warmTimer) return;                 // 已经有一个在排队了，别再叠一个
    warmTries++;
    const wait = warmTries === 1 ? 800 : WARM_POLL_MS;
    warmTimer = setTimeout(async () => {
      warmTimer = null;
      const ok = await maybeWarm();
      if(ok){ warmFails = 0; return; }        // 成了就收手
      /* 连续失败就退避：预热失败大多是「模型加载不出来」，
       * 再打下去只是反复触发冷加载（= 反复弹黑窗口），毫无意义。
       * 3 次不成就把这一轮放弃，等用户下次换模型或发送消息时再试
       * （发送前的兜底 ensureLocalModelWarm 会点名重试一次）。 */
      warmFails++;
      // 记下这次失败是哪个模型的：onModelChanged 靠它区分
      // 「用户换了新模型（该重新给机会）」和「还是同一个模型在失败（不该重置退避）」
      if(!warmFailModel) warmFailModel = currentLocalModel();
      if(warmFails >= WARM_MAX_FAILS){ warmTries = WARM_MAX_TRIES; return; }
      if(warmTries < WARM_MAX_TRIES) scheduleWarm();
    }, wait);
  }

  /* 用户在对话里换了模型：如果换成另一个本地模型，新模型也得预热，
   * 否则「换模型后的第一句话」又会冷加载一次，又要干等四五秒。
   *
   * 换模型还要同步「保活目标」：主进程那边保活的是**一个**模型，
   * 换了就得把新的登记进去、把旧的卸掉——不然旧模型还占着显存
   * （实测 /api/ps 会同时列出两个，qwen3-vl:8b + qwen2.5:3b 合计 8.4 GB），
   * 而新模型又没被保活，下次提问照样冷加载。 */
  function onModelChanged(){
    const model = currentLocalModel();
    if(!model || model === warmed) return;
    /* 只在「模型真的换了」时才重置失败计数。
     *   ⚠ 之前是无条件重置 —— 结果是同一个模型预热失败时，
     *   onModelChanged 每次都把失败计数清零，退避形同虚设
     *   （实测一直失败时打了 5 次才停，而不是 3 次）。
     *   现在记下上次失败时的模型：还是它，就说明是同一次失败，
     *   不该重新给机会。 */
    if(warmFailModel !== model){
      warmTries = 0;          // 换模型 = 全新的一次机会
      warmFails = 0;
      warmFailModel = model;
    }
    // 换模型 = 新的模型要预热。如果已经有一个定时器在排队，
    // 让它跑完这一轮就行（它读的是「当前选中的模型」，不是写死的），
    // 所以这里不再叠一个新的定时器——叠了就是风暴。
    scheduleWarm();
    syncKeepalive(model);
  }

  /* 把「要保活哪个模型」告诉主进程。
   * 主进程在预热成功时也会登记一次，这里是补齐「先预热过、后换模型」这条路径。
   * 失败不致命——保活只是锦上添花（预热本身已经把冷加载挪到了启动时）。
   *
   * ⚠ 为什么要记 keepModel 去重：
   *   hf-desk-model-changed 会被派发多次（模型清单渲染一次、用户改一次，
   *   实测同一次选模型收到 3 次），每次都登记一遍纯属浪费 IPC。
   *   主进程那边是幂等的（setModel 同一个模型直接返回），
   *   但省掉这次往返更干净，也少一次「续期」请求。 */
  async function syncKeepalive(model, force){
    const d = desk();
    if(!d || typeof d.enginesKeepalivePing !== 'function') return false;
    const m = String(model || '').trim();
    if(!m) return false;
    if(!force && keepModel === m && keepOk) return true;   // 已经登记过同一个模型了
    try{
      const r = await d.enginesKeepalivePing({ model: m, force: !!force });
      keepOk = !!(r && r.ok);
      if(keepOk) keepModel = m;
      return keepOk;
    }catch(e){ return false; }
  }

  async function refresh(){
    const d = desk();
    if(!d || typeof d.enginesStatus !== 'function') return status();
    try{
      apply(await d.enginesStatus());
    }catch(e){}
    return status();
  }

  function init(){
    const d = desk();
    if(!d) return;                       // 浏览器直开：没有本地引擎这回事
    if(typeof d.onEngineStatus === 'function') d.onEngineStatus(apply);
    if(!primed){
      primed = true;
      // 主进程的自动启动可能在页面加载完之后才跑完，所以进来先对一次表
      refresh();
    }
    /* 引擎状态之外还要盯一件独立的事：对话里换了本地模型。
     * 换了模型 = 新的权重要读进显存 = 不预热就会在用户提问那一刻冷加载
     * = 又一次四五秒的干等。desk-chat.js 在模型变更时会调这里。 */
    window.addEventListener('hf-desk-model-changed', onModelChanged);
  }

  window.engineAuto = {
    status,
    refresh,
    apply,
    /* warmNow()：预热「当前选中的本地模型」，本会话只做一次。
     * warmNow(model, true)：点名预热某个模型并强制执行（对话发送前的兜底用）。
     *   强制的原因：模型可能已经被 Ollama 卸载（keep_alive 过期），
     *   这时「本会话预热过」的记录是过期的，跳过就等于又冷加载一次。 */
    warmNow: function(model, force){ return maybeWarm(model, force); },
    /* keepAlive(model)：把模型登记进主进程的保活器（每 10 分钟续一次期，
     * 模型就一直留在显存里 → 提问永不冷加载 → 永不弹黑窗口）。
     * 不传 model 就是用「当前选中的本地模型」。
     * force=true 时无视去重，强制续一次期——
     * 发送前的兜底要用它：模型可能已经被 Ollama 卸载（keep_alive 到期），
     * 这时必须重新把它拉回来。 */
    keepAlive: function(model, force){
      const m = String(model || currentLocalModel() || '').trim();
      if(!m) return Promise.resolve(false);
      return syncKeepalive(m, force);
    },
    /* keepAliveStatus()：当前保活着哪个模型（界面显示用）。 */
    keepAliveStatus: async function(){
      const d = desk();
      if(!d || typeof d.enginesKeepalive !== 'function') return null;
      try{ return await d.enginesKeepalive(); }
      catch(e){ return null; }
    },
    onModelChanged,
    label, tone,
    get states(){ return ST; }
  };

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
