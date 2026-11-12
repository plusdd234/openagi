/* 编码 Agent：能对话、能读文件、能改代码 —— 但**改不改由人定**
 *
 * 这个模块是整个编码能力的安全拐点，四条规矩写在这里，改之前先读完：
 *
 *   ① **AI 没有写盘权。** 它只能提改动（fs_edit / fs_new），改动变成一张 diff 卡片，
 *      人点「应用」才真的调 codeWrite。这不是保守，是因为「信任 AI 直接改代码」
 *      的失败代价是**静默写坏一个文件**，而人扫一眼 diff 只要两秒。
 *      注意：这条一旦被绕过（比如给模型一个直接写盘的工具），整套确认机制就废了。
 *
 *   ② **提示词里不能承诺它做不到的事。** 提示词明确告诉它「你说改好了的时候，
 *      用户可能点的是放弃」，否则它会一遍遍宣称「已修复」而实际什么都没发生 ——
 *      模型不知道磁盘状态，只会顺着自己的叙述走。
 *
 *   ③ **脏文件拒绝改。** 用户正在编辑、有未保存改动的那个文件，AI 一律不许碰。
 *      否则：AI 写盘 → 用户的编辑器里还是旧内容 + dirty → 用户 Ctrl+S → 哈希不匹配
 *      报错 → 用户以为保存成功，实际 AI 的版本被自己的旧内容盖掉。这条路径很难排查，
 *      所以直接堵死，让用户先保存。
 *
 *   ④ **真正的问题是省轮次，不是省 token。** 每个工具的返回都要自解释：
 *      读文件带行号范围、找不到 old 时直接告诉它「第一行能不能找到」，
 *      因为它多跑一轮就是一次完整往返（几秒 + 一笔钱）。
 *
 * 依赖：js/code-diff.js（纯逻辑，可单测）、window.toolLoopRun（通用循环）、
 *       window.llmConn（凭据）、window.openagiDesktop 的 code* 接口。
 */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);

  /* ---------------- 系统提示词 ---------------- */

  const SYS_BASE = [
    '你是「编码」应用里的工程助手，在一个用户选定的本地代码工作区里干活。',
    '所有路径都相对工作区根目录，不要用绝对路径。',
    '',
    '## 工作方式',
    '1. 先弄清现状再动手：ws_tree 看结构，ws_read 读真实内容。**不许凭想象写代码。**',
    '2. 改代码只用 fs_edit，old 必须是从 ws_read 结果里逐字复制的一段（含缩进），',
    '   并且整段在文件里**只出现一次**。不唯一就把 old 写长一点，带上上下文。',
    '3. 新建文件用 fs_new。修改已有文件不要用 fs_new 覆盖。',
    '   图片 / 字体这类二进制用 ws_put（来源给 b64，或给资产库的 asset id）。',
    '4. 一次只做一件事。改完一处，看工具返回的结果，再决定下一步。',
    '5. 找不到文件就用 ws_tree / ws_search，不要猜路径。',
    '',
    '## 写页面（HTML / 前端）',
    '用户能点编辑器上的「预览」看页面的真实效果，预览跑的是磁盘上的文件。',
    '- 写完或改完后，一句话告诉用户「点预览看看」，不要自己描述页面长什么样 —— 他会直接看。',
    '- **优先做成单文件能跑的**：一个 .html 里带样式和脚本，双击、预览都能开。',
    '  只有在用户明确要工程化（React / Vite / 多页）时才拆文件、建 package.json。',
    '- 引用资源用**相对路径**（`./style.css`、`img/logo.png`），不要用 `/style.css` ——',
    '  工作区不是网站根目录，绝对路径会 404。',
    '- 预览面板会把页面里的报错（JS 异常、资源 404）回传给你。如果用户说他看到了报错，',
    '  那些错误会以 <LAST_PREVIEW_ERRORS> 的形式出现在你这一轮的事实里，照着改就行。',
    '',
    '## 关于「改动有没有生效」',
    'fs_edit / fs_new 提交后会变成一张 diff 卡片，由用户点「应用」或「放弃」。',
    '**工具会一直等到用户点完才返回**，所以返回值是可信的：',
    '- applied=true 表示用户已经点过「应用」，改动**真的写进磁盘了**，可以直说"已改动"。',
    '- declined=true 表示用户放弃了这个改动，文件没有变化。不要把它说成"已完成"，',
    '  也不要原样重试同一个改动 —— 先问用户哪里不对。',
    '',
    '## 收尾',
    '改完之后用一两句话说明改了什么就结束。',
    '**不要为了"确认生效"重新读文件、重新扫目录** —— 那会白白多跑好几轮，',
    '而 applied=true 已经说明生效了。需要改多处时，逐个提交，最后一次总结。',
    '',
    '## 验证（重要）',
    '改完之后**尽量用 run_cmd 跑一次相关验证**，而不是只靠读代码判断对不对：',
    '- 有测试就跑到相关的那个文件（`npx vitest run tests/calc.test.js`），别默认跑全量 ——',
    '  全量可能几分钟，用户每次都要等。',
    '- 有 typescript 就跑 `npx tsc --noEmit`；有 lint 就 lint 改动涉及的文件。',
    '- 纯脚本类改动可以直接 `node <文件>` 跑一遍看输出。',
    '命令失败时：**先读报错定位，再改，改完再跑同一条命令**。同一个报错连着两次没解决，',
    '就停下来把报错和你的判断告诉用户，不要反复盲试。',
    '没有可跑的东西（比如只改了注释）就直接说明"没有可自动验证的部分"，不用硬凑命令。',
    '',
    '## 不要做的事',
    '- 不主动重构、不顺手优化没被要求的地方。改动越小越好，人越容易审。',
    '- 不要创建 *.md 文档，除非用户明确要求。',
    '- 不要在对话里贴大段代码 —— 改动走 fs_edit，用户在 diff 里看。',
    '- 不要用 run_cmd 装依赖（`npm install`）、不要提交（`git commit`）、不要改全局配置。',
    '  这些会改用户的环境，不是"验证代码"。真需要就告诉用户，让他自己决定。',
    '- 工具返回什么就说什么。失败就说失败，不要把失败描述成「大致完成」。'
  ].join('\n');

  /* ---------------- 工具定义 ---------------- */

  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'ws_tree',
        description: '一次看到工作区的目录结构（默认 3 层，跳过 node_modules/.git 这类目录）。开工第一步就该调它，比逐层 ws_list 省很多轮。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的子目录，留空表示根目录' },
            depth: { type: 'number', description: '展开层数 1-6，默认 3' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ws_list',
        description: '列一个目录的**下一层**条目（名字、类型、大小）。只在 ws_tree 不够细时用。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '相对工作区的目录，留空表示根' } },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ws_read',
        description: '读文件内容。返回带行号的预览（"  12| code"）。**行号只是标注，不属于文件内容** —— 写 fs_edit 的 old 时不要带行号。大文件用 start/end 分段读。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的文件路径' },
            start: { type: 'number', description: '起始行（从 1 开始），默认 1' },
            end: { type: 'number', description: '结束行（含）。不给则默认往下读 400 行' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ws_search',
        description: '在工作区里全文搜索一个字符串（区分大小写），返回命中位置（文件 + 行号 + 该行内容）。找某个函数/变量在哪定义时用它。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '要找的原文片段' } },
          required: ['query']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fs_edit',
        description: '提交一处改动：把文件里的 old 精确替换成 new。old 必须在文件里唯一出现。这是一个**提案**，用户点应用后才落盘。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的文件路径' },
            old: { type: 'string', description: '要被替换的原文片段，必须和文件内容逐字一致（含缩进），且在文件里只出现一次' },
            new: { type: 'string', description: '替换成的新内容；传空串表示删除这段' },
            why: { type: 'string', description: '一句话说明为什么改这里（显示在 diff 卡片上给人看）' }
          },
          required: ['path', 'old', 'new']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'fs_new',
        description: '提交一个新文件（路径已存在会报错，改已有文件请用 fs_edit）。同样是提案，用户点应用后落盘。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的新文件路径' },
            content: { type: 'string', description: '完整文件内容' },
            why: { type: 'string', description: '一句话说明这个文件的用途' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'ws_put',
        description: '往工作区放一个**二进制文件**（图片 png/jpg/webp/gif、字体 woff2、音频）。文本文件不要用它，用 fs_new。'
          + '来源二选一：b64（你自己编码的 base64，可以带 data: 前缀）或 asset（资产库里某个文件的 id，直接复制过来）。'
          + '同样是提案，用户点「放入」后才落盘。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对工作区的目标路径，例如 assets/logo.png' },
            b64: { type: 'string', description: 'base64 内容；不要和 asset 同时给' },
            asset: { type: 'string', description: '资产库的文件 id；从这个资产复制二进制，不用你手写 base64' },
            force: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
            why: { type: 'string', description: '一句话说明这个文件用在哪' }
          },
          required: ['path']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_cmd',
        description: '在工作区里执行一条命令（跑测试、编译、lint、看 git diff）。**用来验证你的改动到底对不对** —— 改完代码应该跑一次相关测试，别只是"看起来对"。'
          + '只支持单条命令，不支持管道 / 重定向 / && 串接。可用程序：node npm npx pnpm yarn bun git python python3 py。'
          + '每次执行前都要用户点「运行」，所以别用无关命令试探。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '完整命令行，例如 "npm test" 或 "node src/calc.js"（相对工作区）' },
            cwd: { type: 'string', description: '在哪个子目录执行，相对于工作区，默认根目录' },
            timeout: { type: 'number', description: '超时秒数 1-300，默认 60' },
            why: { type: 'string', description: '一句话说明为什么要跑这条命令（给用户看，决定批不批）' }
          },
          required: ['command']
        }
      }
    }
  ];

  /* ---------------- 状态 ---------------- */

  const state = {
    mounted: false,
    busy: false,
    ctrl: null,
    api: null,
    hooks: null,
    chat: [],        // [{role:'user'|'assistant', text}] 跨轮上下文，只留最终文本
    pending: null,   // 正在等用户确认的 { decide } —— 中止时要用它把人质放掉
    lastFile: '',
    runAuto: false,      // 本对话内是否已授权直接运行命令（用户勾的）
    runListeners: [],    // 命令输出的流式订阅者（每张运行卡片一个）
    activeRunId: ''      // 正在跑的 runId —— 「停止」按钮和 abort() 都要用它
  };

  const MAX_PREVIEW_LINES = 400;

  function api(){ return state.api || global.openagiDesktop || null; }
  function errText(e){
    if(!e) return '未知错误';
    const m = e.message || (e.error && e.error.message) || '';
    if(m) return String(m).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
    return String(e);
  }
  function esc(s){
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------- 骨架 ---------------- */

  function mount(opts){
    if(state.mounted) return;
    const host = (opts && opts.host) || $('caBody');
    if(!host) return;
    state.api = (opts && opts.api) || global.openagiDesktop;
    state.hooks = (opts && opts.hooks) || {};

    const el = document.createElement('aside');
    el.className = 'ca-agent';
    el.id = 'caAgent';
    el.innerHTML = [
      '<div class="ca-ag-head">',
      '  <span class="ca-ag-dot" id="caAgDot"></span>',
      '  <span class="ca-ag-title">编码助手</span>',
      '  <span class="ca-ag-model" id="caAgModel"></span>',
      '  <span class="ca-grow"></span>',
      '  <button type="button" class="ca-btn ca-ag-mini" id="caAgClear" title="清空对话">清空</button>',
      '</div>',
      '<div class="ca-ag-log" id="caAgLog"></div>',
      '<div class="ca-ag-foot">',
      '  <textarea class="ca-ag-input" id="caAgInput" rows="2" spellcheck="false"',
      '    placeholder="说明要做什么，例如：给 login 加一个 5 次失败锁定（Ctrl+Enter 发送）"></textarea>',
      '  <div class="ca-ag-actions">',
      '    <span class="ca-ag-state" id="caAgState"></span>',
      '    <span class="ca-grow"></span>',
      '    <button type="button" class="ca-btn ca-ag-stop" id="caAgStop" hidden>停止</button>',
      '    <button type="button" class="ca-btn ca-ag-send" id="caAgSend">发送</button>',
      '  </div>',
      '</div>'
    ].join('');
    host.appendChild(el);
    state.mounted = true;

    /* 命令输出是主进程推过来的事件流，这里订阅一次分发给各张卡片。
     * 只订阅一次（不是每张卡片一次）—— 卡片只管按 runId 认领自己的那份。 */
    if(state.api && typeof state.api.onCodeRunOutput === 'function'){
      state.api.onCodeRunOutput(ev => {
        for(const fn of state.runListeners.slice()) {
          try { fn(ev); } catch(e) { /* 一张卡片出错不能拖垮其它卡片 */ }
        }
      });
    }

    $('caAgSend').addEventListener('click', () => {
      const box = $('caAgInput');
      const text = (box.value || '').trim();
      if(!text) return;
      box.value = '';
      send(text);
    });
    $('caAgInput').addEventListener('keydown', e => {
      // Ctrl/Cmd+Enter 发送；单独 Enter 换行（写多行的需求很常见）
      if((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        $('caAgSend').click();
      }
    });
    $('caAgStop').addEventListener('click', abort);
    $('caAgClear').addEventListener('click', () => {
      if(state.busy) return;
      state.chat = [];
      $('caAgLog').innerHTML = '';
      welcome();
      setPhase('');
    });

    welcome();
    paintModel();
  }

  function paintModel(){
    const el = $('caAgModel');
    if(!el) return;
    let conn = null;
    try { conn = (typeof global.llmConn === 'function') ? global.llmConn() : null; } catch(e){ conn = null; }
    el.textContent = (conn && conn.model) ? conn.model : '';
    el.title = (conn && conn.model) ? (conn.via === 'gateway' ? '云端网关' : '自定义接口') + ' · ' + conn.model : '';
  }

  function welcome(){
    const log = $('caAgLog');
    if(!log || log.children.length) return;
    addNote('说明要做什么，它会先读代码，改动会变成 diff 让你确认。');
  }

  /* 忙状态标记：顶栏那个小圆点靠它变色，否则用户只能靠"没有反应"猜 */
  function setBusy(on){
    const el = $('caAgent');
    if(el) el.classList.toggle('is-busy', !!on);
  }

  /* ---------------- 日志渲染 ---------------- */

  function scrollEnd(){
    const log = $('caAgLog');
    if(log) log.scrollTop = log.scrollHeight;
  }

  function addNote(text){
    const log = $('caAgLog');
    if(!log) return null;
    const d = document.createElement('div');
    d.className = 'ca-ag-note';
    d.textContent = text;
    log.appendChild(d);
    scrollEnd();
    return d;
  }

  function addUser(text){
    const log = $('caAgLog');
    const d = document.createElement('div');
    d.className = 'ca-ag-user';
    d.textContent = text;
    log.appendChild(d);
    scrollEnd();
    return d;
  }

  function addAssistant(){
    const log = $('caAgLog');
    const d = document.createElement('div');
    d.className = 'ca-ag-say';
    d.innerHTML = '<span class="ca-ag-say-body"></span>';
    log.appendChild(d);
    scrollEnd();
    return d;
  }

  /* 流式正文往气泡里写。
   * ⚠ onDelta 的**第一个参数是累计全文**（acc），第二个才是本次增量 ——
   *   用增量去 += 会渲染成「已已提交已提交 已提交 1…」。
   *   这里直接用累计值赋值：即使某次回调丢了也能自愈。 */
  function setSay(bubble, full){
    if(!bubble) return;
    const body = bubble.querySelector('.ca-ag-say-body');
    if(!body) return;
    body.textContent = full == null ? '' : String(full);
    scrollEnd();
  }

  function addToolLine(title, detail){
    const log = $('caAgLog');
    const d = document.createElement('div');
    d.className = 'ca-ag-tool';
    d.innerHTML = '<span class="ca-ag-tool-name">' + esc(title) + '</span>'
      + (detail ? '<span class="ca-ag-tool-det">' + esc(detail) + '</span>' : '');
    log.appendChild(d);
    scrollEnd();
    return d;
  }

  function addError(text){
    const log = $('caAgLog');
    const d = document.createElement('div');
    d.className = 'ca-ag-err';
    d.textContent = text;
    log.appendChild(d);
    scrollEnd();
    return d;
  }

  function setPhase(text, cls){
    const el = $('caAgState');
    if(!el) return;
    el.textContent = text || '';
    el.className = 'ca-ag-state' + (cls ? ' ' + cls : '');
  }

  /* ---------------- 连接检查 ---------------- */

  function pickConn(){
    if(typeof global.llmConn !== 'function') return null;
    let conn = null;
    try { conn = global.llmConn(); } catch(e){ return null; }
    if(!conn || !conn.base || !conn.key || !conn.model) return null;
    return conn;
  }

  /* ---------------- 发送 ---------------- */

  async function send(text){
    if(state.busy) return;
    const conn = pickConn();
    if(!conn){
      addError('还没有配置语言模型。去「设置」里填接口地址 / Key / 模型，或者登录云端账号后再来。');
      return;
    }
    if(!state.hooks || !state.hooks.hasWorkspace || !state.hooks.hasWorkspace()){
      addError('先选一个文件夹。助手需要在工作区里读代码。');
      return;
    }

    state.busy = true;
    state.ctrl = new AbortController();
    state.chat.push({ role:'user', text: text });
    addUser(text);
    const bubble = addAssistant();
    setPhase('思考中…');
    setBusy(true);
    $('caAgStop').hidden = false;
    $('caAgSend').disabled = true;
    $('caAgInput').disabled = true;

    let finalText = '';
    let endReason = 'done';
    const T = traceOn();
    if(T){
      try{ T.start({ model: (conn && conn.model) || '', ws: wsName() }); }catch(e){}
    }
    try{
      const res = await global.toolLoopRun({
        sys: buildSys(),
        messages: [{ role:'user', content: text }],
        tools: TOOLS,
        /* 8 轮在「只改代码」时够用，但加上验证就紧了：
         * 读 → 改 → 跑测试挂 → 再改 → 再跑 → 收尾，正好 6 次工具调用，
         * 中间再看一眼别的文件就到顶了。截断的代价是任务半途而废，比多跑两轮贵得多。 */
        maxRounds: 10,
        /* 留 2 轮完整往返：编码任务里只留 1 轮会让模型丢掉「我刚改完了」，
         * 于是应用完 diff 又回头反复读文件确认（实测多跑 7 轮）。 */
        keepRounds: 2,
        conn: conn,
        signal: state.ctrl.signal,
        executor: runTool,
        digest: digestOf,
        digestArgs: digestArgsOf,
        facts: factsOf,
        onDelta: (d) => setSay(bubble, d),
        /* 轮次边界。tool-loop 已经有这个回调，所以这里不需要改它的任何逻辑 ——
         * 轨迹只是借用了一个已经存在的信号，插桩成本接近零。 */
        onRound: (r) => {
          const TT = traceOn();
          if(TT){ try{ TT.turn(r.round, r.phase); }catch(e){} }
        },
        onToolStart: (call) => {
          setPhase('执行 ' + call.name + '…');
          addToolLine(call.name, argHint(call.name, call.args));
        },
        onTool: (rec) => {
          // 已经在 onToolStart 里画了行，这里只把结果摘要补上去
          if(rec && rec.error) setPhase('工具报错，模型正在重试…', 'warn');
        }
      });

      finalText = String((res && res.text) || '').trim();
      if(finalText) {
        const body = bubble.querySelector('.ca-ag-say-body');
        if(body && !body.textContent.trim()) body.textContent = finalText;
      } else {
        bubble.remove();
      }
      if(res && res.exhausted) {
        endReason = 'exhausted';
        /* 不要把轮数写死在文案里：改了 maxRounds 而忘了改这里，
         * 界面就会说一个假的数字，看着还挺权威。 */
        addNote('已达到本轮工具调用上限。可以让它继续，或者把任务说小一点。');
      }
    }catch(e){
      const msg = errText(e);
      if(/stop|中止|abort/i.test(msg) && state.ctrl && state.ctrl.signal.aborted){
        endReason = 'aborted';
        addNote('已停止。');
      }else{
        endReason = 'error';
        if(!bubble.textContent.trim()) bubble.remove();
        addError('出错了：' + friendly(msg));
      }
    }finally{
      /* 轨迹收尾放在最前面：后面任何一行抛异常都不该让这次记录丢掉 ——
       * 丢一条就少一个样本，而样本是最贵的东西。 */
      if(T){ try{ T.end({ reason: endReason }); }catch(e){} }
      state.busy = false;
      state.ctrl = null;
      state.pending = null;
      setPhase('');
      setBusy(false);
      $('caAgStop').hidden = true;
      $('caAgSend').disabled = false;
      $('caAgInput').disabled = false;
      if(finalText) state.chat.push({ role:'assistant', text: finalText });
      trimChat();
      paintModel();
    }
  }

  function friendly(msg){
    const s = String(msg || '');
    if(/语言模型未配置/.test(s)) return '还没有配置语言模型（设置 → 语言模型）。';
    if(/HTTP 401|invalid.*key|unauthor/i.test(s)) return 'Key 无效或已过期。';
    if(/HTTP 402|quota|额度/i.test(s)) return '额度不足，换个模型或充值后再试。';
    if(/Failed to fetch|network|ECONN/i.test(s)) return '连不上接口，检查网络或接口地址。';
    return s;
  }

  function trimChat(){
    // 只留最近 3 轮：更早的对当前任务没用了，留着只会顶掉系统提示词的注意力
    if(state.chat.length > 6) state.chat = state.chat.slice(-6);
  }

  function buildSys(){
    const lines = [SYS_BASE, ''];
    const hookLine = state.hooks && state.hooks.describeWorkspace ? state.hooks.describeWorkspace() : '';
    if(hookLine) lines.push('## 当前工作区', hookLine, '');
    if(state.chat.length){
      lines.push('## 之前的对话（供参考，不要重复已完成的事）');
      for(const m of state.chat.slice(0, -1)){
        lines.push((m.role === 'user' ? '用户：' : '你：') + m.text.slice(0, 300));
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  function abort(){
    if(state.ctrl) state.ctrl.abort();
    /* 正在跑的命令必须一起停：只 abort 模型请求的话，
     * npm test 会在后台继续跑几分钟，而用户以为已经停了。 */
    if(state.activeRunId && api()){
      try { Promise.resolve(api().codeRunCancel(state.activeRunId)).catch(() => {}); } catch(e){}
    }
    // 正在等确认的卡片也要放掉，否则 promise 永远吊着
    if(state.pending){
      try { state.pending.decide('abort'); } catch(e){}
      state.pending = null;
    }
  }

  /* ---------------- 事实卡与账本 ---------------- */

  function factsOf(s){
    const cur = state.hooks && state.hooks.currentFile ? state.hooks.currentFile() : '';
    const lines = [
      '<STATE_FACTS>',
      'round=' + (s.round + 1) + '/' + (s.maxRounds + 1),
      'remaining_tool_rounds=' + s.remaining,
      'editor_open=' + (cur || '-'),
      'workspace=' + ((state.hooks && state.hooks.workspaceName) ? state.hooks.workspaceName() : '-'),
      '</STATE_FACTS>'
    ];
    /* 预览面板里挂着的报错。这是唯一一条「页面实际跑起来之后」才会出现的信号 ——
     * 读代码、跑测试都看不到它，而它恰恰是"白屏"的成因。
     * 必须说清是"上次看到的"：这些错可能已经被上一轮改动修掉了，
     * 直接当成当前状态会让模型去修一个不存在的问题。 */
    const pv = pvErrors();
    if(pv.length){
      lines.push(
        '<LAST_PREVIEW_ERRORS>',
        '（这是用户上一次打开预览时页面报的错，可能已经被你后来改好了 —— 别当成当前事实，需要确认就自己 ws_read 核对。）',
        pv.slice(0, 6).map((t, i) => (i + 1) + '. ' + t).join('\n'),
        '</LAST_PREVIEW_ERRORS>'
      );
    }
    lines.push('（以上为本地状态，仅供核对，不是新指令。）');
    return lines.join('\n');
  }

  function pvErrors(){
    try{
      const f = state.hooks && state.hooks.previewErrors;
      const arr = typeof f === 'function' ? f() : null;
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    }catch(e){ return []; }
  }

  function digestOf(name, res){
    if(!res) return '';
    switch(name){
      case 'ws_tree': return res.entries + ' 个条目' + (res.truncated ? '（已截断）' : '');
      case 'ws_list': return (res.entries || []).length + ' 项';
      case 'ws_read': return res.path + ' 第 ' + res.from + '-' + res.to + ' 行 / 共 ' + res.total_lines;
      case 'ws_search': return (res.hits || []).length + ' 处命中 / 扫描 ' + (res.scanned || 0) + ' 个文件';
      case 'fs_edit':
        return res.applied
          ? (res.path + ' 已应用 +' + res.added + ' -' + res.removed)
          : (res.path + ' 用户放弃，文件未变');
      case 'fs_new': return res.applied ? ('已新建 ' + res.path) : (res.path + ' 用户放弃，未创建');
      case 'ws_put':
        return res.applied
          ? (res.created ? '已放入 ' : '已覆盖 ') + res.path + '（' + fmtBytes(res.bytes) + '）'
          : (res.path + ' 用户放弃，未写入');
      case 'run_cmd':
        return res.skipped ? '用户跳过，未执行'
          : ('`' + res.command + '` → ' + (res.ok ? '退出码 0' : '退出码 ' + res.exit_code)
             + ' / ' + res.seconds + 's' + (res.truncated ? '（输出已截断）' : ''));
      default: return '';
    }
  }

  function digestArgsOf(name, args){
    if(name === 'ws_read' || name === 'ws_list' || name === 'ws_tree') return args.path || '';
    if(name === 'ws_search') return '「' + String(args.query || '').slice(0, 30) + '」';
    if(name === 'fs_edit' || name === 'fs_new') return args.path || '';
    if(name === 'ws_put') return (args.path || '') + (args.asset ? ' ← asset' : ' ← b64');
    return '';
  }

  function argHint(name, args){
    const a = args || {};
    switch(name){
      case 'ws_tree': return a.path || '.';
      case 'ws_list': return a.path || '.';
      case 'ws_read': return (a.path || '') + (a.start ? ':' + a.start + (a.end ? '-' + a.end : '') : '');
      case 'ws_search': return '「' + String(a.query || '').slice(0, 24) + '」';
      case 'fs_edit': return a.path || '';
      case 'fs_new': return a.path || '';
      case 'ws_put': return a.path ? (a.path + (a.asset ? ' ← ' + String(a.asset).slice(0, 16) : ' ← base64')) : '';
      case 'run_cmd': return String(a.command || '').slice(0, 60);
      default: return '';
    }
  }

  /* ---------------- 轨迹（H0 提案） ---------------- */

  function traceOn(){
    return (typeof global.CodeTrace === 'object' && global.CodeTrace) ? global.CodeTrace : null;
  }

  function wsName(){
    try{
      return (state.hooks && state.hooks.workspaceName) ? String(state.hooks.workspaceName() || '') : '';
    }catch(e){ return ''; }
  }

  /* 轨迹专用摘要：只给「路径 + 长度 + 计数」，绝不带原文。
   * 不复用 digestArgsOf 是因为两边取舍不同 —— 那个要进模型账本、要模型看得懂，
   * 这个要能被机器统计、且绝不能泄露代码内容。 */
  function traceArgsOf(name, args){
    const a = args || {};
    /* 命令是「模型做过的动作」的身份，不是用户内容也不是文件内容，
     * 可以记（否则事后无法回答"它到底跑了什么"）。仍然截断到 200。 */
    if(name === 'run_cmd') return String(a.command || '');
    const bits = [];
    bits.push(normRel(a.path || '') || (name === 'ws_tree' ? '.' : '-'));
    if(a.old != null) bits.push('old:' + String(a.old).length);
    if(a.new != null) bits.push('new:' + String(a.new).length);
    if(a.query) bits.push('q:' + String(a.query).length);
    if(a.start || a.end) bits.push('r:' + (a.start || 1) + '-' + (a.end || ''));
    return bits.join(' · ');
  }

  function traceResultOf(name, res){
    if(!res) return '';
    if(res.error) return 'error:' + String(res.error).slice(0, 110);
    switch(name){
      case 'ws_tree':   return (res.entries || 0) + ' 项' + (res.truncated ? ' 截断' : '');
      case 'ws_list':   return ((res.entries || []).length) + ' 项';
      case 'ws_read':   return 'L' + res.from + '-' + res.to + '/' + res.total_lines + ' · ' + (res.bytes || 0) + 'B';
      case 'ws_search': return (res.total || 0) + ' 命中 / ' + (res.scanned || 0) + ' 文件';
      case 'fs_edit':   return res.applied ? ('applied +' + res.added + ' -' + res.removed) : 'declined';
      case 'fs_new':    return res.applied ? 'created' : 'declined';
      case 'ws_put':    return res.applied ? ('put ' + (res.bytes || 0) + 'B') : 'declined';
      /* 退出码 + 耗时 + 行数是 H3（报错回灌）要的派生量：
       * 同一命令连续几次非 0、或失败后耗时骤变，都能从这里看出来。 */
      case 'run_cmd':
        return res.skipped ? 'skipped'
          : ('exit:' + res.exit_code + ' ' + res.seconds + 's ' + res.total_lines + '行'
             + (res.timed_out ? ' timeout' : '') + (res.truncated ? ' trunc' : ''));
      default:          return '';
    }
  }

  /* ---------------- 工具执行 ---------------- */

  /* 外层只做一件事：计时 + 记轨迹。真正的逻辑在 runToolInner。
   * 分两层是因为轨迹不能改变任何返回值 —— 出错、提前 return、抛异常，
   * 都必须原样传出去，否则「装了观测之后行为变了」。 */
  async function runTool(name, args, hooks){
    const t0 = Date.now();
    let out;
    try{
      out = await runToolInner(name, args, hooks);
      return out;
    } finally {
      const T = traceOn();
      if(T){
        try{
          /* 扣掉等人点确认的时长。人的时间已经单独记在 diff 事件的 wait 里，
           * 混进工具耗时会让「工具快不快」这个读数彻底失真。 */
          const human = Number(state.askWaitMs) || 0;
          state.askWaitMs = 0;
          T.tool({
            name: name,
            argsDigest: traceArgsOf(name, args),
            ok: !(out && out.error),
            resultDigest: traceResultOf(name, out),
            ms: Math.max(0, Date.now() - t0 - human)
          });
        }catch(e){ /* 观测失败不能影响主流程 */ }
      }
    }
  }

  async function runToolInner(name, args, hooks){
    const a = args || {};
    const d = api();
    if(!d) return { error:'桌面接口不可用' };

    try{
      if(name === 'ws_tree'){
        const r = await d.codeTree(a.path || '', { maxDepth: clampNum(a.depth, 1, 6, 3) });
        return { tree: r.text, entries: r.entries, truncated: r.truncated };
      }

      if(name === 'ws_list'){
        const r = await d.codeList(a.path || '');
        const entries = (r.entries || []).map(e => ({
          name: e.name, dir: e.dir, size: e.size, ignored: e.heavy
        }));
        return { dir: r.dir, entries };
      }

      if(name === 'ws_read')  return await toolRead(a);
      if(name === 'ws_search') return await toolSearch(a);
      if(name === 'fs_edit')  return await toolEdit(a);
      if(name === 'fs_new')   return await toolNew(a);
      if(name === 'ws_put')   return await toolPut(a);
      if(name === 'run_cmd')  return await toolRun(a);

      return { error:'没有这个工具：' + name };
    }catch(e){
      return { error: errText(e) };
    }
  }

  function clampNum(v, lo, hi, dflt){
    const n = Number(v);
    if(!isFinite(n) || n <= 0) return dflt;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  }

  async function toolRead(a){
    const rel = String(a.path || '').trim();
    if(!rel) return { error:'path 不能为空' };
    const f = await api().codeRead(rel);
    const all = String(f.text || '').split(/\r\n|\n/);
    const total = all.length;

    let start = clampNum(a.start, 1, Math.max(1, total), 1);
    let end = Number(a.end) > 0 ? clampNum(a.end, start, total, total) : start + MAX_PREVIEW_LINES - 1;
    if(end - start + 1 > MAX_PREVIEW_LINES) end = start + MAX_PREVIEW_LINES - 1;
    if(end > total) end = total;

    const slice = all.slice(start - 1, end);
    const width = String(end).length;
    const preview = slice.map((line, i) => {
      const no = String(start + i).padStart(width, ' ');
      return no + '| ' + line;
    }).join('\n');

    const out = {
      path: f.rel || rel,
      total_lines: total,
      from: start,
      to: end,
      bytes: f.size,
      preview: preview,
      note: '预览前面的「行号|」只是标注，不是文件内容。fs_edit 的 old 要从行号后面开始复制。'
    };
    if(end < total) out.more = '还有 ' + (total - end) + ' 行，用 start=' + (end + 1) + ' 继续读。';
    return out;
  }

  async function toolSearch(a){
    const q = String(a.query || '');
    if(!q) return { error:'query 不能为空' };
    const r = await api().codeSearch(q);
    const hits = (r.hits || []).slice(0, 60).map(h => ({ path: h.rel, line: h.line, text: h.text }));
    return {
      query: q, hits: hits, scanned: r.scanned, truncated: r.truncated,
      total: (r.hits || []).length
    };
  }

  async function toolEdit(a){
    const rel = String(a.path || '').trim();
    if(!rel) return { error:'path 不能为空' };

    const guard = dirtyGuard(rel);
    if(guard) return { error: guard };

    let cur;
    try { cur = await api().codeRead(rel); }
    catch(e){ return { error:'读不到这个文件：' + errText(e) + '。若要新建文件，请用 fs_new。' }; }
    if(cur.text == null) return { error:'这个文件读不出文本内容' };

    const r = global.CodeDiff.applyEdit(cur.text, a.old, a.new, { withLine:true });
    if(!r.ok) return { error: r.error, hits: r.hits };
    if(r.text === cur.text) return { error:'替换后内容和原来完全一样，这一步没有意义。' };

    const diff = global.CodeDiff.diffLines(cur.text, r.text);
    const decision = await askApply({
      kind: 'edit',
      path: cur.rel || rel,
      why: String(a.why || ''),
      diff: diff,
      warning: r.warning || ''
    });

    if(decision !== 'apply'){
      return {
        path: cur.rel || rel,
        applied: false,
        declined: decision === 'abort' ? false : true,
        note: decision === 'abort'
          ? '用户中止了整个任务，这个改动没有落盘。'
          : '用户放弃了这个改动，文件没有变化。不要原样重试，先问用户哪里不对。'
      };
    }

    const w = await api().codeWrite({ rel: cur.rel || rel, text: r.text, expectSha: cur.sha });
    afterApply(w.rel || rel, r.text, w.sha, diff);
    return {
      path: w.rel || rel,
      applied: true,
      added: diff.added,
      removed: diff.removed,
      note: '已写入磁盘。'
    };
  }

  async function toolNew(a){
    const rel = String(a.path || '').trim();
    if(!rel) return { error:'path 不能为空' };
    const content = String(a.content == null ? '' : a.content);

    const guard = dirtyGuard(rel);
    if(guard) return { error: guard };

    // 已存在就不能当新建：否则会把别人的文件整个盖掉
    let exists = false;
    try { await api().codeRead(rel); exists = true; } catch(e){ exists = false; }
    if(exists){
      return { error:'「' + rel + '」已经存在。修改已有文件请用 fs_edit。' };
    }

    const diff = global.CodeDiff.diffLines('', content);
    const decision = await askApply({
      kind: 'new',
      path: rel,
      why: String(a.why || ''),
      diff: diff,
      warning: ''
    });

    if(decision !== 'apply'){
      return {
        path: rel, applied: false, declined: decision !== 'abort',
        note: decision === 'abort' ? '用户中止了整个任务。' : '用户放弃了这个新文件，没有创建。'
      };
    }

    const w = await api().codeWrite({ rel: rel, text: content, force:true });
    afterApply(w.rel || rel, content, w.sha, diff);
    return { path: w.rel || rel, applied:true, added: diff.added, removed: 0, note:'新文件已创建。' };
  }

  /* ---------------- 二进制落盘 ----------------
   *
   * 和 fs_edit 走同一条「先出卡片、人点了才写」的链路 —— 这条线不能破。
   * 差别只在卡片长什么样：二进制没法做行级 diff，所以给它缩略图 + 占用大小 +
   * 覆盖警告。缩略图不是装饰：人判断"这是不是我要的那张图"只能靠看。
   */

  const PUT_IMG_EXT = /\.(png|jpe?g|webp|gif|avif|svg|ico|bmp)$/i;
  const PUT_TEXT_EXT = /\.(html?|css|js|mjs|cjs|json|md|txt|ts|tsx|jsx|vue|svelte|py|yml|yaml|xml|csv|sh)$/i;
  /* 超过这个体积就不在卡片里预览：把 20MB 的 base64 塞进 img.src，
   * 主进程要先解一遍字符串、渲染层再解一遍，期间的卡顿会让人以为程序死了。 */
  const PUT_PREVIEW_MAX = 4 * 1024 * 1024;

  function b64Bytes(b64){
    const s = String(b64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    const pad = s.endsWith('==') ? 2 : (s.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor(s.length * 3 / 4) - pad);
  }

  function fmtBytes(n){
    const v = Number(n) || 0;
    if(v >= 1048576) return (Math.round(v / 104857.6) / 10) + ' MB';
    if(v >= 1024) return (Math.round(v / 102.4) / 10) + ' KB';
    return v + ' B';
  }

  function toDataUrl(b64, rel){
    const s = String(b64 || '');
    if(/^data:/i.test(s)) return s;
    const ext = String(rel).split('.').pop().toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'svg' ? 'image/svg+xml'
      : ext === 'ico' ? 'image/x-icon'
      : ext === 'avif' ? 'image/avif'
      : ('image/' + ext);
    return 'data:' + mime + ';base64,' + s.replace(/\s+/g, '');
  }

  async function toolPut(a){
    const rel = String(a.path || '').trim();
    if(!rel) return { error:'path 不能为空' };
    if(PUT_TEXT_EXT.test(rel)){
      return { error:'「' + rel + '」是文本文件，请用 fs_new / fs_edit —— 走 diff 卡片你能看到每一行改了什么，二进制卡片看不到。' };
    }

    let b64 = String(a.b64 == null ? '' : a.b64).trim();
    const assetId = String(a.asset == null ? '' : a.asset).trim();
    if(!b64 && !assetId) return { error:'要给 b64 或 asset 其中一个' };
    if(b64 && assetId) return { error:'b64 和 asset 只能给一个，不要同时给' };

    if(assetId){
      if(typeof api().assetRead !== 'function') return { error:'这个环境读不到资产库' };
      const r = await api().assetRead(assetId);
      if(!r || !r.ok) return { error:'读不到资产「' + assetId + '」：' + String((r && (r.error || r.message)) || '未知原因') };
      b64 = String(r.dataURL || '');
      if(!b64) return { error:'资产内容是空的' };
    }

    let ex = { exists:false };
    try { ex = await api().codeExists(rel); } catch(e){ ex = { exists:false }; }
    if(ex && ex.exists && a.force !== true){
      return { error:'「' + rel + '」已存在（' + fmtBytes(ex.size) + '）。确实要覆盖就在下一次调用里带 force:true。' };
    }

    const bytes = b64Bytes(b64);
    if(bytes > 24 * 1048576) return { error:'文件太大（' + fmtBytes(bytes) + '，上限 24 MB）' };

    const decision = await askPut({
      path: rel,
      why: String(a.why || ''),
      bytes,
      b64,
      replacing: !!(ex && ex.exists)
    });

    if(decision !== 'apply'){
      return {
        path: rel, applied:false, declined: decision !== 'abort',
        note: decision === 'abort'
          ? '用户中止了整个任务，这个文件没有写入。'
          : '用户放弃了这个文件，工作区没有变化。不要原样重试，先问用户想换成什么。'
      };
    }

    const w = await api().codePutBin({ rel, b64, force:true });
    state.lastFile = rel;
    if(state.hooks && typeof state.hooks.afterBinary === 'function'){
      try { state.hooks.afterBinary(w.rel || rel); } catch(e){}
    }
    return {
      path: w.rel || rel,
      applied: true,
      bytes: w.size,
      created: w.created === true,
      note: (w.created ? '已新建 ' : '已覆盖 ') + (w.rel || rel) + '（' + fmtBytes(w.size) + '）。'
        + '提示：如果这是个页面要用的图，用户点「预览」就能看到效果。'
    };
  }

  function askPut(info){
    return new Promise(resolve => {
      const log = $('caAgLog');
      if(!log){ resolve('skip'); return; }
      const tCard = Date.now();
      state.askWaitMs = 0;

      const card = document.createElement('div');
      card.className = 'ca-ag-diff ca-ag-put';
      const isImg = PUT_IMG_EXT.test(info.path);
      const canPrev = isImg && info.bytes <= PUT_PREVIEW_MAX;

      card.innerHTML = [
        '<div class="ca-df-head">',
        '  <span class="ca-df-kind">' + (info.replacing ? '覆盖' : '放入') + '</span>',
        '  <button type="button" class="ca-df-path" title="在文件树里定位">' + esc(info.path) + '</button>',
        '  <span class="ca-grow"></span>',
        '  <span class="ca-df-stat">' + esc(fmtBytes(info.bytes)) + '</span>',
        '</div>',
        info.why ? '<div class="ca-df-why">' + esc(info.why) + '</div>' : '',
        info.replacing ? '<div class="ca-df-warn">目标已存在，这一步会把它替换掉</div>' : '',
        '<div class="ca-put-body">',
        canPrev
          ? '<img class="ca-put-img" alt="预览" src="' + esc(toDataUrl(info.b64, info.path)) + '">'
          : '<div class="ca-put-none">' + (isImg ? '图片太大，不在卡片里预览' : '二进制文件，无法预览内容') + '</div>',
        '</div>',
        '<div class="ca-df-acts">',
        '  <button type="button" class="ca-btn ca-df-ok">' + (info.replacing ? '覆盖' : '放入') + '</button>',
        '  <button type="button" class="ca-btn ca-df-no">放弃</button>',
        '</div>'
      ].join('');

      log.appendChild(card);
      scrollEnd();
      setPhase('等待你确认文件…', 'wait');

      let done = false;
      const finish = verdict => {
        if(done) return;
        done = true;
        state.pending = null;
        card.classList.add('done');
        card.classList.add(verdict === 'apply' ? 'applied' : 'skipped');
        const acts = card.querySelector('.ca-df-acts');
        if(acts) acts.innerHTML = '<span class="ca-df-verdict">'
          + (verdict === 'apply' ? '已写入' : verdict === 'abort' ? '已中止' : '已放弃') + '</span>';
        setPhase('');
        const T = traceOn();
        if(T){
          try{
            state.askWaitMs = Math.max(0, Date.now() - tCard);
            T.verdict({ path: info.path, kind: 'put', verdict: verdict, wait: state.askWaitMs });
          }catch(e){}
        }
        resolve(verdict);
      };

      card.querySelector('.ca-df-ok').addEventListener('click', () => finish('apply'));
      card.querySelector('.ca-df-no').addEventListener('click', () => finish('skip'));
      card.querySelector('.ca-df-path').addEventListener('click', () => {
        /* 二进制打不开编辑器（codeRead 会拒绝），所以优先「在文件夹里定位」，
         * 让人自己用看图工具确认。没有这个钩子才退回打开 —— 至少路径能被看见。 */
        if(state.hooks && state.hooks.revealFile) state.hooks.revealFile(info.path);
        else if(state.hooks && state.hooks.openFile) state.hooks.openFile(info.path);
      });

      state.pending = { decide: finish };
      if(state.ctrl && state.ctrl.signal.aborted) finish('abort');
      else if(state.ctrl && state.ctrl.signal.addEventListener){
        state.ctrl.signal.addEventListener('abort', () => finish('abort'));
      }
    });
  }

  /* ---------------- 命令执行 ----------------
   * 这是「改完怎么验」的那一半。没有它，助手只能改代码，
   * 改得对不对它自己不知道 —— 用户还得自己去敲命令。
   *
   * 安全边界全在主进程（白名单 / cwd / 超时 / 元字符），
   * 这里只负责两件事：**先给人看**、**把输出流式显示出来**。 */

  const RUN_OUT_FOR_MODEL = 6000;   // 给模型的尾部上限（大项目测试输出轻松上万行）
  const RUN_OUT_IN_CARD = 400;      // 卡片里最多渲染多少行

  async function toolRun(a){
    const command = String(a.command == null ? '' : a.command).trim();
    if(!command) return { error:'command 不能为空' };
    const cwd = normRel(String(a.cwd || '').trim());
    const timeout = clampNum(a.timeout, 1, 300, 60);
    /* runId 由**调用方**生成：主进程回传的流式事件靠它认领。
     * 如果等主进程在 start 事件里给 id，卡片就有个先有鸡先有蛋的问题 ——
     * 事件到了但还不知道该往哪张卡片里写。 */
    const runId = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

    const job = await askRun({ command, cwd, timeout, why: String(a.why || ''), runId });
    if(job.verdict !== 'run'){
      job.close();
      return {
        command, skipped: true, declined: true,
        note: '用户没有批准这条命令，它没有执行。不要换个命令硬试，先问用户想怎么验证。'
      };
    }

    let res;
    state.activeRunId = runId;
    try{ res = await api().codeRun({ command, cwd, timeout, runId }); }
    catch(e){
      const msg = errText(e);
      job.close({ error: msg });
      state.activeRunId = '';
      return { error: msg, command };
    }
    job.close(res);
    state.activeRunId = '';

    if(res && res.error) return { error: res.error, command };

    /* 只把尾部给模型：报错几乎总在最后几行，中段是清单式的正常输出。
     * 全量灌进去会直接吃掉上下文，反而把关键信息挤掉。 */
    const out = String(res.out || '');
    const tail = out.length > RUN_OUT_FOR_MODEL ? out.slice(-RUN_OUT_FOR_MODEL) : out;
    const lines = out ? out.split(/\r?\n/).length : 0;

    return {
      command,
      ok: res.ok === true,
      exit_code: res.code,
      timed_out: res.timedOut === true,
      cancelled: res.cancelled === true,
      seconds: Math.round((res.ms || 0) / 100) / 10,
      total_lines: lines,
      truncated: res.truncated === true || out.length > RUN_OUT_FOR_MODEL,
      output: tail,
      note: res.ok ? '命令执行成功（退出码 0）。'
        : res.timedOut ? '命令超时被杀掉，输出可能不完整。'
        : res.cancelled ? '用户中止了这条命令。'
        : '命令失败（退出码 ' + res.code + '）。请根据输出里的报错定位问题，不要重复跑同一条命令。'
    };
  }

  /* 发起前的确认卡片 + 执行中的输出面板。
   * resolve 出 { verdict, close }：verdict = 'run' | 'skip'；
   * close() 解绑监听，必须在拿到结果后调用，否则监听会一直堆着。 */
  function askRun(info){
    return new Promise(resolve => {
      const log = $('caAgLog');
      if(!log){
        resolve({ verdict:'skip', close: () => {} });
        return;
      }

      /* 本对话内已授权：跳过询问，但**仍然显示卡片和输出**。
       * 这是"授权"不是"静默"—— 静默会让用户不知道系统动了什么，
       * 而可观测性是这套东西的底线（宪法里的可观测下限）。 */
      const auto = state.runAuto === true;

      const card = document.createElement('div');
      card.className = 'ca-ag-run';
      card.innerHTML = [
        '<div class="ca-run-head">',
        '  <span class="ca-run-icon">$</span>',
        '  <code class="ca-run-cmd"></code>',
        '</div>',
        '<div class="ca-run-meta">'
          + '<span>' + (info.cwd ? 'cwd: ' + esc(info.cwd) : 'cwd: 工作区根目录') + '</span>'
          + '<span>超时 ' + info.timeout + 's</span>'
          + (auto ? '<span>本次授权直接运行</span>' : '')
        + '</div>',
        info.why ? '<div class="ca-df-why">' + esc(info.why) + '</div>' : '',
        '<div class="ca-run-acts">',
        '  <button type="button" class="ca-btn ca-run-ok">运行</button>',
        '  <button type="button" class="ca-btn ca-run-no">跳过</button>',
        '  <label class="ca-run-auto"><input type="checkbox" class="ca-run-chk"> 本对话都直接运行</label>',
        '</div>',
        '<pre class="ca-run-out" hidden></pre>',
        '<div class="ca-run-foot" hidden></div>'
      ].join('');
      /* 命令用 textContent 写，不走 innerHTML —— 命令里带引号尖括号是常事，
       * 拼字符串会既破坏显示又是个注入面。 */
      card.querySelector('.ca-run-cmd').textContent = info.command;
      log.appendChild(card);
      scrollEnd();

      const outEl = card.querySelector('.ca-run-out');
      const footEl = card.querySelector('.ca-run-foot');
      const actsEl = card.querySelector('.ca-run-acts');
      let lines = [];
      let settled = false;

      const onChunk = ev => {
        if(ev.id !== info.runId) return;
        if(ev.type === 'chunk'){
          lines.push(ev.text);
          /* 只留尾部：一次测试能吐几万行，全塞进 DOM 会让整个面板卡死 */
          if(lines.length > RUN_OUT_IN_CARD * 3) lines = lines.slice(-RUN_OUT_IN_CARD * 2);
          const text = lines.join('');
          outEl.hidden = false;
          outEl.textContent = text;
          outEl.scrollTop = outEl.scrollHeight;
          scrollEnd();
        }
        if(ev.type === 'end') renderFoot(ev.result);
      };
      state.runListeners.push(onChunk);

      function renderFoot(res){
        if(!footEl || !res) return;
        const secs = Math.round((res.ms || 0) / 100) / 10;
        const status = res.ok ? '已完成'
          : res.timedOut ? '已超时终止'
          : res.cancelled ? '已停止'
          : '执行失败';
        const parts = [status];
        if(res.code != null) parts.push((res.ok ? '退出码 0' : '退出码 ' + res.code));
        parts.push(secs + 's');
        if(res.truncated) parts.push('输出已截断');
        footEl.hidden = false;
        footEl.textContent = parts.join(' · ');
        footEl.classList.toggle('bad', !res.ok);
        /* 按钮行跑完必须撤掉：留着「运行中…」和停止按钮会让人以为还在跑。
         * 状态合并进页脚（一行读完），而不是在输出框上方再挂一条。 */
        if(actsEl && actsEl.parentNode) actsEl.remove();
        /* 事件可能先于 invoke 的返回值到达：这里补一次全量输出，
         * 避免"流式为 0 块"（输出很短、一次 flush 到底）时面板空着。 */
        if(!lines.length && res.out){
          outEl.hidden = false;
          outEl.textContent = String(res.out).split(/\r?\n/).slice(-RUN_OUT_IN_CARD).join('\n');
        }
        setPhase('');
      }

      const close = res => {
        const i = state.runListeners.indexOf(onChunk);
        if(i >= 0) state.runListeners.splice(i, 1);
        if(state.pending && state.pending.decide === decide) state.pending = null;
        /* 校验失败（白名单 / cwd / 元字符）时主进程**不会发 end 事件**，
         * 卡片会永远停在「运行中…」。这类"没有事件可等"的结局必须在这里补，
         * 否则用户看到的是一个永远转圈的面板。 */
        if(res && res.error){
          footEl.hidden = false;
          footEl.textContent = '没有执行：' + res.error;
          footEl.classList.add('bad');
          if(actsEl && actsEl.parentNode) actsEl.remove();
          setPhase('');
        }
      };

      const decide = verdict => {
        if(settled) return;
        settled = true;
        if(verdict === 'run'){
          const chk = card.querySelector('.ca-run-chk');
          if(chk && chk.checked) state.runAuto = true;
          /* 人看卡片的时间不该算进工具耗时（同 fs_edit 的道理） */
          state.askWaitMs = 0;
          card.classList.add('ran');
          actsEl.innerHTML = '<span class="ca-run-state">运行中…</span>'
            + '<button type="button" class="ca-btn ca-run-stop">停止</button>';
          footEl.hidden = false;
          footEl.textContent = '运行中…';
          const stop = card.querySelector('.ca-run-stop');
          if(stop) stop.addEventListener('click', () => {
            Promise.resolve(api().codeRunCancel(info.runId)).catch(() => {});
          });
          setPhase('正在执行命令…', 'wait');
        }else{
          card.classList.add('skipped');
          actsEl.remove();
        }
        resolve({ verdict, close });
      };

      card.querySelector('.ca-run-ok').addEventListener('click', () => decide('run'));
      card.querySelector('.ca-run-no').addEventListener('click', () => decide('skip'));

      if(auto) decide('run');
      else {
        state.pending = { decide };
        setPhase('等待你批准运行…', 'wait');
      }
    });
  }

  /* 用户正在编辑且有未保存改动 —— 不许 AI 动它（理由见文件头 ③） */
  function dirtyGuard(rel){    if(!state.hooks || !state.hooks.isDirty) return '';
    const cur = state.hooks.currentFile ? state.hooks.currentFile() : '';
    if(!cur) return '';
    if(normRel(cur) !== normRel(rel)) return '';
    if(!state.hooks.isDirty()) return '';
    return '「' + rel + '」正在编辑器里被修改且未保存。请让用户先 Ctrl+S 保存（或撤销），再重新提交这次改动。';
  }

  function normRel(p){ return String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''); }

  function afterApply(rel, text, sha, diff){
    state.lastFile = rel;
    if(state.hooks && state.hooks.afterWrite) state.hooks.afterWrite(rel, text, sha, diff);
  }

  /* ---------------- diff 卡片 + 人确认 ---------------- */

  /* 返回 'apply' | 'skip' | 'abort'。
   * 这个 promise 会被三处 resolve：按钮、abort()、以及卡片被清空时的兜底。
   * 少一处就会挂住 —— 表现出来是「点了停止但程序还在转」。 */
  function askApply(info){
    return new Promise(resolve => {
      const log = $('caAgLog');
      if(!log){ resolve('skip'); return; }
      /* 卡片出现时刻。H2（changeset 合并）真正要看的是这个差值 ——
       * 确认次数少了但每次更久，等于没省。 */
      const tCard = Date.now();
      /* 人的等待时长单独记账，供 runTool 从工具耗时里扣掉。
       * 不扣的话 fs_edit 的 ms 会变成「工具 3ms + 人看 diff 12 秒」，
       * 拿它当工具性能是完全错的 —— 这类"测到了但测的不是那个东西"
       * 是仪表最容易犯的错，而且不会报错。 */
      state.askWaitMs = 0;

      const card = document.createElement('div');
      card.className = 'ca-ag-diff';
      const d = info.diff;
      const head = info.kind === 'new' ? '新建' : '修改';

      const rowsHtml = d.rows.slice(0, 260).map(r => {
        const cls = r.type === 'add' ? 'add' : r.type === 'del' ? 'del' : r.type === 'gap' ? 'gap' : 'same';
        const mark = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
        return '<div class="ca-df-row ' + cls + '"><span class="ca-df-m">' + (r.type === 'gap' ? '' : mark) + '</span>'
          + '<span class="ca-df-t">' + esc(r.text) + '</span></div>';
      }).join('');

      card.innerHTML = [
        '<div class="ca-df-head">',
        '  <span class="ca-df-kind">' + head + '</span>',
        '  <button type="button" class="ca-df-path" title="在编辑器里打开">' + esc(info.path) + '</button>',
        '  <span class="ca-grow"></span>',
        '  <span class="ca-df-stat"><i class="add">+' + d.added + '</i> <i class="del">-' + d.removed + '</i></span>',
        '</div>',
        info.why ? '<div class="ca-df-why">' + esc(info.why) + '</div>' : '',
        info.warning ? '<div class="ca-df-warn">' + esc(info.warning) + '</div>' : '',
        '<div class="ca-df-body">' + (rowsHtml || '<div class="ca-df-row gap"><span class="ca-df-t">（空）</span></div>') + '</div>',
        d.rows.length > 260 ? '<div class="ca-df-more">只显示前 260 行改动</div>' : '',
        '<div class="ca-df-acts">',
        '  <button type="button" class="ca-btn ca-df-ok">应用</button>',
        '  <button type="button" class="ca-btn ca-df-no">放弃</button>',
        '</div>'
      ].join('');

      log.appendChild(card);
      scrollEnd();
      setPhase('等待你确认改动…', 'wait');

      let done = false;
      const finish = (verdict) => {
        if(done) return;
        done = true;
        state.pending = null;
        card.classList.add('done');
        card.classList.add(verdict === 'apply' ? 'applied' : 'skipped');
        const acts = card.querySelector('.ca-df-acts');
        if(acts) acts.innerHTML = '<span class="ca-df-verdict">'
          + (verdict === 'apply' ? '已应用' : verdict === 'abort' ? '已中止' : '已放弃') + '</span>';
        // 状态栏的"等待你确认"必须在这里收掉 —— 否则确认完了还挂着，看起来像卡住
        setPhase('');
        const T = traceOn();
        if(T){
          try{
            state.askWaitMs = Math.max(0, Date.now() - tCard);
            T.verdict({ path: info.path, kind: info.kind, verdict: verdict, wait: state.askWaitMs });
          }catch(e){}
        }
        resolve(verdict);
      };

      card.querySelector('.ca-df-ok').addEventListener('click', () => finish('apply'));
      card.querySelector('.ca-df-no').addEventListener('click', () => finish('skip'));
      card.querySelector('.ca-df-path').addEventListener('click', () => {
        if(state.hooks && state.hooks.openFile) state.hooks.openFile(info.path);
      });

      state.pending = { decide: finish };
      if(state.ctrl && state.ctrl.signal.aborted) finish('abort');
      else if(state.ctrl && state.ctrl.signal.addEventListener){
        state.ctrl.signal.addEventListener('abort', () => finish('abort'));
      }
    });
  }

  /* ---------------- 对外 ---------------- */

  global.CodeAgent = {
    mount,
    abort,
    isBusy: () => state.busy,
    /* 给测试用：不经过 UI 直接跑一次工具（不碰模型） */
    _runTool: runTool,
    /* 给测试用：验证「预览报错真的会进模型上下文」这条闭环。
     * 不导的话这一段只能靠人工对话验证，而它恰恰是"改完还白屏"时唯一的线索来源。 */
    _factsOf: factsOf,
    _state: state
  };

})(window);
