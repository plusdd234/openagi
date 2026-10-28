/* 本地模型「驻留续期」（主进程，纯逻辑，依赖注入）
 *
 * 为什么需要它——这不是拍脑袋，是实测出来的：
 *
 *   ① Ollama 的 keep_alive 是「从最后一次请求起算」的 TTL，不是「从加载起算」。
 *      实测：keep_alive:'2m' 冷加载后 /api/ps 的 expires_at = 加载时刻 +2m；
 *      20 秒后发一个「空 prompt」的 generate 请求，expires_at 被推后到
 *      该请求时刻 +2m（+20 秒整）。
 *      ⇒ 只要周期性发一个空 prompt 请求，模型就能一直留在显存里。
 *
 *   ② 这件事和「黑窗口」直接相关，那才是它存在的理由：
 *      黑窗口 = Ollama **冷加载**时的 GPU 探测子进程要新分配一个 console，
 *      触发 Windows 11 的「默认终端委托」，弹出 Windows Terminal 深色窗口
 *      （详见 main.js 的 launchOllama 注释里的完整证据链）。
 *      模型一旦驻留，提问走热请求，就**不再冷加载** → 不再探测 → 不再弹窗。
 *      实测（同一台机器、同一模型、1ms 间隔窗口探针 + 持续复查可见性）：
 *        冷加载 GPU 模型 → 6 个「曾经可见」的窗口
 *        模型驻留后热请求 → 0 个
 *
 * 为什么不用 keep_alive:-1（永久驻留）：
 *   那样模型永不掉显存，VRAM 被永久占住（qwen3-vl:8b 实测 6.2 GB），
 *   退出应用也不释放，用户会认为「关了软件还吃显存」。
 *   所以这里用「短 TTL + 周期续期」：
 *     应用开着 → 模型常驻（不冷加载 → 不弹窗）
 *     应用关掉 → 最多一个 TTL（默认 30 分钟）后 Ollama 自己卸载
 *
 * 为什么不做「用完就卸」：
 *   卸载 = 下次提问又冷加载 = 黑窗口又回来了。用户要的正是「别再闪」。
 *
 * 失败处理：连续失败 maxMisses 次就放弃续期（引擎多半已经退出，
 *   继续打只是浪费），并把状态如实报给界面。
 */
'use strict';

const DEFAULTS = {
  intervalMs: 10 * 60 * 1000,  // 每 10 分钟续一次
  keepAlive: '30m',             // 每次续期给的 TTL，必须 > intervalMs
  maxMisses: 3,                 // 连续失败几次就放弃
  maxTimeoutMs: 15000           // 单次续期的超时
};

/* 归一化配置：只认正数，非法值一律回落默认值。
 * （relayBase / engines.json 都踩过「配置里的非法值一路带进运行时」的坑。） */
function normalize(raw){
  const r = (raw && typeof raw === 'object') ? raw : {};
  const num = (k, def) => {
    const v = Number(r[k]);
    return (isFinite(v) && v > 0) ? v : def;
  };
  const ka = String(r.keepAlive || DEFAULTS.keepAlive);
  return {
    intervalMs: num('intervalMs', DEFAULTS.intervalMs),
    keepAlive: /^-?\d+[smhd]?$/.test(ka) ? ka : DEFAULTS.keepAlive,
    maxMisses: num('maxMisses', DEFAULTS.maxMisses),
    maxTimeoutMs: num('maxTimeoutMs', DEFAULTS.maxTimeoutMs)
  };
}

/* 一个「保活器」。
 * ping(model, keepAlive) → Promise<{ok:boolean, ...}>   必填
 * unload(model)          → Promise<void>                 可选（切模型时卸掉旧的）
 * resident(model)        → Promise<boolean>              可选（判断模型是否已在显存里）
 * log(...)               → 可选
 *
 * resident 的作用很关键：续期请求只有「模型已在显存里」时才安全。
 * 对一个没驻留的模型发空 prompt 请求，等于**冷加载**它 →
 * 触发 GPU 探测 → 弹黑窗口（实测冷加载 = 6 个曾可见窗口）。
 * 所以先问一句「在不在」：在 → 只续期（26ms，0 窗口）；不在 → 才真的加载。 */
function createKeeper(opts){
  const o = normalize(opts);
  const ping = (opts && typeof opts.ping === 'function') ? opts.ping : null;
  const unload = (opts && typeof opts.unload === 'function') ? opts.unload : null;
  const resident = (opts && typeof opts.resident === 'function') ? opts.resident : null;
  const log = (opts && typeof opts.log === 'function') ? opts.log : function(){};

  let model = '';
  let timer = null;
  let fails = 0;
  let lastOkAt = 0;
  let nextAt = 0;
  let stopped = true;

  async function pingOnce(force){
    if(!ping || !model) return false;
    /* force：无视「连续失败已达上限」的放弃状态，重新试一次。
     *   场景：引擎被用户重新拉起来了，之前那些失败就不该算数
     *   （发送前的兜底会带 force 过来）。 */
    if(force) fails = 0;
    try{
      /* 已在显存里才发续期请求；对没驻留的模型发 = 冷加载 = 会弹黑窗口。
       * 查不到驻留状态（resident 没注入 / 请求失败）时一律当作「不在」，
       * 宁可多加载一次，也不要在不该加载的时候加载。 */
      if(resident){
        let inMem = false;
        try{ inMem = !!(await resident(model)); }
        catch(e){ inMem = false; }
        if(!inMem){
          log('[engine] keepalive ' + model + ' 不在显存，先加载再续期');
          const r = await ping(model, o.keepAlive);
          if(r && r.ok){ fails = 0; lastOkAt = Date.now(); return true; }
          fails++;
          log('[engine] keepalive 失败 ' + model + '（连续 ' + fails + ' 次）');
          return false;
        }
      }
      const r = await ping(model, o.keepAlive);
      if(r && r.ok){
        fails = 0;
        lastOkAt = Date.now();
        return true;
      }
    }catch(e){ /* 续期失败不是错误，记数就好 */ }
    fails++;
    log('[engine] keepalive 失败 ' + model + '（连续 ' + fails + ' 次）');
    return false;
  }

  function start(){
    if(!ping) return false;
    if(timer) return true;
    stopped = false;
    nextAt = Date.now() + o.intervalMs;
    timer = setInterval(() => {
      pingOnce().then(ok => {
        nextAt = Date.now() + o.intervalMs;
        if(!ok && fails >= o.maxMisses){
          log('[engine] keepalive 放弃：连续失败 ' + fails + ' 次');
          stop();
        }
      });
    }, o.intervalMs);
    if(timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  function stop(){
    if(timer){ clearInterval(timer); timer = null; }
    stopped = true;
    nextAt = 0;
    return true;
  }

  /* 记住「要保活哪个模型」。
   * 换模型时把旧的卸掉——不然两个模型一起占显存（实测 /api/ps 会同时列出两个，
   * qwen3-vl:8b + qwen2.5:3b 合计 8.4 GB），这是很容易被忽略的显存泄漏。
   * 卸载失败不致命（旧模型到 TTL 自然过期），所以只记不抛。
   *
   * ⚠ 登记即保活：setModel 之后自动 start()。
   *   语义上「把模型登记进保活器」就等于「从现在起保活它」——
   *   如果只登记不启动，模型会在一个 TTL 后被卸载，而界面上还显示「已登记」，
   *   实际早就没保活了（实测 running=false 就是这么来的：
   *   前端换模型时走的是 engines:keepalive-ping，不带 force，没触发 start）。 */
  function setModel(next){
    const m = String(next || '').trim();
    if(!m) return false;
    if(m === model){ start(); return true; }   // 同一个模型：确保保活着就行
    const old = model;
    model = m;
    fails = 0;
    if(old && unload){
      Promise.resolve(unload(old)).catch(() => {});
    }
    log('[engine] keepalive 目标 ' + (old ? old + ' → ' : '') + m);
    start();
    return true;
  }

  function status(){
    return {
      model, running: !!timer, fails, lastOkAt, nextAt,
      intervalMs: o.intervalMs, keepAlive: o.keepAlive
    };
  }

  return {
    start, stop, setModel, pingOnce, status,
    get model(){ return model; },
    get running(){ return !!timer; }
  };
}

module.exports = { createKeeper, DEFAULTS, normalize };
