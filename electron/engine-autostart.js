/* 本地引擎「开机自动启动」编排（主进程）
 *
 * 为什么单独成文件：main.js 已经近千行，而这段逻辑的难点不在启动、在**编排**——
 *   · 什么该启（装没装 / 跑没跑）、什么绝对不该启（没装过的 ComfyUI 意味着要先下 2 GB）
 *   · 两件事互不阻塞（ComfyUI 首次加载 torch 实测 106 秒，不能让它拖住 Ollama）
 *   · 任何一步失败都只降级提示，绝不弹错、绝不 throw —— 自动启动失败不该毁掉一次开机
 *
 * 所以这里只做决策，真正的 spawn / 探测全部由调用方注入（ollamaLaunch / comfyLaunch /
 * comfyDetect）。依赖注入的另一个好处：node 下用假依赖就能把整条编排跑一遍，不用起 Electron。
 *
 * 配置落在 userData/engines.json，默认值：
 *   ollama —— 开。`ollama serve` 常驻只占几十 MB，不加载模型就不吃显存，代价可以忽略。
 *   comfy  —— 开。**只在已装时才启**；未装绝不自动下载（2 GB + 解压 6-9 GB）。
 *   warm   —— 开（2026-10-28 改）。预热把「对话选中的本地模型」提前读进显存，
 *             换来的是第一条消息不用干等十几秒。
 *
 * 为什么 warm 从「关」翻成「开」——这不是拍脑袋，是实测出来的：
 *   Ollama 冷加载一个模型要 4-5 秒（实测 4210 ms / 4.6 s），热请求只要 42 ms。
 *   差别在于冷加载要派生 runner 进程把权重读进显存。
 *
 *   ⚠⚠ 关于「黑窗口」，这里曾经写错过一次（说「与预热无关」），
 *   那个判断后来被完整的对照实验推翻了。现在的准确结论是**两件事都归冷加载**：
 *     · 黑窗口 = Ollama 冷加载时派生 GPU 探测子进程，那个子进程要新分配一个
 *       console → 触发 Windows 11 的「默认终端委托」→ 弹出 Windows Terminal 深色窗口。
 *       实测（1ms 采样 + 持续复查可见性）：冷加载 GPU 模型 = 6 个「曾经可见」的窗口；
 *       冷加载 CPU 模型 = 0 个；模型驻留后热请求 = 0 个。
 *     · 所以「预热 + 持续保活」既能治「等」，也能治「黑窗」：
 *       预热把那次冷加载从「用户提问那一刻」挪到「客户端启动那一刻」，
 *       保活（electron/engine-keepalive.js）让它之后永远不再冷加载。
 *     · 另有一个独立开关：主进程 spawn Ollama 时不能带 detached:true，
 *       详见 main.js 的 launchOllama。
 *   记住这两条：黑窗 = 冷加载 × GPU 探测；治它有「预热保活」和「不 detached」两把刀。
 *
 * 代价仍然是显存：预热和 ComfyUI 抢同一块卡，4/6 GB 的机器上可能把生图挤成 CPU 推理。
 * 所以这个开关**保留**（models-console.js 里有「预热当前模型」），默认值改成开只是因为
 * 「首条消息要干等五秒」+「突然弹出黑窗口」这两件事，比「偶尔生图慢一点」更影响使用。
 * 只用云端模型的用户完全不受影响——预热只对 `oll:` 开头的本地模型生效。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG_NAME = 'engines.json';
const DEFAULTS = { ollama: true, comfy: true, warm: true };

function configFile(userDataDir){
  return path.join(String(userDataDir || '.'), CONFIG_NAME);
}

/* 配置只认布尔值：手改坏的、旧版本留下的、被当记事本存进提示词的，一律回落默认值。
 * （relayBase 踩过完全一样的坑：配置里的非法值一路带进 URL。） */
function normalize(raw){
  const r = (raw && typeof raw === 'object') ? raw : {};
  const pick = k => (typeof r[k] === 'boolean' ? r[k] : DEFAULTS[k]);
  return { ollama: pick('ollama'), comfy: pick('comfy'), warm: pick('warm') };
}

function readConfig(file){
  try{
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  }catch(e){
    return Object.assign({}, DEFAULTS);
  }
}

function writeConfig(file, patch){
  const next = normalize(Object.assign({}, readConfig(file), patch || {}));
  try{
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  }catch(e){ /* 写不进去就用内存里的这份，下次启动回落默认值，不值得为此报错 */ }
  return next;
}

/* 引擎状态取值（前后端共用的词表，别自己造新词）：
 *   idle      还没轮到它
 *   off       用户在设置里关掉了
 *   absent    本机没装（**不是错误**，绝大多数机器都是这个）
 *   already   本来就在跑（用户自己起的 / 上个进程没退）
 *   starting  正在启动
 *   ready     起来了
 *   failed    起不来（附 note 说明原因）
 */
const STATES = ['idle', 'off', 'absent', 'already', 'starting', 'ready', 'failed'];

function createRunner(deps){
  const d = deps || {};
  const log = typeof d.log === 'function' ? d.log : function(){};
  const emit = typeof d.emit === 'function' ? d.emit : function(){};

  const state = {
    run: false, done: false, at: 0, reason: '',
    ollama: 'idle', comfy: 'idle',
    ollamaNote: '', comfyNote: '', note: ''
  };
  let inflight = null;

  function snap(){
    return {
      run: state.run, done: state.done, at: state.at, reason: state.reason,
      ollama: state.ollama, comfy: state.comfy,
      ollamaNote: state.ollamaNote, comfyNote: state.comfyNote,
      note: state.note
    };
  }
  /* 两个引擎各自一份 note。
   * 早期共用一个字段，并行启动时后完成的那个会把前一个的原因覆盖掉——
   * 于是「Ollama 起不来（找不到 ollama.exe）」会被渲染成「ComfyUI 已就绪」，
   * 用户拿着一条完全无关的原因去排查。 */
  function set(key, val, note){
    state[key] = val;
    if(note !== undefined){
      state[key + 'Note'] = note;
      state.note = note;
    }
    state.at = Date.now();
    log(key + '=' + val + (note ? '（' + note + '）' : ''));
    emit(snap());
  }
  function userData(){
    try{ return String((typeof d.userData === 'function' ? d.userData() : '') || ''); }
    catch(e){ return ''; }
  }
  function call(name, arg){
    const fn = d[name];
    if(typeof fn !== 'function') throw new Error('缺少依赖 ' + name);
    return fn(arg);
  }

  /* ---- Ollama ----
   * 不渲染任何模型：`ollama serve` 的职责只是把 11434 端点的门打开。
   * 模型权重在第一次请求时才进显存（见 engines:warm），这是 Ollama 自己的设计，
   * 强行在启动时把 6 GB 权重读进显存，只会让「打开软件」变成「等两分钟」。 */
  async function startOllama(cfg){
    if(!cfg.ollama){ set('ollama', 'off', '已关闭开机自动启动'); return; }
    let inst = null;
    let err = '';
    try{ inst = await call('ollamaInstalled'); }
    catch(e){ err = String((e && e.message) || e); }
    /* 探测本身失败 ≠ 没安装。混为一谈会让「注册表读不到」显示成「本机没有 Ollama」，
     * 用户就跑去重装一个其实已经装好的引擎。 */
    if(err){ set('ollama', 'failed', '检测 Ollama 安装失败：' + err); return; }
    if(!inst || !inst.installed){ set('ollama', 'absent', '本机没有安装 Ollama'); return; }

    // 已在跑就别再 spawn 一个：Ollama 是常驻服务，退出应用也不会带走它
    let up = false;
    try{ up = await call('ollamaUp'); }catch(e){ up = false; }
    if(up){ set('ollama', 'already', 'Ollama 已在运行'); return; }

    set('ollama', 'starting', '正在启动 Ollama…');
    let ok = false;
    try{ ok = !!call('ollamaLaunch'); }catch(e){ ok = false; }
    if(!ok){ set('ollama', 'failed', '启动失败：找不到 ollama.exe'); return; }

    const ms = Number(d.ollamaTimeoutMs) || 30000;
    let ready = false;
    try{ ready = await call('ollamaWait', ms); }catch(e){ ready = false; }
    set('ollama', ready ? 'ready' : 'failed',
      ready ? 'Ollama 已就绪' : '启动超时（' + Math.round(ms / 1000) + ' 秒）：可稍后手动启动');
  }

  /* ---- ComfyUI ----
   * 三段式判断（未装 / 已装未跑 / 运行中），和「本地生图」App 里的口径完全一致。
   * 已装但起不来的情况下 comfySetup.launch 会自己 stop() 收尸，这里只需把原因记进 note。 */
  async function startComfy(cfg){
    if(!cfg.comfy){ set('comfy', 'off', '已关闭开机自动启动'); return; }
    let st = null;
    let err = '';
    try{ st = await call('comfyDetect'); }
    catch(e){ err = String((e && e.message) || e); }
    if(err){ set('comfy', 'failed', '检测 ComfyUI 失败：' + err); return; }
    if(!st){ set('comfy', 'failed', '检测 ComfyUI 没有返回结果'); return; }
    if(st.running){ set('comfy', 'already', 'ComfyUI 已在运行'); return; }
    if(!st.installed){ set('comfy', 'absent', '本机没有安装 ComfyUI（不会自动下载 2 GB）'); return; }

    set('comfy', 'starting', '正在启动 ComfyUI（首次加载 torch 约 100 秒）…');
    let r = null;
    try{ r = await call('comfyLaunch'); }
    catch(e){ r = { ok: false, message: String((e && e.message) || e) }; }

    if(r && r.ok){
      set('comfy', 'ready', r.already ? 'ComfyUI 已在运行' : 'ComfyUI 已就绪');
      return;
    }
    const msg = String((r && r.message) || '启动失败');
    // 用户同时点了「启动引擎」→ launch 会抛「正在启动中」，这不是错误，别记成失败
    if(/正在启动/.test(msg)){ set('comfy', 'starting', 'ComfyUI 正在启动中'); return; }
    /* 把日志尾巴拼进 note：ComfyUI 起不来的原因（缺 torch / CUDA 版本不对 / 路径带空格）
     * 全在 stdout 里，只说「启动失败」等于什么也没说。截断到 300 字，别把状态对象撑爆。 */
    const tail = (r && r.log) ? '\n' + String(r.log).slice(-300) : '';
    set('comfy', 'failed', msg + tail);
  }

  async function guard(key, fn){
    try{ await fn(); }
    catch(e){
      const msg = String((e && e.message) || e);
      state[key] = 'failed';
      state[key + 'Note'] = msg;
      state.note = msg;
      state.at = Date.now();
      log(key + ' 异常：' + msg);
      emit(snap());
    }
  }

  async function doRun(o){
    state.run = true;
    state.done = false;
    state.reason = String(o.reason || 'boot');
    state.ollama = 'idle';
    state.comfy = 'idle';
    state.ollamaNote = '';
    state.comfyNote = '';
    state.note = '';
    state.at = Date.now();
    emit(snap());

    const cfg = readConfig(configFile(userData()));
    log('开始（' + state.reason + '）配置 ' + JSON.stringify(cfg));

    /* 两个引擎**并行**起，谁也不等谁：
     * ComfyUI 这一支在慢机器上要一两分钟，串行的话 Ollama 也得跟着等一两分钟。 */
    await Promise.all([
      guard('ollama', () => startOllama(cfg)),
      guard('comfy', () => startComfy(cfg))
    ]);

    state.run = false;
    state.done = true;
    state.at = Date.now();
    emit(snap());
    log('结束 ollama=' + state.ollama + ' comfy=' + state.comfy);
    return snap();
  }

  /* run 是**幂等**的：开机自动跑一次、用户勾选开关时再跑一次，两次不会并发。
   * 重复调用返回同一个 Promise，第二条路径拿到的是同一份结果。 */
  function run(opts){
    if(inflight) return inflight;
    inflight = doRun(opts || {}).catch(e => {
      // 编排本身不该抛；真抛了也必须把状态落到 failed，而不是让窗口看到一个红叉
      const msg = String((e && e.message) || e);
      state.run = false;
      state.done = true;
      state.note = msg;
      state.at = Date.now();
      emit(snap());
      log('编排异常：' + msg);
      return snap();
    }).then(r => { inflight = null; return r; });
    return inflight;
  }

  return {
    run,
    status: snap,
    config: () => readConfig(configFile(userData())),
    setConfig: patch => writeConfig(configFile(userData()), patch)
  };
}

module.exports = {
  CONFIG_NAME, DEFAULTS, STATES, configFile, normalize, readConfig, writeConfig, createRunner
};
