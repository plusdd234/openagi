/* 模型控制台「本地引擎」面板的进度展示与取消路径（js/models-console.js）
 *
 * 背景：安装包 ~1.6 GB，下载几十分钟到几小时。原实现只在 busy==='安装中' 时接收进度，
 * 刷新页面后进度全部丢失、按钮又变回「安装引擎」；界面也只有一个百分比，
 * 用户看不出速度、也判断不了是不是卡死。
 *
 * 本测试用假 DOM + 假桌面桥验证：
 *   1) 进度消息能更新百分比 / 速度 / 剩余时间 / 源
 *   2) 打开面板时能从主进程同步回进行中的安装
 *   3) 主进程已不在装时必须清掉「安装中…」，不能永远挂着
 *   4) 取消按钮存在且走 ollamaCancelInstall
 *   5) 取消不算失败：不 alert、保留「可续传」提示
 *   6) busy 为空时收到进度也要接住（刷新后的场景）
 *
 * node tools/models-console.js > log 2>&1
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){ ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

/* ---------- 极简 DOM ---------- */
function makeEl(id){
  const el = {
    id, innerHTML: '', dataset: {}, disabled: false, textContent: '',
    _handlers: [],
    classList: { _s: new Set(), add(c){ this._s.add(c); }, remove(c){ this._s.delete(c); }, contains(c){ return this._s.has(c); } },
    addEventListener(ev, fn){ if(ev === 'click') this._handlers.push(fn); },
    click(){ this._handlers.forEach(fn => fn({})); },
    querySelectorAll(sel){
      // 只支持 [data-mc-eng="x"] 与 [data-mc-list] 两类选择器
      const m = /\[data-mc-eng="([^"]+)"\]/.exec(sel);
      if(m){
        const re = new RegExp('data-mc-eng="' + m[1] + '"');
        if(!re.test(el.innerHTML)) return [];
        const self = this;
        return [{
          dataset: { mcEng: m[1] },
          addEventListener(){},
          focus(){},
          get innerHTML(){ return self.innerHTML; }
        }];
      }
      return [];
    },
    querySelector(){ return null; },
    appendChild(){}, insertBefore(){}, insertAdjacentHTML(){},
    remove(){},
    parentNode: { querySelector(){ return null; }, insertBefore(){}, },
    style: {}
  };
  return el;
}

const els = {};
function $(id){ return els[id] || (els[id] = makeEl(id)); }

/* ---------- 假环境 ---------- */
const alerts = [];
let cancelCalls = 0;
let lockHandlers = [];
let autoHandlers = [];   // 引擎自动启动状态推送的订阅者
function makeEnv(desktopOverrides){
  const desktop = Object.assign({
    ollamaDetect: async () => ({ installed: false, exe: '' }),
    ollamaInstall: async () => ({ ok: true, installed: true }),
    ollamaLaunch: async () => ({ ok: true }),
    ollamaStatus: async () => ({ installing: false, progress: null }),
    ollamaCancelInstall: async () => { cancelCalls++; return { ok: true }; },
    onOllamaProgress: cb => { lockHandlers.push(cb); }
  }, desktopOverrides || {});

  const sandbox = {
    console,
    window: { openagiDesktop: desktop },
    document: { getElementById: id => $(id), createElement: () => makeEl('tmp') },
    localStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
    alert: m => { alerts.push(String(m)); },
    setTimeout, clearTimeout, isFinite, Number, String, Math, Date, JSON,
    fetch: async () => { throw new TypeError('offline'); },
    AbortController: class { constructor(){ this.signal = {}; } abort(){} },
    // 被测文件依赖的全局
    rtHealth: { ok: false, ollama: { ok: false }, comfy: { ok: false } },
    // 引擎真的起来了才把 rtHealth 翻绿：默认 false，否则前面的「未运行」用例全被带跑
    __rtUp: false,
    rtRefresh: async () => {
      if(sandbox.__rtUp){
        sandbox.rtHealth.ollama.ok = true;
        sandbox.rtHealth.comfy.ok = true;
      }
      return true;
    },
    probeHardware: async () => ({ probedAt: Date.now(), gpu: {}, cpu: {}, recommend: {} }),
    describeHardware: () => 'CPU/GPU',
    PROVIDER_KINDS: ['llm'],
    providersOfKind: () => [],
    providerFor: () => null,
    registerProvider: () => {},
    deskSvg: () => '<svg/>',
    mcModelCache: {}
  };
  sandbox.$ = $;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'models-console.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'models-console.js' });
  return sandbox;
}

/* 从 innerHTML 里抠进度条百分比与文案 */
function progressOf(){
  const html = $('mcEng').innerHTML;
  const w = /<i style="width:(\d+(?:\.\d+)?)%"><\/i>/.exec(html);
  const span = /<div class="mc-eng-progress">.*?<span>(.*?)<\/span>/s.exec(html);
  return { width: w ? Number(w[1]) : null, text: span ? span[1] : '' };
}
function hasBtn(action){
  return new RegExp('data-mc-eng="' + action + '"').test($('mcEng').innerHTML);
}
function metaOf(){
  const m = /<div class="mc-eng-meta">(.*?)<\/div>/s.exec($('mcEng').innerHTML);
  if(!m) return [];
  return Array.from(m[1].matchAll(/<span>(.*?)<\/span>/g)).map(x => x[1]);
}

(async () => {
  console.log('== 1. 初始渲染：未安装、提示 1.6 GB、有安装按钮 ==');
  {
    const env = makeEnv();
    await env.renderModelsConsole();
    const html = $('mcEng').innerHTML;
    ok(/未安装/.test(html), '状态显示「未安装」');
    ok(/1\.6 GB/.test(html), '文案说明约 1.6 GB（不是旧的 700 MB）', (html.match(/约[^）]*\)?/) || [''])[0]);
    ok(hasBtn('install'), '有「安装引擎」按钮');
    ok(/断点续传/.test(html), '文案提到支持断点续传');
  }

  console.log('\n== 2. 进度消息：百分比 / 速度 / 剩余时间 / 源 ==');
  {
    const env = makeEnv();
    await env.renderModelsConsole();
    const emit = lockHandlers[lockHandlers.length - 1];
    ok(typeof emit === 'function', '已订阅主进程进度');
    // 主进程上报的是安装总进度（下载占前 50%），这里 percent 是下载百分比
    // 主进程的 pct 就是整条进度（下载段占 0-48），界面直接显示更不会倒退
    emit({ stage: 'download', pct: 19, percent: 40, speed: 966000, etaMs: 900000,
      source: 'https://gh-proxy.com/https://github.com/ollama/ollama/releases/download/x/OllamaSetup.exe',
      message: '正在下载 Ollama 安装包 640 / 1585 MB · 40% · 943 KB/s · 剩余 15 分 0 秒' });
    const p = progressOf();
    eq(p.width, 19, '进度条直接用主进程的 pct（不二次折算）');
    ok(/正在下载 Ollama 安装包/.test(p.text), '文案透传', p.text);
    const meta = metaOf();
    ok(meta.some(x => /943 KB\/s/.test(x)), '显示实时速度', meta.join(' | '));
    ok(meta.some(x => /剩余 15 分/.test(x)), '显示剩余时间', meta.join(' | '));
    ok(meta.some(x => /gh-proxy\.com/.test(x)), '显示当前下载源（域名而非整条 URL）', meta.join(' | '));
    ok(hasBtn('cancel'), '下载中按钮变成「取消下载」');
  }

  console.log('\n== 3. 刷新页面后能接回进行中的安装 ==');
  {
    const env = makeEnv({
      ollamaStatus: async () => ({
        installing: true,
        progress: { pct: 28, message: '正在下载 Ollama 安装包 900 / 1585 MB · 56% · 2.1 MB/s · 剩余 5 分 30 秒', percent: 56, speed: 2200000, etaMs: 330000, source: 'https://ghfast.top/x' }
      })
    });
    await env.renderModelsConsole();
    const p = progressOf();
    eq(p.width, 28, '恢复出正确百分比（用侧车 pct=28）');
    ok(/900 \/ 1585 MB/.test(p.text), '恢复出正确文案', p.text);
    ok(hasBtn('cancel'), '恢复后按钮仍是「取消下载」而不是「安装引擎」');
    const meta = metaOf();
    ok(meta.some(x => /2\.1 MB\/s/.test(x)), '恢复出速度', meta.join(' | '));
  }

  console.log('\n== 4. 主进程已不在装：不能永远显示「安装中」 ==');
  {
    const env = makeEnv({ ollamaStatus: async () => ({ installing: false, progress: null }) });
    await env.renderModelsConsole();
    ok(!/安装中/.test($('mcEng').innerHTML), '没有残留「安装中」');
    ok(hasBtn('install'), '按钮回到「安装引擎」');
  }

  console.log('\n== 5. busy 为空时收到进度也要接住（刷新后的实际顺序） ==');
  {
    const env = makeEnv();
    await env.renderModelsConsole();
    const emit = lockHandlers[lockHandlers.length - 1];
    // 模拟：面板刚打开，主进程立刻推了一条（旧实现会因为 busy !== '安装中' 直接 return）
    emit({ stage: 'download', pct: 30, percent: 62, speed: 1500000, etaMs: 60000, message: '正在下载 980 / 1585 MB' });
    const p = progressOf();
    eq(p.width, 30, '进度被接住（用主进程的 pct=30）');
    ok(/980 \/ 1585 MB/.test(p.text), '文案被接住', p.text);
  }

  console.log('\n== 5b. 进度条不许倒退（下载 48% → 校验 50% → 安装 55%） ==');
  {
    const env = makeEnv();
    await env.renderModelsConsole();
    const emit = lockHandlers[lockHandlers.length - 1];
    const seq = [
      { stage: 'download', pct: 48, message: '正在下载 Ollama 安装包 1585 / 1585 MB · 100%' },
      { stage: 'verify', pct: 50, message: '正在校验安装包完整性…' },
      { stage: 'install', pct: 55, message: '正在静默安装 Ollama（约 1-3 分钟）…' },
      { stage: 'install', pct: 85, message: '安装完成，正在启动引擎…' },
      { stage: 'done', pct: 100, message: 'Ollama 引擎就绪' }
    ];
    let prev = -1;
    let monotonic = true;
    let bad = '';
    seq.forEach(x => {
      emit(x);
      const w = progressOf().width;
      if(w < prev){ monotonic = false; bad = '从 ' + prev + '% 掉到 ' + w + '%（stage=' + x.stage + '）'; }
      prev = w;
    });
    ok(monotonic, '进度单调不减', bad);
    eq(prev, 100, '最终 100%');
  }

  console.log('\n== 6. 取消：调主进程、不弹错误、提示可续传 ==');
  {
    alerts.length = 0;
    cancelCalls = 0;
    let resolveInstall;
    const env = makeEnv({
      ollamaInstall: () => new Promise(r => { resolveInstall = r; }),
      ollamaStatus: async () => ({ installing: true, progress: { message: '下载中', pct: 9 } })
    });
    await env.renderModelsConsole();
    ok(hasBtn('cancel'), '下载中显示「取消下载」');
    // 点取消 → 调 ollamaCancelInstall
    const btn = $('mcEng').querySelectorAll('[data-mc-eng="cancel"]')[0];
    ok(!!btn, '取到取消按钮');
    await env.mcEngAction('cancel');
    eq(cancelCalls, 1, '调用了 ollamaCancelInstall');
    eq(alerts.length, 0, '没有弹错误框');
  }

  console.log('\n== 7. 取消后安装返回 cancelled：不 alert、提示续传 ==');
  {
    alerts.length = 0;
    const env = makeEnv({
      ollamaInstall: async () => ({ ok: false, cancelled: true, message: '已取消下载，进度已保留' })
    });
    await env.renderModelsConsole();
    let r;
    try{
      r = await env.mcInstallEngine();
    }catch(e){
      ok(false, '取消不该抛错', e && e.message);
    }
    eq(r, false, '返回 false（未就绪）');
    eq(alerts.length, 0, '取消不弹「操作失败」');
    ok(/续传/.test($('mcEng').innerHTML), '界面提示进度已保留、可续传', $('mcEng').innerHTML.match(/已取消[^<]*/) || '');
  }

  console.log('\n== 8. 真正的失败仍然要弹错误 ==');
  {
    alerts.length = 0;
    const env = makeEnv({
      ollamaInstall: async () => { throw new Error('所有下载源都不可用（GitHub 直连：连接超时）'); }
    });
    await env.renderModelsConsole();
    let threw = false;
    try{ await env.mcInstallEngine(); }catch(e){ threw = true; }
    ok(threw, '失败向上抛（由 mcEngAction 统一弹框）');
    // 模拟点击路径
    await env.mcEngAction('install').catch(() => {});
    ok(alerts.some(a => /所有下载源都不可用/.test(a)) || threw, '失败原因可读', alerts.join(' | '));
  }

  console.log('\n== 9. 各阶段进度条取值 ==');
  {
    const env = makeEnv();
    await env.renderModelsConsole();
    const emit = lockHandlers[lockHandlers.length - 1];
    emit({ stage: 'download', pct: 48, percent: 100, message: '正在下载 Ollama 安装包（校验通过）' });
    eq(progressOf().width, 48, '下载完成 → 48%');
    emit({ stage: 'verify', pct: 50, message: '正在校验安装包完整性…' });
    eq(progressOf().width, 50, '校验阶段 50%');
    emit({ stage: 'install', pct: 55, message: '正在静默安装 Ollama（约 1-3 分钟）…' });
    eq(progressOf().width, 55, '安装阶段 55%');
    emit({ stage: 'done', pct: 100, message: 'Ollama 引擎就绪' });
    ok(!/取消下载/.test($('mcEng').innerHTML), '完成后不再显示取消按钮');
  }

  console.log('\n== 10. 引擎自动启动：开关存在、默认值正确、勾上即刻启动 ==');
  {
    const calls = [];
    const env = makeEnv({
      comfyDetect: async () => ({ ok: true, running: false, installed: true, dir: 'C:/c', tar: 'C:/tar.exe', canInstall: true }),
      enginesConfig: async () => ({ ollama: true, comfy: true, warm: false }),
      enginesSetConfig: async patch => {
        calls.push(['set', patch]);
        return Object.assign({ ollama: true, comfy: true, warm: false }, patch || {});
      },
      enginesAutoStart: async () => { calls.push(['auto']); return { ollama: 'ready', comfy: 'starting' }; },
      onEngineStatus: cb => { autoHandlers.push(cb); }
    });
    await env.renderModelsConsole();
    const engHtml = $('mcEng').innerHTML;
    const comfyHtml = $('mcComfy').innerHTML;
    ok(/data-eng-auto="ollama"/.test(engHtml), 'Ollama 卡片有「启动时自动启动」开关');
    ok(/data-eng-auto="warm"/.test(engHtml), 'Ollama 卡片有「预热当前模型」开关');
    ok(/data-eng-auto="comfy"/.test(comfyHtml), 'ComfyUI 卡片有开关');
    ok(/data-eng-auto="ollama" checked/.test(engHtml), '默认勾上（读的是主进程配置，不是写死的）');
    ok(/data-eng-auto="comfy" checked/.test(comfyHtml), 'ComfyUI 默认也勾上');
    ok(!/data-eng-auto="warm" checked/.test(engHtml), '预热默认不勾（会跟 ComfyUI 抢显存）');

    await env.mcToggleEngAuto('comfy', false);
    ok(calls.some(c => c[0] === 'set' && c[1] && c[1].comfy === false), '取消勾选写进配置');
    ok(!calls.some(c => c[0] === 'auto'), '取消勾选不去启动（已在跑的不打断）');

    calls.length = 0;
    await env.mcToggleEngAuto('comfy', true);
    ok(calls.some(c => c[0] === 'set' && c[1].comfy === true), '勾上写进配置');
    ok(calls.some(c => c[0] === 'auto'), '勾上立刻启动一次，不必等下次开程序');
  }

  console.log('\n== 11. 自动启动的状态要进卡片（否则用户以为没反应） ==');
  {
    const env = makeEnv({
      comfyDetect: async () => ({ ok: true, running: false, installed: true, dir: 'C:/c', tar: 'C:/tar.exe', canInstall: true }),
      onEngineStatus: cb => { autoHandlers.push(cb); }
    });
    await env.renderModelsConsole();
    const cb = autoHandlers[autoHandlers.length - 1];
    ok(typeof cb === 'function', '已订阅主进程的引擎状态');

    cb({ ollama: 'starting', comfy: 'starting', ollamaNote: '正在启动 Ollama…', comfyNote: '正在启动 ComfyUI（首次加载 torch 约 100 秒）…' });
    await new Promise(r => setTimeout(r, 20));
    ok(/启动中/.test($('mcEng').innerHTML), 'Ollama 卡片显示「启动中」');
    ok(/启动中/.test($('mcComfy').innerHTML), 'ComfyUI 卡片显示「启动中」');
    ok(!/data-mc-comfy="launch"/.test($('mcComfy').innerHTML), '启动中不再给「启动引擎」按钮（点了只会撞「正在启动中」）');

    env.__rtUp = true;   // 引擎真的起来了：桥的探活这时才会翻绿
    cb({ ollama: 'ready', comfy: 'ready', ollamaNote: '', comfyNote: '' });
    await new Promise(r => setTimeout(r, 20));
    ok(/运行中/.test($('mcEng').innerHTML), '就绪后 Ollama 显示「运行中」');
    ok(/运行中/.test($('mcComfy').innerHTML), '就绪后 ComfyUI 显示「运行中」');
    ok(!/启动中/.test($('mcEng').innerHTML), '不再残留「启动中」');
  }

  console.log('\n== 12. 自动启动失败：原因留在卡片上 ==');
  {
    const env = makeEnv({
      comfyDetect: async () => ({ ok: true, running: false, installed: false, dir: '', tar: '', canInstall: true }),
      onEngineStatus: cb => { autoHandlers.push(cb); }
    });
    await env.renderModelsConsole();
    const cb = autoHandlers[autoHandlers.length - 1];
    cb({ ollama: 'failed', comfy: 'absent', ollamaNote: '启动超时（30 秒）：可稍后手动启动', comfyNote: '本机没有安装 ComfyUI' });
    await new Promise(r => setTimeout(r, 20));
    ok(/开机自动启动没成功/.test($('mcEng').innerHTML), 'Ollama 卡片显示失败提示');
    ok(/启动超时/.test($('mcEng').innerHTML), '把真正的原因写出来了', ($('mcEng').innerHTML.match(/启动超时[^<]*/) || [''])[0]);
    ok(!/开机自动启动没成功/.test($('mcComfy').innerHTML), '「没装 ComfyUI」不算失败提示（绝大多数机器都这样，别吓人）');
  }

  console.log('\n---------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
  if(fail) process.exit(1);
})().catch(e => {
  console.error('测试异常终止：', (e && e.stack) || e);
  process.exit(1);
});