/* 对话内生图管线（文生图 / 图生图）
 *
 * 这个文件只管「业务判断」，不碰任何聊天 DOM，方便单测与复用：
 *   ① dimgIntent   —— 这句话是在要图，还是在聊天（含问句 / 流程图类排除）
 *   ② dimgRefine   —— 把口语需求改写成可直接生图的提示词（走当前对话模型）
 *   ③ dimgSource   —— 现在会由谁出图（本地 ComfyUI / Tripo 网页 / Tripo API / 在线接口）
 *   ④ dimgGenerate —— 调 wfImage()，和「图像生成」节点是同一条链路
 *   ⑤ dimgSegment  —— 解析模型自己吐出的 {"type":"image",...} 指令并把它从正文里摘掉
 *
 * 为什么不另写一套生图请求：来源切换（mc_scope_image）、ComfyUI、Tripo 的全部分支
 * 都已经在 wfImage 里了，复制一份必然出现「节点能出图、对话不能出图」的双轨。
 */
(function(){
  /* ---------------- ① 意图 ---------------- */
  /* 「指的是这张图」和「要动这张图」要分开看：
   *   指代 + 动作 → 改这张（「把它改成水彩」「给它加顶帽子」）
   *   只有动作   → 没说清改哪张，交给模型澄清（「背景换成雪山」）
   * 混成一个正则就会出现两种错：要么「阳光洒在它身上」被当成指代（新图被旧图污染），
   * 要么「把它改成水彩」因为没有「画/生成」这类词被判成闲聊（用户的改图请求石沉大海）。 */
  const REF_WORD = /这(张|幅|个|一?张)|(把|给|让|对|将)它|它的|刚才|刚刚|上一张|前一张|原来的?图/;
  const EDIT_VERB = /改成|换成|变成|修改|调整|去(掉|除)|移除|删掉|抠|换背景|换风格|换颜色|加(上|个|点|一)|补上|修一下|精修|放大|高清|重绘|上色|继续改|局部/;
  /* 命中这些词才把上一张图当参考图，否则「再画一张猫」会被悄悄做成图生图
     （本地重绘 60%，出一张和上一张缠在一起的糊图）。 */
  const REF_EDIT = new RegExp(REF_WORD.source + '|' + EDIT_VERB.source + '|再画|再来一张|同风格');
  /* 这些词后面跟着「图」时说的是示意图，不是绘画 */
  const NOT_ART = /(流程图|架构图|思维导图|时序图|关系图|甘特图|拓扑图|er\s*图|示意图|示意图|走势图|折线图|柱状图|饼图|表格|代码|原型图)/i;
  const ASKING = /(怎么|如何|为什么|为啥|能不能|可不可以|是否|支持吗|教程|教我|原理|什么是|是什么|在哪|哪个|有没有)/;
  /* 祈使句：这些说法里就算带「怎么 / 能不能」也是在要图，不是在问方法。
     「怎么生成图片」没有这一层，所以判成聊天。 */
  const IMPERATIVE = /(帮我画|给我画|替我画|画一|画个|画张|画幅|画只|画条|来一?[张幅]|来一?个图|生成一?[张幅个]|做个图|做一?[张幅]图?|把.{0,14}(改成|换成|变成)|重绘|修一下这张|抠图|上色|换背景)/;
  const STRONG = /(画一|画个|画张|画幅|画只|画条|画朵|帮我画|给(我|他|她)画|绘制|生成一?[张幅]|生成图|生成图片|生成图像|出图|出张图|来一?张图|来张图|来一?个图|做个图|做一?张(图|海报|头像|壁纸|插画)|渲染一?张|抠图|上色|换背景|换风格|做成图)/;
  const SOFT = /(画|生成|绘制|做张|出图|渲染|设计一?个|做成|修|改)/;
  const NOUN = /(图|图片|照片|插画|海报|头像|壁纸|logo|图标|封面|立绘|场景|表情包|banner|poster|icon|画面|像素|画风)/i;

  function dimgIntent(text, hasAtt){
    const t = String(text || '').trim();
    if(!t) return { on:false, why:'空消息' };
    if(NOT_ART.test(t)) return { on:false, why:'要的是示意图/文档，不是绘画' };
    // 「怎么生成图片」「你支持图生图吗」是在问，不是在要图；
    // 但「帮我画一张图，怎么才更写实」是真要图，所以祈使句优先
    if(ASKING.test(t) && !IMPERATIVE.test(t)) return { on:false, why:'问句' };
    // 指代 + 改动动作 = 明确要改上一张（这类句子通常不含「画/生成」，跑不到下面几条）
    if(REF_WORD.test(t) && EDIT_VERB.test(t)) return { on:true, why:'改上一张图', edit:true };
    if(STRONG.test(t)) return { on:true, why:'明确的生图动作', edit:REF_EDIT.test(t) };
    if(SOFT.test(t) && NOUN.test(t)) return { on:true, why:'动作 + 画面对象', edit:REF_EDIT.test(t) };
    if(hasAtt && REF_EDIT.test(t)) return { on:true, why:'带参考图的改图请求', edit:true };
    if(/^(画|绘制|草拟一张|来一张)/.test(t) && t.length <= 40) return { on:true, why:'祈使句', edit:REF_EDIT.test(t) };
    return { on:false, why:'普通对话' };
  }

  /* ---------------- ⑤ 指令解析 ---------------- */
  /* 模型偶尔会主动吐一行 {"type":"image","prompt":"…"}（系统提示里教过它）。
     下面这几个函数把它从正文里整段摘掉，并返回结构化的出图请求。 */
  const MARK_RE = /\{\s*"type"\s*:\s*"image"/g;

  // 从 start 处的 { 开始找配对的 }，跳过字符串里的括号
  function braceEnd(s, start){
    let depth = 0, inStr = false, esc = false;
    for(let i = start; i < s.length; i++){
      const ch = s[i];
      if(inStr){
        if(esc) esc = false;
        else if(ch === '\\') esc = true;
        else if(ch === '"') inStr = false;
        continue;
      }
      if(ch === '"'){ inStr = true; continue; }
      if(ch === '{') depth++;
      else if(ch === '}'){
        depth--;
        if(depth === 0) return i + 1;
      }
    }
    return -1;
  }

  // 一段文字里所有指令标记的位置（升序）
  function markIndexes(s){
    const out = [];
    let m;
    MARK_RE.lastIndex = 0;
    while((m = MARK_RE.exec(s))) out.push(m.index);
    return out;
  }

  /* 把一段 JSON 文本解析成出图指令。
     模型偶尔写出不可解析的 JSON（尾逗号、单引号、被截断），这时用正则兜住两个关键字段。 */
  function parseInstruction(body){
    const t = String(body || '').trim();
    let obj = null;
    try{ obj = JSON.parse(t); }catch(e){
      const p = t.match(/"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if(p){
        obj = { type:'image', prompt: p[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') };
        const md = t.match(/"mode"\s*:\s*"(text|image)"/);
        if(md) obj.mode = md[1];
      }
    }
    if(!obj || String(obj.type) !== 'image') return null;
    return {
      prompt: String(obj.prompt || '').trim(),
      mode: obj.mode === 'image' ? 'image' : 'text'
    };
  }

  /* 从正文里摘掉**所有**指令块。
     只摘最后一条是不够的：模型常常把示例抄一遍再写一遍真的（或先写一遍又重复一遍），
     那样前一条会原样留在正文里，用户看到的就是一行裸 JSON。
     force=true 时连解析不了（被截断 / 语法坏了）的指令块也摘掉——它同样不该露在正文里。 */
  function dimgStrip(raw, force){
    const s = String(raw == null ? '' : raw);
    const idx = markIndexes(s);
    if(!idx.length) return cleanFence(s);
    const cuts = [];
    idx.forEach(st => {
      const end = braceEnd(s, st);
      const ok = !!parseInstruction(end > 0 ? s.slice(st, end) : s.slice(st));
      if(ok || force) cuts.push([st, end > 0 ? end : s.length]);
    });
    if(!cuts.length) return cleanFence(s);
    let out = '';
    let at = 0;
    cuts.forEach(([a, b]) => {
      if(a < at) return;               // 被前一段包住了
      out += s.slice(at, a);
      at = b;
    });
    out += s.slice(at);
    return cleanFence(out)
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* 流式阶段用：可能只收到了半截对象（连 } 都还没有），
     这时也要把标记挡在显示之外，否则用户会看到一串裸 JSON 一点点长出来。 */
  function tailStart(s){
    const all = markIndexes(s);
    if(all.length) return all[0];      // 有完整标记：从**第一条**就开始挡
    const mark = '{"type":"image"';
    const from = Math.max(0, s.length - mark.length - 12);
    for(let k = from; k < s.length; k++){
      if(s[k] !== '{') continue;
      const norm = s.slice(k).replace(/\s+/g, '');
      if(norm.length < 5) continue;                       // 只看到一个 {，不足以判断
      if(mark.replace(/\s+/g, '').indexOf(norm) === 0) return k;
    }
    return -1;
  }

  function cleanFence(t){
    return String(t || '').replace(/```(json)?\s*$/i, '').replace(/^\s*```[a-z]*\s*/i, '').trim();
  }

  /* 流式显示用：只返回「可以给人看」的部分 */
  function dimgLive(raw){
    const s = String(raw == null ? '' : raw);
    const i = tailStart(s);
    return cleanFence(i >= 0 ? s.slice(0, i) : s);
  }

  /* 收尾用：{ text, direct } —— direct 为 null 表示没有出图指令 */
  function dimgSegment(raw){
    const s = String(raw == null ? '' : raw);
    const idx = markIndexes(s);
    if(!idx.length) return { text: cleanFence(s), direct: null };
    // 取最后一条能解析的当出图请求（模型常常先抄示例、再写真正要画的那条）
    let direct = null;
    for(let k = idx.length - 1; k >= 0 && !direct; k--){
      const st = idx[k];
      const end = braceEnd(s, st);
      direct = parseInstruction(end > 0 ? s.slice(st, end) : s.slice(st));
    }
    // 正文用「全部摘掉」的版本：留一条在正文里就是一行裸 JSON
    const text = dimgStrip(s, true);
    if(!direct || !direct.prompt){
      /* 有指令的样子但解析不出来（多半是被 max tokens 截断）：别把半截 JSON 摊给用户看，
         直接说清楚发生了什么，并留一句能自救的话。 */
      return {
        text: text || (idx.length ? '（模型写了一条出图指令，但格式不完整，没能解析出来——再发一次，或点下面的「重试」）' : cleanFence(s)),
        direct: null
      };
    }
    return { text: text, direct: direct };
  }

  /* ---------------- ② 提示词改写 ---------------- */
  const REFINE_SYS = [
    '你是资深 AI 绘画提示词工程师（Stable Diffusion / Seedream 这类模型）。',
    '把用户的口语需求改写成一段可以直接生图的提示词：',
    '1. 只输出提示词本身：不要解释、不要序号、不要引号、不要 markdown、不要「提示词：」前缀；',
    '2. 写清 主体 + 动作 + 环境 + 光线 + 材质 + 镜头/构图 + 风格 + 色调，具体到能直接画；',
    '3. 用户点名的文字、比例、画风、以及要改的地方必须保留；不要加用户没要求的元素；',
    '4. 不超过 150 字，用中文。'
  ].join('\n');

  function dimgCleanPrompt(s){
    let t = String(s || '').trim();
    t = cleanFence(t);
    t = t.replace(/^(提示词|prompt|画面描述)\s*[:：]\s*/i, '');
    t = t.replace(/^["“'「『]+|["”'」』]+$/g, '');
    t = t.replace(/\s*\n+\s*/g, '，').replace(/[，,]\s*[，,]/g, '，');
    if(t.length > 600) t = t.slice(0, 600);
    return t.trim();
  }

  async function dimgRefine(text, opts){
    const o = opts || {};
    const conn = o.conn;
    if(!conn || !conn.base || !conn.key || !conn.model) return '';
    if(typeof llmStreamRequest !== 'function') return '';
    const raw = await llmStreamRequest(REFINE_SYS, [{ role:'user', content: String(text) }], o.onDelta, {
      conn: conn,
      // 20 秒够改写 150 字了；再久就是在等一个卡住的模型，
      // 与其让用户干等，不如直接拿原话去生图
      timeoutMs: Math.max(6000, Number(o.timeoutMs) || 20000)
    });
    return dimgCleanPrompt(raw);
  }

  /* ---------------- ③ 来源 ---------------- */
  function safe(fn, dflt){
    try{ return fn(); }catch(e){ return dflt; }
  }

  function dimgSource(){
    if(safe(() => imgMode(), 'online') === 'local'){
      const running = !!(safe(() => rtHealth && rtHealth.comfy && rtHealth.comfy.ok, false));
      const ck = safe(() => comfyCkptChoice(), '') || 'ComfyUI';
      return {
        kind: 'local', label: '本地 · ' + ck, ready: running, where: 'comfy',
        hint: running ? ''
          : '本地生图引擎（ComfyUI）没在运行：打开桌面的「本地生图」启动引擎；或在设置 → 图像里把生图切回在线'
      };
    }
    if(safe(() => isTripoWeb(), false)){
      const ready = !!safe(() => tripoWebReady, false);
      return {
        kind: 'tripoWeb', label: 'Tripo 网页账号', ready: ready, where: 'image',
        hint: ready ? ''
          : 'Tripo 网页助手未连接：先启动项目（start.bat），再在设置 → 图像里点「打开登录页」'
      };
    }
    if(safe(() => isTripo(), false)){
      const key = safe(() => $('tripoKey').value.trim(), '');
      const model = safe(() => $('imgModel').value.trim(), '') || 'seedream_v5';
      return {
        kind: 'tripo', label: 'Tripo · ' + model, ready: !!key, where: 'image',
        hint: key ? '' : '还没填 Tripo API Key：设置 → 图像 → Tripo'
      };
    }
    const base = safe(() => ($('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim()), '');
    const model = safe(() => ($('imgModel').value.trim() || $('llmModel').value.trim()), '');
    const key = safe(() => ($('imgKey').value.trim() || $('llmKey').value.trim()), '');
    const ready = !!(base && model && key);
    // 图像侧留空时会沿用语言模型的接口（wfImage 也是这么做的）。名字对不上时
    // 用户第一反应是「为什么生成失败的是个聊天模型」，所以把这层借用说出来。
    const shared = !safe(() => $('imgModel').value.trim(), '') || !safe(() => $('imgBaseUrl').value.trim(), '')
      || !safe(() => $('imgKey').value.trim(), '');
    return {
      kind: 'online', label: '在线 · ' + (model || '未配置'), ready: ready, where: 'image', shared: shared,
      hint: ready ? '' : '图像模型未配置：设置 → 图像，填好接口地址 / API Key / 模型名'
    };
  }

  /* 出图前用这个，而不是直接 source()。
   *
   * 「本地引擎在不在跑」不是一个设置，是一条**会变**的事实：开机自动启动要 100 秒才把
   * ComfyUI 拉起来，而 rtHealth 是那一刻探的快照。之后引擎起来了，没人再去探，
   * 快照就永远停在 false —— 于是卡片上明明写着「运行中」，一出图却弹「引擎没在运行」。
   *
   * 策略：缓存说 ready 就直接信（快路径零延迟）；只有缓存说不 ready 时，才真去探一次。
   * 代价只落在「本来就要失败」的那条路上。 */
  async function dimgCheck(){
    let s = dimgSource();
    if(s.ready) return s;
    if(s.kind === 'local' && typeof rtRefresh === 'function'){
      try{ await rtRefresh(); }catch(e){}
      s = dimgSource();
    }
    return s;
  }

  /* ---------------- ④ 生成 ---------------- */
  async function dimgGenerate(o){
    const a = o || {};
    const prompt = String(a.prompt || '').trim();
    if(!prompt) throw new Error('提示词为空');
    if(typeof wfImage !== 'function') throw new Error('生图链路未加载（blueprint-runtime.js 没就位）');
    const t0 = Date.now();
    // 第三个参数只带 signal / 超时：不传时行为与工作流节点完全一致
    const src = await wfImage(prompt, a.ref || undefined, {
      signal: a.signal,
      timeoutSec: Math.max(30, Number(a.timeoutSec) || 300),
      // 0 / undefined = 自动（provider 按提示词判断「想改多少」）；手动档位由卡片上的按钮给
      denoise: a.denoise
    });
    if(!src) throw new Error('生图模型没有返回图片');
    return { src: src, ms: Date.now() - t0 };
  }

  function blobToDataUrl(blob){
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(new Error('图片转码失败'));
      r.readAsDataURL(blob);
    });
  }

  /* 远程图（Tripo / 在线接口返回的 URL）要落进图库或本地备份，先取回 dataURL。
     直接 fetch 会被 CORS 挡，所以走 apiFetch（有本地中转兜底）。 */
  async function dimgToDataUrl(src){
    const s = String(src || '');
    if(/^data:/i.test(s)) return s;
    if(typeof apiFetch === 'function'){
      const res = await apiFetch(s, { method:'GET' }, 60000);
      if(!res.ok) throw new Error('下载图片失败：HTTP ' + res.status);
      return blobToDataUrl(await res.blob());
    }
    return blobToDataUrl(await (await fetch(s)).blob());
  }

  window.deskImage = {
    intent: dimgIntent,
    segment: dimgSegment,
    strip: dimgStrip,
    live: dimgLive,
    refine: dimgRefine,
    cleanPrompt: dimgCleanPrompt,
    source: dimgSource,
    check: dimgCheck,
    generate: dimgGenerate,
    toDataUrl: dimgToDataUrl
  };
})();
