/* 能力抽象层（阶段 A）：Provider 接口 + 注册表
 * 云端与本地模型统一暴露为 { id, kind, label, listModels(), generate(), status() }，
 * 调用方不关心底层是云接口还是本地引擎。
 * 现有 LLM / 生图 / Tripo 的调用逻辑原样保留（api.js / workbench.js / blueprint-runtime.js），
 * 这里只做包装与统一入口；阶段 C 将在此注册 Ollama / ComfyUI 等本地 Provider。
 */
const PROVIDER_KINDS = ['llm', 'image', '3d', 'tts'];
const PROVIDER_REGISTRY = [];

function registerProvider(p){
  if(!p || !p.id || !p.kind) throw new Error('Provider 缺少 id 或 kind');
  const old = PROVIDER_REGISTRY.findIndex(x => x.id === p.id && x.kind === p.kind);
  if(old !== -1) PROVIDER_REGISTRY[old] = p;
  else PROVIDER_REGISTRY.push(p);
  return p;
}

function providersOfKind(kind){
  return PROVIDER_REGISTRY.filter(p => p.kind === kind);
}

function providerFor(kind, id){
  const list = providersOfKind(kind);
  if(!id) return list[0] || null;
  return list.find(p => p.id === id) || null;
}

function llmCfg(){
  return {
    base: $('llmBaseUrl').value.trim().replace(/\/$/, ''),
    model: $('llmModel').value.trim(),
    key: $('llmKey').value.trim()
  };
}
function imgCfg(){
  const base = ($('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim()).replace(/\/$/, '');
  return {
    base,
    model: ($('imgModel').value.trim() || $('llmModel').value.trim()),
    key: ($('imgKey').value.trim() || $('llmKey').value.trim()),
    endpoint: $('imgEndpoint').value.trim() || '/images/edits',
    size: $('imgSize').value.trim() || '1024x1024',
    respPath: $('respPath').value.trim() || 'data[0].url'
  };
}

registerProvider({
  id: 'cloud-llm',
  kind: 'llm',
  label: '云端对话接口',
  async listModels(){
    const { base, key } = llmCfg();
    if(!base || !key) return [];
    const res = await apiFetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + key } }, 25000);
    if(!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    return parseModelList(await res.json());
  },
  async generate(args, opts){
    const { base, model, key } = llmCfg();
    if(!base || !model || !key) throw new Error('语言模型未配置：Base URL / 模型 / API Key');
    const body = Object.assign({ model, messages: args && args.messages }, opts || {});
    return post(base, key, '/chat/completions', body);
  },
  status(){
    if(typeof llmReady === 'function' && llmReady()) return true;
    const { base, model, key } = llmCfg();
    return !!(base && model && key);
  }
});

registerProvider({
  id: 'cloud-image',
  kind: 'image',
  label: '云端生图接口',
  async listModels(){
    const { base, key } = imgCfg();
    if(!base || !key) return [];
    const res = await apiFetch(base + '/models', { headers: { 'Authorization': 'Bearer ' + key } }, 25000);
    if(!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    return parseModelList(await res.json());
  },
  async generate(args, opts){
    const c = imgCfg();
    const prompt = (args && args.prompt) || '';
    const image = (args && args.image) || null;
    if(!c.base || !c.model || !c.key) throw new Error('图像模型未配置');
    let endpoint = c.endpoint;
    if(!image && /edit/i.test(endpoint)) endpoint = endpoint.replace(/edits?/i, 'generations');
    const useImage = !!(image && /edit/i.test(endpoint));
    let data;
    if(useImage){
      const blob = await (await fetch(image)).blob();
      const fd = new FormData();
      fd.append('model', c.model);
      fd.append('prompt', prompt);
      fd.append('size', c.size);
      fd.append('image', blob, 'source.png');
      const res = await apiFetch(c.base + endpoint, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + c.key },
        body: fd
      });
      if(!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
      data = await res.json();
    } else {
      const body = { model: c.model, prompt, size: c.size, n: 1 };
      if(image) body.image = image.split(',')[1];
      data = await post(c.base, c.key, endpoint, body);
    }
    const url = lookupPath(data, c.respPath);
    if(url) return { data, url };
    const b64 = lookupPath(data, 'data[0].b64_json');
    if(b64) return { data, dataUrl: 'data:image/png;base64,' + b64 };
    return { data };
  },
  status(){
    if(typeof imageReady === 'function' && imageReady()) return true;
    const c = imgCfg();
    return !!(c.base && c.model && c.key);
  }
});

registerProvider({
  id: 'tripo-image',
  kind: 'image',
  label: 'Tripo 生图',
  async listModels(){
    return TRIPO_IMAGE_MODELS.map(id => ({ id, owned_by: 'Tripo' }));
  },
  async generate(args){
    const prompt = (args && args.prompt) || '';
    const image = (args && args.image) || null;
    if(!image) throw new Error('Tripo 生图需要原图');
    const model = $('imgModel').value.trim() || 'seedream_v5';
    const token = await tripoUpload(image);
    const task = await tripoCall('/generation/image-to-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: token, prompt, size: '2K', output_format: 'png' })
    });
    const done = await tripoPoll(task.task_id);
    const url = done.output && done.output.generated_image_url;
    if(!url) throw new Error('任务完成但未返回图片地址');
    return { data: done, url };
  },
  status(){
    if(typeof imageReady === 'function' && imageReady()) return true;
    return !!($('tripoKey').value.trim() && $('imgModel').value.trim());
  }
});

registerProvider({
  id: 'tripo-3d',
  kind: '3d',
  label: 'Tripo 3D 建模',
  async listModels(){
    const ver = $('tripoVersion').value || 'v3.1-20260211';
    return [{ id: ver, owned_by: 'Tripo' }];
  },
  async generate(args){
    const image = (args && args.image) || null;
    if(!image) throw new Error('3D 建模需要原图');
    const version = $('tripoVersion').value;
    const token = await tripoUpload(image);
    const task = await tripoCall('/generation/3d/v2/' + version, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: token, tetrahedral: true, pbr: true })
    });
    const done = await tripoPoll(task.task_id);
    const modelUrl = done.output && done.output.model;
    if(!modelUrl) throw new Error('任务完成但未返回模型地址');
    return { data: done, url: modelUrl };
  },
  status(){
    return isTripo() && !!($('tripoKey').value.trim());
  }
});

/* ---- 生图来源：本地（ComfyUI） / 在线 ----
 * 和语言模型的 cloud/local 是同一个思路，但按用户说法叫「在线」。
 * 状态与模型控制台的选项卡**共用** mc_scope_image 一个键：两处各存一份必然打架
 * （切了选项卡、生图却还走原来那侧），所以这里只读写同一个键。 */
const IMG_SCOPE_KEY = 'mc_scope_image';
function imgMode(){
  try{
    const s = localStorage.getItem(IMG_SCOPE_KEY);
    if(s === 'local' || s === 'online') return s;
  }catch(e){}
  return 'online';
}
function setImgMode(mode){
  const v = mode === 'local' ? 'local' : 'online';
  try{ localStorage.setItem(IMG_SCOPE_KEY, v); }catch(e){}
  return v;
}
/* 本地生图选哪份大模型（.safetensors）。存 localStorage，不受云端 imgModel 影响——
 * imgModel 在在线模式下填的是云端模型名，混用会把 "doubao-seedream" 当成 ckpt 名发给 ComfyUI。 */
const COMFY_CKPT_KEY = 'mc_comfy_ckpt';
function comfyCkptChoice(){
  try{ return String(localStorage.getItem(COMFY_CKPT_KEY) || ''); }catch(e){ return ''; }
}
function setComfyCkpt(name){
  try{ localStorage.setItem(COMFY_CKPT_KEY, String(name || '')); }catch(e){}
}

/* 本地引擎桥客户端（阶段 C）
 * Electron 桌面端在 8794 起 plugins/runtime/runtime.js 子进程，经 /ollama/* /comfy/* 转发本地引擎。
 * 浏览器测试环境（file://）没有该服务：status() 返回缓存探测值（未探测=不可用），
 * 一切调用拿不到引擎时抛出可读错误，绝不阻塞界面。
 */
let rtHealth = { ok: false, ollama: { ok: false }, comfy: { ok: false } };

function rtBase(){
  const m = (location.search.match(/[?&]runtime=([^&]+)/) || [])[1];
  if(m) return decodeURIComponent(m).replace(/\/$/, '');
  return 'http://127.0.0.1:8794';
}
/* 桥在 /health 里报 stale = 它的源码比自己的进程新（改了 plugins/runtime/runtime.js 却没重启）。
 * 这种「跑的是旧代码」最难查：报错看着像模型/配置问题，其实是请求在半路被旧逻辑改写。
 * 桌面端可以原地换掉那个子进程（端口不变）；只换一次，换不掉就继续用，别把界面卡在这儿。 */
let rtRestartTried = false;

async function rtProbe(){
  try{
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(rtBase() + '/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    return res.ok ? await res.json() : { ok: false, ollama: { ok: false }, comfy: { ok: false } };
  }catch(e){
    return { ok: false, ollama: { ok: false }, comfy: { ok: false } };
  }
}

/* 多次调用只发一次探测：面板、对话页头、出图前检查常常同一帧里一起问，
 * 各发一次只会让桥同时探三遍引擎——而探针本身是「最可能有延迟」的那一步。 */
let rtInflight = null;
let rtHealthAt = 0;      // 上次探测成功写入的时间；0 表示还没探过

async function rtRefresh(){
  if(rtInflight) return rtInflight;
  rtInflight = (async () => {
    let h = await rtProbe();
    if(h && h.stale && !rtRestartTried){
      rtRestartTried = true;
      const d = window.openagiDesktop;
      const canRestart = !!(d && typeof d.serviceRestart === 'function');
      if(canRestart){
        try{
          const r = await d.serviceRestart('runtime');
          if(r && r.ok) h = await rtProbe();     // 换好了再探一次，拿到新进程的 build
        }catch(e){}
      }
      if(h && h.stale && typeof deskToast === 'function'){
        // 桌面端有预加载桥但没这个能力 = 预加载还是旧的（窗口是改代码之前开的）
        deskToast(canRestart
          ? '本地服务没换成功，仍是旧代码：请重启应用'
          : (d ? '本地服务在跑旧代码：重启应用后才生效' : '本地服务在跑旧代码：关掉再重新打开 start.bat 才生效'));
      }
    }
    rtHealth = h;
    rtHealthAt = Date.now();
    return rtHealth;
  })();
  try{ return await rtInflight; }
  finally{ rtInflight = null; }
}
async function rtFetch(path, opts){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try{
    const res = await fetch(rtBase() + path, Object.assign({ signal: ctrl.signal, cache: 'no-store' }, opts || {}));
    let data = null;
    try{ data = await res.json(); }catch(e){}
    if(!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data || {};
  }catch(e){
    if(e && e.name === 'AbortError') throw new Error('引擎无响应（30 秒超时）');
    if(e instanceof TypeError) throw new Error('连不上本地引擎服务：' + rtBase() + '（请通过桌面端启动，或先运行 node plugins\runtime\runtime.js）');
    throw e;
  }finally{
    clearTimeout(timer);
  }
}
// 长耗时流式接口（如模型拉取）：Ollama /api/pull 返回 NDJSON 流，逐行回调。
// 单次不设 30s 短超时，改为 1 小时；中途断线可重试（Ollama 支持断点续传）。
// opts.stallMs：多久没收到任何一包就判定卡住。1 小时的总超时对「进度条一直不动」
// 没有任何帮助——真要卡住，界面会挂在那儿一小时，用户只会以为按钮没反应。
async function rtFetchStream(path, opts, onLine){
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3600000);
  const init = Object.assign({}, opts || {});
  const stallMs = Number(init.stallMs) || 0;
  delete init.stallMs;
  let stalled = false;
  let stallTimer = null;
  const armStall = () => {
    if(!stallMs) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stalled = true; ctrl.abort(); }, stallMs);
  };
  let reader = null;
  try{
    const res = await fetch(rtBase() + path, Object.assign({ signal: ctrl.signal, cache: 'no-store' }, init));
    if(!res.ok){
      let data = null;
      try{ data = await res.json(); }catch(e){}
      throw new Error((data && data.error) || ('HTTP ' + res.status));
    }
    if(!res.body) throw new Error('引擎未返回数据流');
    reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    const eat = line => {
      const s = String(line || '').trim();
      if(!s) return;
      let obj = null;
      try{ obj = JSON.parse(s); }catch(e){}
      if(onLine && typeof onLine === 'function') onLine(obj);
    };
    for(;;){
      armStall();
      const part = await reader.read();
      if(part.done) break;
      buf += decoder.decode(part.value, { stream: true });
      let idx;
      while((idx = buf.indexOf('\n')) !== -1){
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        eat(line);
      }
    }
    // 最后一行没有换行符时不能丢：pull 的 success 事件就常常是流的最后一包
    eat(buf + decoder.decode());
    return true;
  }catch(e){
    // onLine 里主动抛的错（比如 pull 返回 {"error":...}）也要把连接放掉，
    // 否则下游流一直挂着，界面永远停在「下载中」
    try{ if(reader) await reader.cancel(); }catch(_){}
    if(stalled) throw new Error('引擎超过 ' + Math.round(stallMs / 1000) + ' 秒没有任何响应，可能已卡死（Ollama 支持续传，可以再点一次）');
    if(e && e.name === 'AbortError') throw new Error('引擎无响应（拉取超过 1 小时，可重试续传）');
    if(e instanceof TypeError) throw new Error('连不上本地引擎服务：' + rtBase());
    throw e;
  }finally{
    clearTimeout(timer);
    clearTimeout(stallTimer);
  }
}
/* 模型动辄几个 GB，按 MB 显示会变成 4500.0 MB，读起来费劲 */
function fmtSize(n){
  const b = Number(n) || 0;
  return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB';
}

registerProvider({
  id: 'ollama-llm',
  kind: 'llm',
  label: 'Ollama 本地模型',
  local: true,
  async listModels(){
    const d = await rtFetch('/ollama/api/tags');
    if(!Array.isArray(d.models)) return [];
    return d.models.map(m => ({
      id: String(m.name || ''),
      owned_by: 'Ollama',
      sizeMB: Math.round((Number(m.size) || 0) / 1048576)
    })).filter(m => m.id);
  },
  async generate(args, opts){
    const model = (opts && opts.model) || (args && args.model) || '';
    if(!model) throw new Error('Ollama 未指定模型名');
    const d = await rtFetch('/ollama/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: (args && args.messages) || [],
        stream: false,
        options: Object.assign({}, (opts && opts.options) || {})
      })
    });
    return { data: d, content: d && d.message && d.message.content || '' };
  },
  status(){
    return !!(rtHealth.ollama && rtHealth.ollama.ok);
  },
  /* 拉取模型：POST /api/pull，流式 NDJSON。
   *
   * ⚠️ 进度判定只看 completed / total，**绝不能看 status 字符串**。
   * Ollama 0.40 实测（`all-minilm` 全量事件抓包）：整个下载过程中 status 一直是
   * "pulling 797b70c4edf8"，从头到尾没有出现过 "downloading"。老代码按
   * `status === 'downloading'` 取进度，于是 pct 恒为 -1、进度条恒为 0%，
   * 界面上只剩一行原始状态串「pulling 170370233dd5」——用户看到的就是「点了没反应」。
   *
   * 另外两个实测细节：
   * ① 每层开头十几个事件只有 total、没有 completed，若把缺字段当 0 会把已下好的进度打回起点；
   * ② 多层的 completed/total 要按 digest 分别记，再求总和，否则百分比会来回跳。
   */
  pullModel(name, onProgress){
    const acc = {};     // digest -> { completed, total }
    let peak = 0;       // 分母不变时的百分比峰值：重连会让 completed 短暂回退
    let lastTotal = -1; // 分母一变就得重算，否则会被钉在上一个分母的 100%
    let speed = 0;      // 字节/秒，滑动平滑
    let lastT = 0;
    let lastC = 0;

    function emit(pct, message, bytes, total){
      if(typeof onProgress !== 'function') return;
      const etaMs = (speed > 1024 && total > bytes) ? Math.round((total - bytes) / speed * 1000) : -1;
      onProgress({ pct, message, speed, etaMs });
    }

    return rtFetchStream('/ollama/api/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      // 正常拉取每秒钟都有事件；两分钟一包都没有就是真卡了
      stallMs: 120000
    }, ev => {
      if(!ev) return;
      // 模型名不存在、磁盘满等会走 {"error": "..."}，不抛出去就成了「永远卡在下载中」
      if(ev.error) throw new Error(String(ev.error));

      if(ev.digest){
        const d = acc[ev.digest] || (acc[ev.digest] = { completed: 0, total: 0 });
        if(typeof ev.total === 'number' && ev.total > 0) d.total = ev.total;
        if(typeof ev.completed === 'number') d.completed = ev.completed;   // 缺字段就沿用旧值
      }
      let bytes = 0;
      let total = 0;
      for(const k in acc){ bytes += acc[k].completed; total += acc[k].total; }

      const now = Date.now();
      if(!lastT){ lastT = now; lastC = bytes; }
      else if(now - lastT >= 500){
        const inst = (bytes - lastC) / ((now - lastT) / 1000);
        if(inst > 0) speed = speed ? speed * 0.55 + inst * 0.45 : inst;
        lastT = now;
        lastC = bytes;
      }

      const st = String(ev.status || '');
      let pct = total > 0 ? Math.round(bytes / total * 100) : -1;
      if(pct >= 0){
        /* 分层拉取：小文件层的 total 是等它开始下才报的，分母会在中途变大
         * （实测 4.4 GB 的主权重先下完，后面才冒出 16 字节、407 字节的配置层）。
         * 分母一变就从当前值重新起算，否则小层下完那一下冲到 100%，之后永远停在那。 */
        if(total !== lastTotal){ lastTotal = total; peak = 0; }
        pct = Math.min(100, Math.max(peak, pct));
        peak = pct;
      }

      let message;
      if(st === 'success'){
        pct = 100;
        peak = 100;
        message = '下载完成';
      } else if(/^pulling manifest/i.test(st)){
        message = '读取模型清单…';
      } else if(/^pulling\s/i.test(st)){
        message = pct >= 0
          ? '下载中 ' + pct + '%（' + fmtSize(bytes) + ' / ' + fmtSize(total) + '）'
          : '准备下载…';
      } else if(/verifying/i.test(st)){
        message = '校验文件完整性…';
      } else if(/writing manifest/i.test(st)){
        message = '写入模型清单…';
      } else if(/removing/i.test(st)){
        message = '清理旧文件…';
      } else {
        message = st || '下载中…';
      }

      emit(pct, message, bytes, total);
    });
  },
  /* 卸载模型。
   * Ollama 0.40 的 /api/delete **只收 DELETE**，用 POST 会直接 405 method not allowed
   * （实测：POST→405、DELETE→404 model not found）。老版本收 POST，
   * 所以先 DELETE，只在「方法不允许」时回退 POST，别把版本差异丢给用户。
   * 404 = 本来就没有，按成功处理：用户点卸载的意图是「让它别再占地方」。 */
  async deleteModel(name){
    try{
      return await rtFetch('/ollama/api/delete', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name })
      });
    }catch(e){
      const msg = String((e && e.message) || e);
      if(/not found|未找到/i.test(msg)) return {};
      if(!/HTTP 405/i.test(msg)) throw e;
      return await rtFetch('/ollama/api/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name })
      });
    }
  }
});

/* ---- ComfyUI 本地生图 ----
 * 内置默认工作流：用户不需要拖节点、也不用导入 json，装完引擎直接能用。
 * 流程走 ComfyUI 的 HTTP API：POST /prompt 提交 → GET /history/{id} 轮询 → GET /view 取图。
 * 所有请求都经本地引擎桥（8794）转发：浏览器直连 8188 会被 CORS 挡。
 */
// SD1.5 通用负向词。写死在这里是为了「装完就能出好图」，不指望用户自己去配。
const COMFY_NEGATIVE = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, ' +
  'fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry';

/* 图生图的重绘强度（denoise）。
 *
 * 0.6 以前是写死的默认值，对 SD1.5 偏高：主体会挪位置、姿态会变，用户看到的就是
 * 「构图和参考图不吻合」。而本地这一套没有 mask / ControlNet，**强度就是唯一的构图约束**，
 * 所以只能按用户想改多少来分档（顺序有讲究：「把背景换成海边日落，猫保持不变」里既有
 * 「背景」也有「保持」，必须先认「要动哪儿」，否则会被「保持」判成微调，最后什么都没改）。
 *   换背景 / 换场景 → 0.62（再高主体就保不住了）
 *   换风格 / 换画风 → 0.52
 *   只想微调（保结构 / 提质感 / 修细节）→ 0.35
 *   其他改图 → 0.45
 */
function comfyDenoiseFor(text){
  const t = String(text || '');
  if(/(背景|场景|环境|天气|季节|换到|搬到大|日落|夜晚|夜景|雪|雨|海边|沙滩|森林|室内|室外|天空)/.test(t)) return 0.62;
  if(/(风格|画风|水彩|油画|动漫|卡通|赛博|素描|像素|胶片|手绘)/.test(t)) return 0.52;
  if(/(保持|不变|微调|轻微|稍微|细节|质感|清晰|修复|修一下|精修|锐化|放大|高清|去掉|消除)/.test(t)) return 0.35;
  return 0.45;
}

/* 尺寸：ComfyUI 要求 8 的倍数，且过大在 4 GB 卡上会直接爆显存 */
/* 每个模型「见过多大的图」，决定了它能把多大的图**画好**。
 * ⚠️ 实测事故：用 SD1.5（v1-5-pruned-emaonly）按设置里的默认 1024×1024 出图，
 * 结果是一整张**拼贴画**——几十个互不相干的小人小脸，用户第一反应是
 * 「生成的图和提示词没关系」。其实提示词没错，是分辨率超了 SD1.5 的训练分布
 * （它只见过 512），于是它在画布上重复铺满主体。原始 base 模型在 768 以上就可能开始重复，
 * 所以 1.5 的上限压到 768。SDXL 见过 1024，可以到 1536。
 * 返回 { cap: 长边上限, base: 没填尺寸时的默认边长 }。 */
function comfyModelCap(ckpt){
  const n = String(ckpt || '').toLowerCase();
  if(!n) return { cap: 2048, base: 512 };                       // 不知道是啥：不擅自收紧
  if(/sdxl|sd[-_]?xl|xl[-_]?(base|refiner|turbo)|juggernaut|pony|illustrious|noobai/.test(n)){
    return { cap: 1536, base: 1024 };
  }
  if(/turbo|lcm|lightning|hyper|dmd/.test(n)) return { cap: 1024, base: 768 };
  if(/sd[-_ ]?1[._-]?5|v1-5|sd15|dreamshaper|anything|meinamix|toonyou|rev[-_]?anime|majic/.test(n)){
    return { cap: 768, base: 512 };
  }
  return { cap: 1024, base: 768 };
}

function comfySize(raw, ckpt){
  const { cap, base } = comfyModelCap(ckpt);
  const m = String(raw || '').match(/(\d+)\s*[x×*]\s*(\d+)/i);
  const r8 = n => Math.max(64, Math.round((Number(n) || base) / 8) * 8);
  let width = m ? r8(m[1]) : r8(base);
  let height = m ? r8(m[2]) : r8(base);
  const side = Math.max(width, height);
  if(side > cap){
    // 按比例缩：把 16:9 压成方的会得到一张「构图全毁」的图，比画小一点更糟
    const k = cap / side;
    width = Math.max(64, Math.round(width * k / 8) * 8);
    height = Math.max(64, Math.round(height * k / 8) * 8);
  }
  return { width, height };
}

/* 默认工作流（ComfyUI API 格式，节点 id 用字符串）。
 * 图生图时换成 LoadImage → VAEEncode，denoise < 1 表示在参考图上重绘。 */
function comfyWorkflow(o){
  // 尺寸按模型收紧：SD1.5 撑到 1024 会把主体重复铺满整张画布（拼贴画）
  const { width, height } = comfySize(o.size, o.ckpt);
  const wf = {
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.ckpt } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: o.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: o.negative, clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'openagi', images: ['8', 0] } }
  };
  const ks = {
    seed: o.seed, steps: o.steps, cfg: o.cfg, sampler_name: 'euler', scheduler: 'normal',
    model: ['4', 0], positive: ['6', 0], negative: ['7', 0]
  };
  if(o.uploaded){
    wf['10'] = { class_type: 'LoadImage', inputs: { image: o.uploaded } };
    wf['11'] = { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['4', 2] } };
    wf['3'] = { class_type: 'KSampler', inputs: Object.assign(ks, { denoise: o.denoise, latent_image: ['11', 0] }) };
  } else {
    wf['5'] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
    wf['3'] = { class_type: 'KSampler', inputs: Object.assign(ks, { denoise: 1, latent_image: ['5', 0] }) };
  }
  return wf;
}

/* 可选模型列表：读 CheckpointLoaderSimple 的 ckpt_name 枚举 */
async function comfyCkpts(){
  const d = await rtFetch('/comfy/object_info/CheckpointLoaderSimple');
  const req = d && d.CheckpointLoaderSimple && d.CheckpointLoaderSimple.input
    && d.CheckpointLoaderSimple.input.required;
  const list = req && req.ckpt_name && req.ckpt_name[0];
  return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
}

/* 选哪份模型：用户点过就用点过的，否则优先 SD1.5（4 GB 卡跑得动），再退到第一份 */
function comfyPickCkpt(list){
  const want = comfyCkptChoice();
  if(want && list.indexOf(want) !== -1) return want;
  const sd15 = list.find(n => /sd[-_ ]?1[._-]?5|v1-5|sd15/i.test(n));
  return sd15 || list[0] || '';
}

/* 参考图也要收进模型能处理的尺寸：SD1.5 的 VAEEncode 吃一张 1600px 的参考图，
 * 出来同样是「主体重复铺满」。长边压到 cap，比例不变。 */
function comfyFitImage(dataUrl, cap){
  const s = String(dataUrl || '');
  if(!s || typeof Image === 'undefined' || typeof document === 'undefined') return Promise.resolve(s);
  return new Promise(resolve => {
    let done = false;
    const fin = v => { if(!done){ done = true; resolve(v); } };
    const img = new Image();
    img.onload = () => {
      try{
        const w0 = img.naturalWidth || img.width;
        const h0 = img.naturalHeight || img.height;
        const side = Math.max(w0, h0);
        if(!side || side <= cap) return fin(s);
        const k = cap / side;
        const w = Math.max(64, Math.round(w0 * k));
        const h = Math.max(64, Math.round(h0 * k));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        fin(c.toDataURL('image/jpeg', 0.92));
      }catch(e){ fin(s); }
    };
    img.onerror = () => fin(s);
    img.src = s;
  });
}

/* ---- 中文提示词要先译成英文（本地分支专用） ----
 * ⚠️ 实测事故：SD1.5 的 CLIP 是英文语料训出来的，中文会被切成一串 <unk>，
 * 出图和提示词**毫无关系**（同一句「一只猫站在窗户边」实测得到一张燃烧的街景，
 * 换成英文立刻是窗边的猫）。在线模型（Seedream / Tripo）认中文，所以这条只在这里做。
 * 译文按原文缓存：点「再生成」「重试」不该反复花一次翻译。 */
const COMFY_CJK = /[\u4e00-\u9fff]/;
const COMFY_TR_SYS = [
  '你是 Stable Diffusion 提示词翻译器。',
  '把用户给的中文描述翻成英文提示词：逗号分隔的短语，保留主体、动作、环境、光线、风格、画质词；',
  '只写画面里「有」的东西：绝对不要写 blurred / blurry / low resolution / low quality / noise / watermark 这类词，',
  '  它们在正向提示词里会让画面变糊（负面词属于另一个字段，不归你写）；',
  '遇到「把 A 换成 B」「背景改成 B」「去掉 C」这类改动，不要写 "changed to" 这种句子，',
  '  而是直接描述**改完之后的样子**，并把改动的位置写出来：',
  '  「把背景换成海边日落」→ `cat, seaside sunset background, beach at sunset, warm light`；',
  '  「改成水彩风格」→ `watercolor painting, soft washes, paper texture`。',
  '  （CLIP 读不懂 "changed to"；它只会照着名词画。至于「保持不变」「同一个姿势」这类约束不用翻，',
  '   图生图靠重绘强度控制，写进提示词只会白白干扰。）',
  '输出里绝对不能出现任何汉字（「材质」「构图」「写实」这类词也必须换成英文）；',
  '不要解释、不要引号、不要 markdown，只输出英文提示词本身，不超过 80 个词。'
].join('\n');
const comfyTrCache = new Map();
let comfyLastTr = { zh: '', en: '', ok: false };

function comfyLastLocalize(){ return comfyLastTr; }

/* 正/负向提示词的词表是分开的，小模型经常写串：
 * 实测「把背景换成海边日落」被译成 `cat, seaside sunset, blurred, low resolution, soft lighting`
 * —— blurred / low resolution 塞进正向提示词，等于主动要一张糊图。
 * 系统提示里已经明令禁止，但 3B 模型的服从性靠不住，所以这里再兜一层。 */
const COMFY_NEG_WORDS = /\b(blurr?(ed|y)|low\s*-?\s*(res|resolution|quality)|worst\s+quality|bad\s+(anatomy|hands|quality)|noise|noisy|jpeg\s+artifacts|watermark|text|signature|username|deformed|disfigured|mutated|extra\s+(limbs?|digits?)|cropped|out\s+of\s+frame|oversaturat\w*|undersaturat\w*)\b/gi;

function comfyStripNeg(en){
  const s = String(en || '');
  if(!COMFY_NEG_WORDS.test(s)) return { text: s, removed: 0 };
  COMFY_NEG_WORDS.lastIndex = 0;
  const removed = (s.match(COMFY_NEG_WORDS) || []).length;
  COMFY_NEG_WORDS.lastIndex = 0;
  const text = s
    .replace(COMFY_NEG_WORDS, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
  return { text, removed };
}

/* 译文清理：模型经常带上引号、markdown 围栏、换行，CLIP 都得吃干净的一句话。 */
function comfyCleanTr(out){
  return String(out || '')
    .replace(/^```[a-z]*\s*|```$/gi, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .trim()
    .slice(0, 600);
}

/* 译文够不够用 —— 判据不能是「含不含中文」，也不能是「中文占多少」。
 *
 * 实测（qwen2.5:3b，本机、temperature 0，同一句话连跑两次）：
 *   `Cat on the ground, sunlight filtering through leaves onto it,细腻材质，低角度镜头，简洁构图，写实风格…`
 *   `cat on the ground, sunlight through leaves on it,细腻材质, low angle shot,简洁构图, realist style…`
 * 典型形态就是**前半英语、后半犯懒复述中文**。前一句里「主体 + 动作 + 光线」全都有，
 * 后面的中文段剔掉就是一条能用的提示词。
 *
 * 所以只看一件事：**把汉字片段剔掉之后，还剩不剩英文短语**。
 * 原来按「汉字占比 > 1/3 判失败」试过，这类刚好卡在 34% 的输出会被扔掉，
 * 退化成整段中文喂 CLIP —— 那才是出图和描述完全无关的根因。 */
function comfyTrQuality(en){
  // 先把串进正向提示词的负面词剔掉，再判够不够用（顺序不能反：剔完可能就没英文了）
  const s = comfyStripNeg(String(en || '').trim()).text;
  if(!s) return { ok: false, why: '译文为空' };
  const cleaned = s
    .replace(/[\u4e00-\u9fff]+[、，,;；:：]?/g, ' ')      // 汉字片段连同它后面的分隔符一起剔
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,，、]+|[\s,，、]+$/g, '')
    .trim();
  const words = cleaned.split(/\s+/).filter(w => /[A-Za-z]/.test(w));
  if(words.length < 2) return { ok: false, why: s.length > 12 ? '基本还是中文' : '只剩一两个英文词' };
  return { ok: true, text: cleaned };
}

/* 兜底翻译：直接用本机 Ollama 经桥翻。
 *
 * 为什么需要这条：翻译这一步以前完全寄望于「用户把语言模型配好了」，可那是另一套设置，
 * 和「我要本地生图」根本是两件事。配了云端但没登录、填了 Ollama 却没走桥（被 CORS 拦）、
 * 模型名写错一个字 —— 任何一种都会让中文原样喂给只认英文的 CLIP，出图就成了随机图，
 * 界面上只有一句含糊的「语言模型没配好」。而本机 Ollama 从这一版起是开机默认启动的，
 * 它翻「猫趴在地上」这种句子绰绰有余（实测 qwen2.5:3b 548ms）。
 *
 * 模型怎么挑：排除 embedding（它们不能对话），视觉模型排后面（慢且没必要），
 * 其余按参数量从小到大——翻译不需要大模型，快才是第一位的。 */
function comfyPickTrModel(names){
  const rank = n => {
    const s = String(n || '');
    if(/embed|bge|minilm|rerank/i.test(s)) return 999;          // 不能对话，直接排最后
    let r = /vl|vision|llava|moondream/i.test(s) ? 100 : 0;     // 视觉模型：能翻，但没必要
    const m = s.match(/:(\d+(?:\.\d+)?)\s*b/i);
    r += m ? Number(m[1]) : 20;                                  // 参数量小的优先
    return r;
  };
  return (names || []).slice().sort((a, b) => rank(a) - rank(b))[0] || '';
}

async function comfyTranslateOllama(s, timeoutMs){
  if(typeof rtFetch !== 'function') throw new Error('桥未加载');
  const tags = await rtFetch('/ollama/api/tags');
  const model = comfyPickTrModel(((tags && tags.models) || []).map(m => m && m.name));
  if(!model) throw new Error('本机没有可用的 Ollama 模型');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(4000, Number(timeoutMs) || 20000));
  try{
    // 走桥的 OpenAI 兼容端点：和 llmStreamRequest 同一个协议，便于复用译文清理
    const res = await fetch(rtBase() + '/ollama/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: COMFY_TR_SYS }, { role: 'user', content: s }],
        temperature: 0,
        max_tokens: 220,
        stream: false
      }),
      signal: ctrl.signal
    });
    if(!res.ok) throw new Error('Ollama HTTP ' + res.status);
    const j = await res.json();
    const txt = comfyCleanTr(j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content);
    if(!txt) throw new Error('Ollama 返回空译文');
    return { model, text: txt };
  }catch(e){
    if(e && e.name === 'AbortError') throw new Error('Ollama 翻译超时');
    throw e;
  }finally{
    clearTimeout(timer);
  }
}

async function comfyLocalize(prompt){
  const s = String(prompt || '').trim();
  if(!s || !COMFY_CJK.test(s)){
    comfyLastTr = { zh: s, en: s, ok: true, skipped: true };
    return s;
  }
  if(comfyTrCache.has(s)){
    comfyLastTr = { zh: s, en: comfyTrCache.get(s), ok: true, cached: true };
    return comfyLastTr.en;
  }
  /* 一条降级链，任何一环成功就够：
   *   ① 用户配的语言模型（云端 / 本地都行，质量最好）
   *   ② 本机 Ollama（经桥，不需要任何配置——它现在是开机默认启动的）
   *   ③ 都不行：中文原样送，并把**真正的原因**带回去（界面不能只说「没配好」）
   * 只要有一环成了，用户就得到一张跟描述有关的图；这才是「能生图」的底线。 */
  const why = [];
  let conn = null;
  try{
    if(typeof llmConn === 'function') conn = llmConn();
  }catch(e){ conn = null; }

  if(typeof llmStreamRequest === 'function' && conn && conn.base && conn.key && conn.model){
    try{
      // 15 秒：本机 Ollama 首次加载可能十几秒，再久就别等了——宁可出图慢一点也别卡住队列
      const out = await llmStreamRequest(COMFY_TR_SYS, [{ role: 'user', content: s }], null, { conn, timeoutMs: 15000 });
      const q = comfyTrQuality(comfyCleanTr(out));
      if(q.ok){
        if(comfyTrCache.size > 60) comfyTrCache.clear();
        comfyTrCache.set(s, q.text);
        comfyLastTr = { zh: s, en: q.text, ok: true, via: 'conn', model: conn.model };
        return q.text;
      }
      why.push('语言模型' + (q.why || '没输出英文'));
    }catch(e){
      why.push('语言模型：' + String((e && e.message) || e).slice(0, 60));
    }
  }else{
    why.push('没配语言模型');
  }

  try{
    const r = await comfyTranslateOllama(s, 20000);
    const q = comfyTrQuality(r.text);
    if(q.ok){
      if(comfyTrCache.size > 60) comfyTrCache.clear();
      comfyTrCache.set(s, q.text);
      comfyLastTr = { zh: s, en: q.text, ok: true, via: 'ollama', model: r.model };
      return q.text;
    }
    why.push('Ollama ' + (q.why || '没输出英文'));
  }catch(e){
    why.push('Ollama：' + String((e && e.message) || e).slice(0, 60));
  }

  comfyLastTr = { zh: s, en: s, ok: false, reason: why.join('；') };
  return s;
}

async function comfyUpload(dataUrl){
  const blob = await (await fetch(dataUrl)).blob();
  const fd = new FormData();
  fd.append('image', blob, 'input.png');
  fd.append('overwrite', 'true');
  const res = await fetch(rtBase() + '/comfy/upload/image', { method: 'POST', body: fd, cache: 'no-store' });
  if(!res.ok) throw new Error('上传参考图到 ComfyUI 失败：HTTP ' + res.status);
  let d = null;
  try{ d = await res.json(); }catch(e){}
  if(!d || !d.name) throw new Error('ComfyUI 未返回参考图文件名');
  // LoadImage 认的是「子目录/文件名」这种相对路径
  return d.subfolder ? d.subfolder + '/' + d.name : String(d.name);
}

async function comfyQueue(wf){
  let d = null;
  try{
    d = await rtFetch('/comfy/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: 'openagi-' + Date.now() })
    });
  }catch(e){
    throw new Error('提交工作流失败：' + String((e && e.message) || e));
  }
  if(d && d.prompt_id) return String(d.prompt_id);
  // ComfyUI 校验失败时会返回 node_errors，直接把它翻成人话比「提交失败」有用得多
  const ne = d && d.node_errors;
  const first = ne && Object.keys(ne)[0];
  const msg = first && ne[first] && ne[first].errors && ne[first].errors[0];
  throw new Error('工作流被 ComfyUI 拒绝：' + (msg && (msg.message || msg.type) || '节点校验未通过'));
}

async function comfyWait(id, opts){
  const o = opts || {};
  const ext = o.signal;
  const timeoutMs = Number(o.timeoutSec || 300) * 1000;
  const started = Date.now();
  for(;;){
    if(ext && ext.aborted){
      // 光抛异常 ComfyUI 那边还在算，占着显存；顺手让它停下
      try{ await rtFetch('/comfy/interrupt', { method: 'POST' }); }catch(e){}
      const err = new Error('已中断');
      err.name = 'AbortError';
      throw err;
    }
    const d = await rtFetch('/comfy/history/' + encodeURIComponent(id));
    const job = d && d[id];
    const outs = job && job.outputs;
    if(outs){
      for(const k in outs){
        const imgs = outs[k] && outs[k].images;
        if(Array.isArray(imgs) && imgs.length) return imgs[0];
      }
      throw new Error('ComfyUI 跑完了但没有输出图片（SaveImage 节点被改动过？）');
    }
    if(job && job.status && job.status.status_str === 'error'){
      throw new Error('ComfyUI 执行出错：' + (job.status.messages || '详见引擎日志'));
    }
    if(Date.now() - started > timeoutMs){
      throw new Error('ComfyUI 生成超时（' + Math.round(timeoutMs / 1000) + ' 秒）：大模型 + 大分辨率在 4 GB 显存上会非常慢，可降低分辨率重试');
    }
    await new Promise(r => setTimeout(r, 700));
  }
}

async function comfyView(file){
  const name = String(file.filename || '');
  const type = String(file.type || 'output');
  const q = '?filename=' + encodeURIComponent(name) +
    '&subfolder=' + encodeURIComponent(file.subfolder || '') +
    '&type=' + encodeURIComponent(type);
  const res = await fetch(rtBase() + '/comfy/view' + q, { cache: 'no-store' });
  /* 404 只有两种可能：文件真的不在了，或者桥转发时丢了查询串（曾经就这样：
   * /comfy/view?filename=… 被转成 /view，ComfyUI 一律 404）。
   * 光说「HTTP 404」没法区分，所以把文件名和类型一起打出来。 */
  if(!res.ok) throw new Error('取回生成图失败：HTTP ' + res.status + '（' + (name || '无文件名') + ' · ' + type + '）');
  const blob = await res.blob();
  // 转 dataURL：下游节点、画布、存盘都按 dataURL 处理，blob: 地址刷新后就失效了
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('生成图读取失败'));
    fr.readAsDataURL(blob);
  });
}

registerProvider({
  id: 'comfy-image',
  kind: 'image',
  label: 'ComfyUI 本地生图',
  local: true,
  async listModels(){
    const list = await comfyCkpts();
    // 没有模型也要能进列表（否则面板会显示「读取失败」，看起来像引擎坏了）
    return list.length ? list.map(id => ({ id, owned_by: 'ComfyUI' })) : [];
  },
  async generate(args, opts){
    const a = args || {};
    const o = opts || {};
    if(!(rtHealth.comfy && rtHealth.comfy.ok)){
      throw new Error('ComfyUI 没在运行：到「模型控制台 → 本地生图引擎」里启动，或先一键安装');
    }
    let list = [];
    try{ list = await comfyCkpts(); }catch(e){ list = []; }
    const ckpt = comfyPickCkpt(list);
    if(!ckpt){
      throw new Error('ComfyUI 里还没有生图模型：把 .safetensors 放进 ComfyUI/models/checkpoints 后点「重新检测」');
    }
    /* 采样参数跟着模型走：商店里的条目带推荐值（SDXL-Turbo 必须 cfg=1、6 步），
     * 一律用 20 步 / cfg 7 会让 turbo 出一团灰糊的图，看起来像「本地生图不能用」。 */
    const tune = (typeof comfyTuningFor === 'function' ? comfyTuningFor(ckpt) : null) || {};
    // 参考图先用模型自己的上限压一遍：1600px 的图喂给 SD1.5，出来是拼贴画
    const cap = comfyModelCap(ckpt).cap;
    const uploaded = a.image ? await comfyUpload(await comfyFitImage(a.image, cap)) : '';
    // 中文提示词对 SD1.5 等于噪声，先译成英文（译不了就原样送，界面会说明）
    const promptEn = await comfyLocalize(String(a.prompt || ''));
    const wf = comfyWorkflow({
      ckpt,
      prompt: promptEn,
      negative: String(a.negative || COMFY_NEGATIVE),
      size: o.size || a.size || ($('imgSize') ? $('imgSize').value : '') || tune.size || '',
      seed: Number.isFinite(Number(o.seed)) ? Number(o.seed) : Math.floor(Math.random() * 1e9),
      steps: Math.max(1, Math.min(80, Number(o.steps) || Number(tune.steps) || 20)),
      cfg: Math.max(1, Math.min(20, Number(o.cfg) || Number(tune.cfg) || 7)),
      /* 图生图的强度按「想改多少」定档（写死 0.6 会把构图改掉）；从零生成时恒为 1。
         用户/节点显式传 denoise 时以传入值为准。 */
      denoise: Math.max(0.05, Math.min(1, Number(o.denoise) || (uploaded ? comfyDenoiseFor(a.prompt) : 1))),
      uploaded
    });
    const id = await comfyQueue(wf);
    const file = await comfyWait(id, { signal: o.signal, timeoutSec: o.timeoutSec });
    const dataUrl = await comfyView(file);
    return { data: { prompt_id: id, file, ckpt, promptUsed: promptEn, translated: promptEn !== String(a.prompt || '') }, dataUrl, url: dataUrl };
  },
  status(){
    return !!(rtHealth.comfy && rtHealth.comfy.ok);
  }
});
