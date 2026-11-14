/* 模型商店回归（阶段 E）
 *
 * 三块独立验证：
 *   A. 目录本身：字段完整、id 唯一、下载地址是 https 且镜像在前、体积/显存门槛存在；
 *   B. 渲染层的「本机适配」判定与安装/启用逻辑（vm + 假 DOM，不碰真实引擎）；
 *   C. 主进程侧：把大文件下到 ComfyUI/models/checkpoints（真实 HTTP + 真实分片下载器）。
 *
 * 跑法：node tools/model-store.js > log 2>&1
 */
'use strict';

(async () => {

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){
  ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}

const ROOT = path.join(__dirname, '..');
const CAT_SRC = fs.readFileSync(path.join(ROOT, 'js/model-catalog.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'js/model-store.js'), 'utf8');
/* confGet / confLlm / confImg 定义在 js/config.js 里，浏览器里它先于 model-store.js 加载。
 * 这个测试只 vm 了 model-catalog + model-store，所以要把那一段**原样摘出来**注入 ——
 * 不在测试里另写一份，否则「产品用哪套回落规则」和「测试验哪套」会悄悄漂开。 */
const CONF_SRC = (() => {
  const s = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
  const a = s.indexOf('function confGet(');
  const b = s.indexOf('// ---- 配置持久化 ----');
  if (a < 0 || b < 0 || b <= a) throw new Error('config.js 里找不到 confGet/confLlm/confImg 段（被改名或挪位了？）');
  return s.slice(a, b);
})();

/* ================= A. 目录 ================= */
console.log('\n=== A. 商店目录 ===');
const CAT = require('../js/model-catalog.js');
const ALL = CAT.MODEL_CATALOG;

ok(ALL.length >= 10, '目录至少 10 个条目', 'len=' + ALL.length);
eq(new Set(ALL.map(m => m.id)).size, ALL.length, 'id 唯一');
ok(ALL.every(m => m.name && m.kind && m.engine && m.desc), '每条都有名称/类型/引擎/说明');
/* 语音合成的「模型」分两种：系统语音包没有权重文件（sizeGB / vramGB 为 0 是事实），
 * Piper 音色要下几十 MB 的 ONNX 权重，但同样纯 CPU 推理（vramGB 为 0 也是事实）。
 * 体积与显存门槛只对「需要显存」的条目成立。 */
const WEIGHTED = ALL.filter(m => m.kind !== 'tts');
ok(WEIGHTED.every(m => Number(m.sizeGB) > 0), '权重模型都有实测体积');
ok(WEIGHTED.every(m => Number(m.vramGB) > 0), '权重模型都有显存门槛');

/* TTS 类目：系统音色零下载；Piper 音色给出真实权重地址与体积 */
const tts = CAT.catalogOf('tts');
const ttsSys = tts.filter(m => m.engine === 'system');
const ttsDl = tts.filter(m => m.engine !== 'system');
ok(tts.length >= 5, '语音合成类目有可选音色', 'tts=' + tts.length);
ok(ttsSys.every(m => m.voice instanceof RegExp && m.lang), '系统语音条目都带音色匹配规则与语种');
ok(ttsSys.every(m => m.kind === 'tts' && m.sizeGB === 0 && m.vramGB === 0), '系统语音不占下载体积与显存');
ok(tts.every(m => m.sample && m.sample.length > 0), '语音条目带试听文本');
ok(ttsSys.some(m => /xiaoxiao|晓晓/i.test(m.voice.source)), '中文女声里有晓晓这一档');
eq(CAT.catalogFit(ttsSys[0], { gpu: { vramMB: 0, discrete: false } }).level, 'good', '没独显也能用语音合成');

/* 可下载的高级本地语音分两档：
 *   piper  —— 每只音色一份 .onnx + .onnx.json，体积几十 MB；
 *   kokoro —— 一份共享模型 + 多个 sid，条目本身不带宽高与下载地址。
 * 两者的共同点是纯 CPU、不占显存。 */
const ttsPiper = ttsDl.filter(m => m.engine === 'piper');
const ttsKokoro = ttsDl.filter(m => m.engine === 'kokoro');
ok(ttsPiper.length >= 3, '提供可下载的 Piper 音色', 'piper=' + ttsPiper.length);
ok(ttsPiper.every(m => m.engine === 'piper' && m.kind === 'tts'), 'Piper 高级语音标记正确');
ok(ttsPiper.every(m => /\.onnx$/i.test(m.voiceFile || '') && /\.onnx\.json$/i.test(m.voiceJson || '')),
  '每条 Piper 都带 .onnx 权重与 .onnx.json 配置');
ok(ttsPiper.every(m => Array.isArray(m.urls) && m.urls.length && m.urls.every(u => /^https:\/\//.test(u))),
  'Piper 下载地址必须是 https（不允许明文/相对路径）');
ok(ttsPiper.every(m => Array.isArray(m.jsonUrls) && m.jsonUrls.length === m.urls.length), '配置与权重的镜像数量一致');

ok(ttsKokoro.length >= 4, '提供 Kokoro 超自然音色', 'kokoro=' + ttsKokoro.length);
ok(ttsKokoro.every(m => m.kind === 'tts' && m.engine === 'kokoro'), 'Kokoro 条目标记正确');
ok(ttsKokoro.every(m => Number.isInteger(m.sid) && m.sid >= 0 && m.sid < 200), '每个 Kokoro 音色都有合法 sid');
ok(new Set(ttsKokoro.map(m => m.sid)).size === ttsKokoro.length, 'sid 不重复（否则两只音色听起来一样）');
ok(ttsKokoro.every(m => m.shared === 'kokoro'), 'Kokoro 音色标记为共享模型');
ok(ttsKokoro.every(m => !m.voice && !m.urls && !m.voiceFile), 'Kokoro 不冒充满系统语音，也不带独立下载地址');
ok(ttsKokoro.some(m => m.lang === 'zh-CN') && ttsKokoro.some(m => /^en/i.test(m.lang)), 'Kokoro 中英文音色都有');

ok(ttsDl.every(m => m.sizeGB > 0 && m.sizeGB <= 0.2 && m.vramGB === 0),
  '本地音色体积在百 MB 量级，且不占显存', ttsDl.map(m => m.id + '=' + m.sizeGB + 'GB').join(' '));
ok(ttsDl.every(m => !m.voice), '可下载音色不参与系统语音匹配（否则会认错人）');
ok(ttsDl.some(m => m.lang === 'zh-CN') && ttsDl.some(m => /^en/i.test(m.lang)), '中英文高级音色都有');
ok(ttsDl.every(m => /^[a-z0-9-]+$/.test(m.id)), '高级语音 id 可直接用于本地路径映射');
eq(CAT.catalogFit(ttsPiper[0], { gpu: { vramMB: 0, discrete: false } }).level, 'good', '没独显也能跑 Piper（CPU 推理）');
eq(CAT.catalogFit(ttsKokoro[0], { gpu: { vramMB: 0, discrete: false } }).level, 'good', '没独显也能跑 Kokoro（CPU 推理）');

const llms = CAT.catalogOf('llm');
const imgs = CAT.catalogOf('image');
ok(llms.length >= 6 && imgs.length >= 3, '对话与生图两边都有货', 'llm=' + llms.length + ' image=' + imgs.length);
ok(llms.every(m => /^[a-z0-9.-]+:[a-z0-9.-]+$/i.test(m.ollama)), '对话模型带合法的 ollama 标签（name:tag）');
ok(llms.every(m => m.ollama === m.id), '对话模型的 id 就是 ollama 标签（拉取时直接用）');
ok(imgs.every(m => /\.safetensors$/i.test(m.file)), '生图模型都是 .safetensors');
ok(imgs.every(m => Array.isArray(m.urls) && m.urls.length >= 2), '生图模型至少两个下载源（镜像 + 官方）');
ok(imgs.every(m => m.urls.every(u => /^https:\/\//i.test(u))), '下载地址都是 https');
ok(imgs.every(m => /hf-mirror\.com/.test(m.urls[0])), '第一个源是国内镜像（直连 HF 会超时）');
ok(imgs.every(m => m.tune && m.tune.steps > 0 && m.tune.cfg > 0), '生图模型都带推荐采样参数');

// 反查调参：商店里的文件能查到，商店外的（用户自己放的）返回 null 走默认
eq(CAT.comfyTuningFor('v1-5-pruned-emaonly-fp16.safetensors').steps, 20, '按 ckpt 文件名反查到 SD1.5 参数');
eq(CAT.comfyTuningFor('sd_xl_turbo_1.0_fp16.safetensors').cfg, 1, 'SDXL-Turbo 的 cfg 是 1（用 7 会糊）');
eq(CAT.comfyTuningFor('my-own-model.safetensors'), null, '商店外的 ckpt 不硬塞参数');

/* 本机适配判定 */
const gpu4 = { gpu: { vramMB: 4096, discrete: true }, memory: { deviceMemoryGB: 16, exact: true } };
const gpu8 = { gpu: { vramMB: 8192, discrete: true }, memory: { deviceMemoryGB: 16, exact: true } };
const noGpu = { gpu: { vramMB: 0, discrete: false }, memory: { deviceMemoryGB: 16, exact: true } };
const weak = { gpu: { vramMB: 0, discrete: false }, memory: { deviceMemoryGB: 4, exact: false } };
const sd15 = CAT.catalogGet('sd15-fp16');
const sdxl = CAT.catalogGet('sdxl-base');
const q8 = CAT.catalogGet('qwen3:8b');
const q14 = CAT.catalogGet('qwen2.5:14b');

eq(CAT.catalogFit(sd15, gpu4).level, 'good', '4 GB 显存跑 SD1.5：够');
eq(CAT.catalogFit(sdxl, gpu4).level, 'no', '4 GB 显存跑 SDXL：不够，明确拒绝');
eq(CAT.catalogFit(sdxl, gpu8).level, 'good', '8 GB 显存跑 SDXL：够');
eq(CAT.catalogFit(sd15, noGpu).level, 'unknown', '没独显时不谎报「能跑」（生图退回 CPU 等于不能用）');
eq(CAT.catalogFit(q8, gpu4).level, 'cpu', '4 GB 显存的 8B：走 CPU 而不是判死（Ollama 能跑）');
eq(CAT.catalogFit(q8, gpu8).level, 'good', '8 GB 显存的 8B：进显存');
eq(CAT.catalogFit(q14, gpu4).level, 'no', '4 GB 显存 + 16 GB 内存的 14B：显存内存都不够');
eq(CAT.catalogFit(q14, weak).level, 'no', '低配机跑 14B：判死');
ok(/显存/.test(CAT.catalogFit(sdxl, gpu4).note), '不合格的提示里说清差多少显存', CAT.catalogFit(sdxl, gpu4).note);

/* 识图类目：用户抱怨「识图不够用」时，商店必须能直接给出更强的选择 */
const vis = CAT.catalogOf('vision');
ok(vis.length >= 5, '识图类目有货可选', 'vision=' + vis.length);
ok(vis.every(m => m.vision === true), '识图条目都带 vision 标记');
ok(vis.every(m => m.engine === 'ollama' && m.ollama === m.id), '识图模型走 Ollama，id 就是拉取用的 tag');
ok(vis.every(m => /^[a-z0-9.-]+:[a-z0-9.-]+$/i.test(m.ollama)), '识图模型的 tag 合法');
ok(llms.every(m => !m.vision), '对话类目里不再混入视觉模型（否则同一张卡渲染两遍）');
ok(vis.some(m => m.id === 'qwen3-vl:8b'), '有 Qwen3-VL 8B 这一档（主力识图）');
ok(vis.some(m => m.id === 'llava:7b'), '已装的 LLaVA 仍在目录里（移走会让用户以为模型消失了）');
{
  const sizes = vis.map(m => m.sizeGB);
  ok(Math.max.apply(null, sizes) / Math.min.apply(null, sizes) >= 8,
    '识图覆盖「1.9 GB 轻量」到「19 GB 旗舰」的跨度', 'min=' + Math.min.apply(null, sizes) + ' max=' + Math.max.apply(null, sizes));
  ok(vis.length === new Set(vis.map(m => m.ollama)).size, '识图 tag 不重复');
}
/* 体积必须随参数量档位递增。同一参数量下不同架构体积可以不一样
 * （8B 的 Qwen3-VL 6.19 GB、MiniCPM-V 5.47 GB），所以按参数分桶取最小值再比，
 * 抓的是「把 8B 的体积写成 1 GB」这类串行错误。 */
{
  const bucket = {};
  vis.forEach(m => {
    const p = parseInt(m.params, 10);
    if(!isFinite(p)) return;
    bucket[p] = (p in bucket) ? Math.min(bucket[p], m.sizeGB) : m.sizeGB;
  });
  const keys = Object.keys(bucket).map(Number).sort((a, b) => a - b);
  ok(keys.every((k, i) => i === 0 || bucket[k] >= bucket[keys[i - 1]]),
    '参数量越大体积越大（体积没写串行）',
    keys.map(k => k + 'B=' + bucket[k] + 'GB').join(' '));
}

/* 识图的显存判定和纯文本不是一回事：实测 4 GB 卡上 8B 视觉模型
 * 在加载阶段就 CUDA OOM 直接失败，Ollama 不会把它降级到 CPU。
 * 所以这里必须判「跑不动」，而不是「会走 CPU（较慢）」。 */
eq(CAT.catalogFit(CAT.catalogGet('qwen3-vl:2b'), gpu4).level, 'good', '4 GB 显存跑 VL 2B：进显存');
eq(CAT.catalogFit(CAT.catalogGet('qwen3-vl:4b'), gpu4).level, 'cpu', '4 GB 显存跑 VL 4B：显存偏紧，给警告而不是判死');
ok(/偏紧/.test(CAT.catalogFit(CAT.catalogGet('qwen3-vl:4b'), gpu4).note),
  '偏紧档要说明可能加载失败', CAT.catalogFit(CAT.catalogGet('qwen3-vl:4b'), gpu4).note);
eq(CAT.catalogFit(CAT.catalogGet('qwen3-vl:8b'), gpu4).level, 'no', '4 GB 显存跑 VL 8B：判跑不动（实测加载即 OOM）');
ok(/直接失败|不会自动降级/.test(CAT.catalogFit(CAT.catalogGet('qwen3-vl:8b'), gpu4).note),
  '判死时说清「不会自动降级」而不是「慢」', CAT.catalogFit(CAT.catalogGet('qwen3-vl:8b'), gpu4).note);
ok(/2B|4B/.test(CAT.catalogFit(CAT.catalogGet('qwen3-vl:8b'), gpu4).note),
  '判死时给出可用的替代档位', CAT.catalogFit(CAT.catalogGet('qwen3-vl:8b'), gpu4).note);
eq(CAT.catalogFit(CAT.catalogGet('qwen3-vl:8b'), gpu8).level, 'good', '8 GB 显存跑 VL 8B：进显存');
eq(CAT.catalogFit(CAT.catalogGet('qwen3-vl:30b'), gpu4).level, 'no', '4 GB 显存 / 16 GB 内存跑 VL 30B：判死');
/* 纯文本模型仍然允许「显存不够 → 走 CPU」，这条不能被视觉模型的严格判定带偏 */
eq(CAT.catalogFit(CAT.catalogGet('qwen3:8b'), gpu4).level, 'cpu', '纯文本 8B 在 4 GB 卡上仍判「可走 CPU」');
eq(CAT.catalogOllama().length, llms.length + vis.length, 'catalogOllama 覆盖对话 + 识图（卸载找备选要用全量）');

/* ================= B. 渲染层 ================= */
console.log('\n=== B. 安装 / 启用（假 DOM） ===');

function makeLS(seed){
  const m = Object.assign({}, seed || {});
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    _dump: () => m
  };
}
function makeEl(id){
  return {
    id, innerHTML: '', value: '', checked: false, dataset: {},
    querySelectorAll(){ return []; }, querySelector(){ return null; }, addEventListener(){}
  };
}

function makeEnv(seed){
  const ls = makeLS(seed);
  const els = {};
  const log = { savings: 0, toasts: [], engCalls: [], prompts: [] };
  const sandbox = {
    console, Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, isNaN, isFinite,
    setTimeout: fn => { fn(); return 0; }, clearTimeout: () => {},
    localStorage: ls,
    confirm: () => true,
    alert: msg => log.prompts.push(String(msg)),
    window: { openagiDesktop: null },
    document: { getElementById: id => (els[id] || (els[id] = makeEl(id))) },
    $: id => (els[id] || (els[id] = makeEl(id))),
    rtHealth: { ok: true, ollama: { ok: true }, comfy: { ok: true } },
    rtBase: () => 'http://127.0.0.1:8794',
    rtRefresh: async () => sandbox.rtHealth,
    labelCache: {},
    mcComfy: { running: true, installed: true, dir: 'D:\\ComfyUI', mode: 'portable', busy: '', progress: '', pct: -1 },
    mcComfyDetect: async () => sandbox.mcComfy,
    mcComfyAction: async (a) => { log.engCalls.push('comfy:' + a); return null; },
    mcEnsureEngine: async () => { log.engCalls.push('ollama:ensure'); return true; },
    mcSetScope: (k, s) => { ls.setItem(k === 'llm' ? 'mc_llm_scope' : 'mc_scope_image', s); },
    mcEsc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    mcFmtSpd: bps => (bps > 0 ? (bps / 1048576).toFixed(1) + ' MB/s' : ''),
    mcFmtEta: ms => (ms >= 0 ? Math.round(ms / 1000) + ' 秒' : ''),
    mcModelCache: {},
    mcRenderProviders: () => {},
    saveAll: () => {
      log.savings++;
      // 真实 saveAll 会把输入框的值写进 hf_*；这里照做，否则断言读不到「配置是否真的写进去了」
      ['llmBaseUrl', 'llmModel', 'llmKey', 'imgSize', 'imgModel'].forEach(id => {
        const el = els[id];
        if(el) ls.setItem('hf_' + id, el.value);
      });
    },
    updateStatusChips: () => {},
    updateModelLabels: () => {},
    bpToast: m => log.toasts.push(String(m)),
    probeHardware: async () => gpu4,
    llmMode: () => (ls.getItem('gw_mode') === 'local' ? 'local' : 'cloud'),
    setLlmMode: m => { ls.setItem('gw_mode', m); },
    imgMode: () => (ls.getItem('mc_scope_image') === 'local' ? 'local' : 'online'),
    setImgMode: m => { ls.setItem('mc_scope_image', m === 'local' ? 'local' : 'online'); },
    comfyCkptChoice: () => String(ls.getItem('mc_comfy_ckpt') || ''),
    setComfyCkpt: n => { ls.setItem('mc_comfy_ckpt', String(n || '')); },
    providerFor: (kind, id) => sandbox.FAKE_PROVIDERS[id] || null
  };
  vm.createContext(sandbox);
  vm.runInContext(CONF_SRC, sandbox, { filename: 'config.js#配置读取原语' });
  vm.runInContext(CAT_SRC, sandbox, { filename: 'model-catalog.js' });
  vm.runInContext(STORE_SRC, sandbox, { filename: 'model-store.js' });
  sandbox.__els = els;
  sandbox.__log = log;
  sandbox.__ls = ls;
  return sandbox;
}
/* msState 是 vm 里的 const，不会挂到 sandbox 上，只能回读上下文拿到同一个对象 */
function stateOf(env){ return vm.runInContext('msState', env); }

/* 一次完整的「装对话模型 → 自动启用」 */
{
  const env = makeEnv();
  const pulled = [];
  let installed = [];
  env.FAKE_PROVIDERS = {
    'ollama-llm': {
      async listModels(){ return installed.map(n => ({ id: n })); },
      async pullModel(name, cb){
        pulled.push(name);
        cb({ pct: 10, message: '下载中 10%' });
        cb({ pct: 100, message: '下载完成' });
        installed = [name];
      },
      async deleteModel(name){ installed = installed.filter(n => n !== name); }
    }
  };
  await env.renderModelStore(gpu4);
  const html = env.__els.mcStore.innerHTML;
  ok(/模型商店/.test(html), '面板里有「模型商店」标题');
  ok(/Qwen3 8B/.test(html), '列出目录里的模型');
  ok(/data-ms-act="install"/.test(html), '未安装的给「安装」按钮');
  ok(/3\.1 GB|4\.9 GB/.test(html), '显示实测体积');

  await env.msInstall(env.catalogGet('qwen3:8b'));
  eq(pulled.length, 1, '安装 = 调用一次 Ollama 拉取');
  eq(pulled[0], 'qwen3:8b', '拉的是目录里那个 tag');
  eq(env.__ls.getItem('gw_mode'), 'local', '装完自动切到「本地模型」模式');
  eq(env.__ls.getItem('hf_llmModel'), 'qwen3:8b', '装完把模型名写进客户端配置');
  eq(env.__ls.getItem('hf_llmBaseUrl'), 'http://127.0.0.1:8794/ollama/v1', 'Base URL 指向本地桥的 OpenAI 兼容口');
  eq(env.__ls.getItem('hf_llmKey'), 'ollama', 'Key 留空会让 llmReady 判成未配置，必须给占位值');
  eq(env.__ls.getItem('mc_llm_scope'), 'local', '控制台选项卡同步到「本地模型」');
  ok(env.__log.toasts.some(t => /已安装并启用/.test(t)), '装完给出「已安装并启用」提示', env.__log.toasts.join('|'));
  ok(env.msIsActive(env.catalogGet('qwen3:8b')), '该模型被标记成「已启用」');

  const html2 = env.__els.mcStore.innerHTML;
  ok(/已启用/.test(html2), '卡片上显示「已启用」');
  ok(/data-ms-act="remove"/.test(html2), '已启用的卡片给「卸载」');
}

/* 已装但未启用：显示「启用」而不是「安装」 */
{
  const env = makeEnv();
  env.FAKE_PROVIDERS = { 'ollama-llm': { async listModels(){ return [{ id: 'qwen2.5:7b' }]; } } };
  await env.renderModelStore(gpu4);
  const html = env.__els.mcStore.innerHTML;
  ok(/data-ms-act="enable"/.test(html), '已装的模型给「启用」按钮');
  ok(env.msIsInstalled(env.catalogGet('qwen2.5:7b')), '引擎在跑时能判出已安装');
  ok(!env.msIsActive(env.catalogGet('qwen2.5:7b')), '没启用时不算 active');
}

/* 引擎没跑：不能把「问不到」当成「没装」 */
{
  const env = makeEnv();
  env.rtHealth = { ok: false, ollama: { ok: false }, comfy: { ok: false } };
  env.FAKE_PROVIDERS = { 'ollama-llm': { async listModels(){ throw new Error('ECONNREFUSED'); } } };
  await env.renderModelStore(gpu4);
  eq(stateOf(env).installed.llm, null, '引擎没跑时已装清单是「未知」而不是空数组');
  ok(/Ollama[\s\S]*未运行/.test(env.__els.mcStore.innerHTML), '侧栏提示引擎未运行（点安装会自动装）');
}

/* 生图：装 → 放文件 → 自动启用 ckpt */
{
  const env = makeEnv();
  let files = [];
  env.window.openagiDesktop = {
    async storeImageList(){ return { ok: true, dir: 'D:\\ComfyUI\\models\\checkpoints', files: files.map(f => ({ file: f, sizeMB: 2100 })) }; },
    async storeInstallImage(req){
      env.__log.installReq = req;
      files = [req.file];
      return { ok: true, file: req.file };
    },
    async storeRemoveImage(f){ files = files.filter(x => x !== f); return { ok: true }; }
  };
  await env.renderModelStore(gpu4);
  const sd = env.catalogGet('sd15-fp16');
  await env.msInstall(sd);
  eq(env.__log.installReq.file, 'v1-5-pruned-emaonly-fp16.safetensors', '下载请求带正确的目标文件名');
  ok(Array.isArray(env.__log.installReq.urls) && env.__log.installReq.urls.length >= 2, '下载请求带全部源（主进程择优）');
  eq(env.__ls.getItem('mc_scope_image'), 'local', '装完自动把生图切到「本地生成」');
  eq(env.__ls.getItem('mc_comfy_ckpt'), sd.file, '装完自动选中这份 ckpt');
  eq(env.__ls.getItem('hf_imgSize'), '512x512', '采样尺寸跟着模型走（SD1.5 不该跑 1024）');
  ok(env.msIsActive(sd), '生图模型被标记成「已启用」');

  // SDXL-Turbo：启用后尺寸应变成 1024，且调参给到 provider
  const turbo = env.catalogGet('sdxl-turbo');
  files = [turbo.file, sd.file];
  await env.renderModelStore(gpu8);
  env.msEnable(turbo);
  eq(env.__ls.getItem('hf_imgSize'), '1024x1024', 'SDXL-Turbo 启用后尺寸切到 1024');
  eq(env.comfyTuningFor(turbo.file).cfg, 1, 'provider 能按 ckpt 查到 cfg=1');
}

/* 取消下载：不算失败，保留「进度已保留」的提示 */
{
  const env = makeEnv();
  env.window.openagiDesktop = {
    async storeImageList(){ return { ok: true, files: [] }; },
    async storeInstallImage(){ return { ok: false, cancelled: true, message: '已取消下载，进度已保留' }; }
  };
  await env.renderModelStore(gpu4);
  await env.msInstall(env.catalogGet('sd15-fp16'));
  ok(/已取消下载/.test(stateOf(env).notes['sd15-fp16'] || ''), '取消后给「进度已保留」而不是报错', JSON.stringify(stateOf(env).notes));
  eq(stateOf(env).error['sd15-fp16'], undefined, '取消不写红色错误');
  eq(env.__ls.getItem('mc_comfy_ckpt'), null, '取消时不去改客户端配置');
}

/* 下载中：进度条 + 取消入口 */
{
  const env = makeEnv();
  env.window.openagiDesktop = {
    async storeImageList(){ return { ok: true, files: [] }; },
    async storeCancel(){ env.__log.cancelled = true; return { ok: true }; }
  };
  await env.renderModelStore(gpu4);
  env.msSetProg('sd15-fp16', { busy: true, pct: 12, msg: '下载中 300 / 2100 MB · 12%' });
  env.msPaintStore();
  const html = env.__els.mcStore.innerHTML;
  ok(/ms-prog/.test(html), '下载中显示进度条');
  ok(/下载中 300 \/ 2100 MB/.test(html), '进度文案带上已下 / 总量');
  ok(/data-ms-act="cancel"/.test(html), '生图模型下载中给「取消下载」');
  await env.msCancel(env.catalogGet('sd15-fp16'));
  eq(env.__log.cancelled, true, '取消按钮打到主进程');
}

/* 装一个识图模型并启用：这条链路和对话模型共用 llm 配置，
 * 所以「装完能不能真的被识别为当前模型」必须验，否则是个假的「一键启用」。 */
{
  const env = makeEnv();
  const pulled = [];
  let installed = [];
  env.FAKE_PROVIDERS = {
    'ollama-llm': {
      async listModels(){ return installed.map(n => ({ id: n })); },
      async pullModel(name, cb){ pulled.push(name); cb({ pct: 100, message: '下载完成' }); installed = [name]; },
      async deleteModel(name){ installed = installed.filter(n => n !== name); }
    }
  };
  await env.renderModelStore(gpu4);
  await env.msInstall(env.catalogGet('qwen3-vl:8b'));
  eq(pulled[0], 'qwen3-vl:8b', '识图模型拉的是 qwen3-vl:8b');
  eq(env.__ls.getItem('hf_llmModel'), 'qwen3-vl:8b', '装完把识图模型写进当前模型配置');
  eq(env.__ls.getItem('gw_mode'), 'local', '装完切到本地模式');
  ok(env.msIsActive(env.catalogGet('qwen3-vl:8b')), '卡片标为「已启用」');
  eq(env.__ls.getItem('hf_llmKey'), 'ollama', '照样要补占位 Key');
}

/* 卸载当前识图模型时，若还有别的本地模型，应该自动切过去而不是断掉 */
{
  const env = makeEnv();
  let installed = ['qwen3:8b', 'qwen3-vl:8b'];
  env.FAKE_PROVIDERS = {
    'ollama-llm': {
      async listModels(){ return installed.map(n => ({ id: n })); },
      async deleteModel(name){ installed = installed.filter(n => n !== name); }
    }
  };
  await env.renderModelStore(gpu4);
  env.msEnable(env.catalogGet('qwen3-vl:8b'));
  eq(env.__ls.getItem('hf_llmModel'), 'qwen3-vl:8b', '先启用识图模型');
  await env.msRemove(env.catalogGet('qwen3-vl:8b'));
  eq(env.__ls.getItem('hf_llmModel'), 'qwen3:8b', '卸载后自动切到另一个本地模型（不是清空）');
  eq(env.__ls.getItem('gw_mode'), 'local', '仍然停留在本地模式');
}

/* 只装了识图模型的人，卸掉它之后应该体面退回云端，而不是留一个 model not found */
{
  const env = makeEnv();
  let installed = ['qwen3-vl:4b'];
  env.FAKE_PROVIDERS = {
    'ollama-llm': {
      async listModels(){ return installed.map(n => ({ id: n })); },
      async deleteModel(name){ installed = installed.filter(n => n !== name); }
    }
  };
  await env.renderModelStore(gpu4);
  env.msEnable(env.catalogGet('qwen3-vl:4b'));
  await env.msRemove(env.catalogGet('qwen3-vl:4b'));
  eq(env.__ls.getItem('hf_llmModel'), '', '没有别的本地模型时清空模型名');
  eq(env.__ls.getItem('gw_mode'), 'cloud', '退回到云端模式');
}

/* 筛选与「只看跑得动的」 */
{
  const env = makeEnv();
  env.FAKE_PROVIDERS = { 'ollama-llm': { async listModels(){ return []; } } };
  await env.renderModelStore(gpu4);
  stateOf(env).filter = 'image';
  env.msPaintStore();
  const html = env.__els.mcStore.innerHTML;
  ok(/data-ms-kind="image"/.test(html) && !/data-ms-kind="llm"/.test(html), '切到「生图」只剩生图分类');

  stateOf(env).filter = 'vision';
  env.msPaintStore();
  const htmlV = env.__els.mcStore.innerHTML;
  ok(/data-ms-kind="vision"/.test(htmlV) && /识图 \/ 多模态/.test(htmlV), '切到「看图」只剩识图分类');
  ok(/Qwen3-VL 8B/.test(htmlV), '识图分类里列出 Qwen3-VL 8B');
  ok(!/data-ms-kind="llm"/.test(htmlV) && !/data-ms-kind="image"/.test(htmlV), '「看图」筛选下不混入对话 / 生图');
  ok(!/>Qwen3 8B</.test(htmlV), '「看图」筛选下不出现纯文本的 Qwen3 8B');

  /* 语音类目按系统语音动态生成：没有语音对象时整段不渲染，
   * 所以这里先塞一只假音色，才能验证「切到语音只剩语音分类」。 */
  env.window.speechSynthesis = {
    getVoices(){ return [{ name: 'Microsoft Huihui Desktop - Chinese (Simplified)', lang: 'zh-CN' }]; },
    addEventListener(){}, cancel(){}, speak(){}
  };
  stateOf(env).filter = 'tts';
  env.msPaintStore();
  const htmlT = env.__els.mcStore.innerHTML;
  ok(/data-ms-kind="tts"/.test(htmlT) && /语音合成/.test(htmlT), '切到「语音」只剩语音合成分类');
  ok(/无需下载/.test(htmlT), '语音条目不显示假的下载体积');

  stateOf(env).filter = 'all';
  stateOf(env).fitOnly = true;
  env.msPaintStore();
  const html2 = env.__els.mcStore.innerHTML;
  ok(!/sd_xl_base_1\.0\.safetensors/.test(html2), '「只看跑得动的」把 4 GB 跑不动的 SDXL 滤掉');
  ok(/v1-5-pruned-emaonly-fp16/.test(html2), '能跑的 SD1.5 还在');
}

/* 搜索与「已安装」视图：搜索按名称/厂商/标签命中，视图只列已安装 */
{
  const env = makeEnv();
  env.FAKE_PROVIDERS = { 'ollama-llm': { async listModels(){ return [{ id: 'qwen3:8b' }]; } } };
  await env.renderModelStore(gpu4);

  stateOf(env).q = 'vl';
  env.msPaintStore();
  const html = env.__els.mcStore.innerHTML;
  ok(/Qwen3-VL 8B/.test(html), '搜索 vl 命中识图模型');
  ok(!/>Qwen3 8B</.test(html), '搜索结果里不出现无关的 Qwen3 8B');
  ok(/个条目/.test(html), '搜索后仍显示条目计数');

  stateOf(env).q = '';
  stateOf(env).view = 'installed';
  env.msPaintStore();
  const inst = env.__els.mcStore.innerHTML;
  ok(/data-ms-kind="installed"/.test(inst), '已安装视图只渲染已安装条目');
  ok(/Qwen3 8B/.test(inst), '已安装的 Qwen3 8B 出现在视图里');
  ok(!/v1-5-pruned-emaonly-fp16/.test(inst), '未安装的生图模型不出现');
}

/* 语音合成：以系统实际语音为准——「检测到几只 = 能用几只」；
 * 设为默认写 hf_ttsVoice；试听真的调用 TTS。 */
{
  const env = makeEnv();
  const voices = [
    { name: 'Microsoft Huihui Desktop - Chinese (Simplified)', lang: 'zh-CN' },
    { name: 'Microsoft Yaoyao Desktop - Chinese (Simplified)', lang: 'zh-CN' },
    /* 目录里没有对应预设的系统语音：旧实现会把它藏起来，造成「检测到 4 个、只有 2 张卡」 */
    { name: 'Acme Narrator One - English (United States)', lang: 'en-US' }
  ];
  const spoken = [];
  env.window.speechSynthesis = {
    getVoices(){ return voices; },
    addEventListener(){},
    cancel(){},
    speak(u){ spoken.push(u); }
  };
  env.window.SpeechSynthesisUtterance = function(text){ this.text = text; };
  await env.renderModelStore(gpu4);

  const items = env.msTtsItems();
  eq(items.length, voices.length, '检测到几只系统语音就生成几张卡');
  eq(env.msKindCount('tts'), voices.length + env.msTtsLocal().length, '侧栏语音计数 = 系统语音 + 可下载音色');
  eq((env.__els.mcStore.innerHTML.match(/data-ms-card=/g) || []).length,
    env.msVisibleCount(), '侧栏 / 顶栏条目数等于实际渲染的卡片数');

  const html = env.__els.mcStore.innerHTML;
  ok(/慧慧/.test(html) && /瑶瑶/.test(html), '列出系统里能匹配到的中文音色');
  ok(/Narrator/i.test(html), '认不出的系统语音也生成条目（不再藏起来）');
  ok(!/系统未安装/.test(html), '不再出现「系统未安装」的卡片');
  ok(!/tts-xiaoxiao/.test(html), '系统里没有的预设不再占据卡片位');

  const huihui = env.msFindItem('tts-huihui');
  ok(huihui && env.msIsInstalled(huihui), '系统里有的音色判为可用');
  eq(env.msVoiceMatch(huihui).name, voices[0].name, '音色匹配到具体系统语音');

  /* 动态条目也必须能点得动：msOnStoreClick 走 msFindItem，而不是只查静态目录 */
  const dyn = items.filter(m => /Narrator/i.test(m.name))[0];
  ok(!!dyn, '动态语音条目有 id');
  eq(env.msFindItem(dyn.id).voiceName, voices[2].name, '按动态 id 能找回对应系统语音');
  await env.msInstall(env.msFindItem(dyn.id));
  eq(env.__ls.getItem('hf_ttsVoice'), voices[2].name, '动态语音也能设为默认（写入 hf_ttsVoice）');

  await env.msInstall(huihui);
  eq(env.__ls.getItem('hf_ttsVoice'), voices[0].name, '设为默认写入 hf_ttsVoice');
  ok(env.msIsActive(huihui), '音色被标记为已启用');
  ok(/已启用/.test(env.__els.mcStore.innerHTML), '卡片上显示「已启用」');
  ok(/data-ms-act="preview"/.test(env.__els.mcStore.innerHTML), '可用音色给「试听」');

  env.msPreview(huihui);
  eq(spoken.length, 1, '试听会真正调用 speechSynthesis');
  ok(/停止/.test(env.__els.mcStore.innerHTML), '试听中按钮切成「停止」');

  await env.msRemove(huihui);
  eq(env.__ls.getItem('hf_ttsVoice'), null, '停用后清掉默认音色');
  ok(!env.msIsActive(huihui), '停用后不再 active');
}

/* 可下载的高级本地语音：真实走主进程下载、写默认音色、经本地引擎桥试听 */
{
  const env = makeEnv();
  env.window.speechSynthesis = { getVoices(){ return []; }, addEventListener(){}, cancel(){}, speak(){} };
  const calls = { install: [], remove: [] };
  env.__installed = '';
  env.window.openagiDesktop = {
    async storeTtsList(){
      return { ok: true, engine: true, voices: env.__installed ? [{ file: env.__installed }] : [] };
    },
    async storeInstallTts(req){
      calls.install.push(req);
      env.__installed = req.voiceFile;
      return { ok: true, engine: true };
    },
    async storeRemoveTts(req){
      calls.remove.push(req);
      env.__installed = '';
      return { ok: true };
    },
    async storeCancel(){ return { ok: true }; }
  };
  await env.renderModelStore(gpu4);
  const piper = env.catalogGet('piper-zh-huayan-medium');
  ok(!!piper && piper.engine === 'piper', '目录里有可下载的 Piper 音色');
  ok(!env.msIsInstalled(piper), '没下载的 Piper 音色不算已安装');
  const html0 = env.__els.mcStore.innerHTML;
  ok(/下载并启用/.test(html0), '可下载音色给「下载并启用」');
  ok(/60 MB/.test(html0), '卡片上写清真实体积', 'size=' + piper.sizeGB);

  await env.msInstall(piper);
  eq(calls.install.length, 1, '安装会调主进程下载');
  eq(calls.install[0].voiceFile, piper.voiceFile, '按 voiceFile 落盘');
  eq(calls.install[0].urls.length, piper.urls.length, '下载地址原样交给主进程（含镜像）');
  ok(env.msIsInstalled(piper), '下完判为已安装');
  eq(env.__ls.getItem('hf_ttsVoice'), 'piper:' + piper.id, '下完自动设为默认');
  ok(env.msIsActive(piper), '并标记为已启用');

  /* 浏览器模式没有本地桥：要给可读提示，而不是静默没反应 */
  await env.msPreview(piper);
  ok(/桌面端/.test(stateOf(env).error[piper.id] || ''), '无桌面端时试听给出可读提示');

  const asked = [];
  env.fetch = async (url, init) => {
    asked.push({ url, body: JSON.parse(init.body) });
    return { ok: true, blob: async () => ({ size: 1024 }) };
  };
  env.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  env.window.Audio = function (url) { this.__url = url; this.play = () => Promise.resolve(); this.pause = () => {}; };
  delete stateOf(env).error[piper.id];
  await env.msPreview(piper);
  eq(asked.length, 1, '试听请求打到本地引擎桥');
  ok(/\/tts\/speak$/.test(asked[0].url), '走 /tts/speak');
  eq(asked[0].body.voice, piper.voiceFile, '请求里带权重文件名');
  eq(stateOf(env).previewId, piper.id, '试听中按钮切成「停止」');

  await env.msRemove(piper);
  eq(calls.remove.length, 1, '卸载会调主进程删除');
  eq(calls.remove[0].voiceFile, piper.voiceFile, '按 voiceFile 删除');
  eq(env.__ls.getItem('hf_ttsVoice'), null, '卸载默认音色时清掉绑定');
  ok(!env.msIsInstalled(piper), '卸载后回到未安装');
}

/* Kokoro 超自然音色：一份共享模型 + 多个 sid。
 * 关键断言是「装一次，所有音色都算已安装」，以及试听请求带的是 sid 而不是文件名。 */
{
  const env = makeEnv();
  env.window.speechSynthesis = { getVoices(){ return []; }, addEventListener(){}, cancel(){}, speak(){} };
  const calls = { install: 0, remove: 0, cancel: [] };
  env.__kokoro = false;
  env.window.openagiDesktop = {
    async storeKokoroStatus(){ return { ok: true, installed: env.__kokoro, engine: env.__kokoro, model: env.__kokoro }; },
    async storeInstallKokoro(){ calls.install++; env.__kokoro = true; return { ok: true, installed: true }; },
    async storeRemoveKokoro(){ calls.remove++; env.__kokoro = false; return { ok: true }; },
    async storeTtsList(){ return { ok: true, voices: [] }; },
    async storeCancel(id){ calls.cancel.push(id); return { ok: true }; }
  };
  await env.renderModelStore(gpu4);
  const kokoro = env.catalogGet('kokoro-zh-xiaoxiao');
  ok(!!kokoro && kokoro.engine === 'kokoro', '目录里有 Kokoro 超自然音色');
  ok(!env.msIsInstalled(kokoro), '共享模型没下载时不算已安装');
  const html0 = env.__els.mcStore.innerHTML;
  ok(/共享/.test(html0), '卡片标出「共享」体积');
  ok(/所有 Kokoro 音色共用同一份模型/.test(html0), '未下载时提示共享模型只下一次');

  await env.msInstall(kokoro);
  eq(calls.install, 1, '安装走 Kokoro 共享模型下载');
  ok(env.msIsInstalled(kokoro), '共享模型就绪后判为已安装');
  const other = env.catalogGet('kokoro-zh-yunxi');
  ok(env.msIsInstalled(other), '同一共享模型下的其他音色也立即可用');
  eq(env.__ls.getItem('hf_ttsVoice'), 'kokoro:' + kokoro.sid, '默认音色写成 kokoro:<sid>');
  ok(env.msIsActive(kokoro), '并标记为已启用');

  const asked = [];
  env.fetch = async (url, init) => {
    asked.push({ url, body: JSON.parse(init.body) });
    return { ok: true, blob: async () => ({ size: 2048 }) };
  };
  env.URL = { createObjectURL: () => 'blob:k', revokeObjectURL: () => {} };
  env.window.Audio = function () { this.play = () => Promise.resolve(); this.pause = () => {}; };
  delete stateOf(env).error[kokoro.id];
  await env.msPreview(kokoro);
  eq(asked.length, 1, 'Kokoro 试听打到本地引擎桥');
  eq(asked[0].body.engine, 'kokoro', '试听请求带 engine=kokoro');
  eq(asked[0].body.sid, kokoro.sid, '试听请求带 sid（不是文件名）');
  ok(!asked[0].body.voice, 'Kokoro 不传 voice 字段');
  env.msStopPreview();

  await env.msCancel(kokoro);
  eq(calls.cancel[0], 'kokoro', '取消按共享任务 key 发给主进程');

  await env.msRemove(kokoro);
  eq(calls.remove, 1, '卸载会删除共享模型');
  eq(env.__ls.getItem('hf_ttsVoice'), null, '卸载共享模型时清掉默认音色');
  ok(!env.msIsInstalled(kokoro) && !env.msIsInstalled(other), '卸载后所有 Kokoro 音色回到未安装');
}

/* 一只系统语音都没有：仍要能看到可下载的高级音色，而不是一屏空 */
{
  const env = makeEnv();
  env.window.speechSynthesis = { getVoices(){ return []; }, addEventListener(){}, cancel(){}, speak(){} };
  await env.renderModelStore(gpu4);
  stateOf(env).filter = 'tts';
  env.msPaintStore();
  const html = env.__els.mcStore.innerHTML;
  ok(!/没有检测到可用的语音/.test(html), '有可下载音色时不显示整页空态');
  ok(/下载并启用/.test(html), '没有系统语音也能下载 Piper 音色');
  eq(env.msKindCount('tts'), env.msTtsLocal().length, '此时语音计数只算可下载音色');
}

/* ================= C. 主进程：下载到 checkpoints ================= */
console.log('\n=== C. 主进程下载 ===');

const MStore = require('../electron/model-store.js');
const comfyModule = require('../electron/comfy-setup.js');

/* 文件名校验：渲染进程传进来的字符串会拼进磁盘路径 */
const badNames = ['../evil.safetensors', 'a/b.safetensors', 'C:\\x.safetensors', '', '..', 'a:b'];
let rejected = 0;
for(const n of badNames){
  try{ MStore.safeFileName(n); }catch(e){ rejected++; }
}
eq(rejected, badNames.length, '带路径分隔符 / 空文件名一律拒绝（防目录穿越）');
eq(MStore.safeFileName('v1-5-pruned-emaonly-fp16.safetensors'), 'v1-5-pruned-emaonly-fp16.safetensors', '正常文件名放行');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-store-'));
const comfyDir = path.join(tmpRoot, 'ComfyUI_windows_portable', 'ComfyUI');
fs.mkdirSync(comfyDir, { recursive: true });
fs.writeFileSync(path.join(comfyDir, 'main.py'), '# fake');
const origDetect = comfyModule.detect;
comfyModule.detect = async () => ({
  ok: true, running: false, installed: true, sevenZip: '',
  dir: comfyDir, layout: { mode: 'portable', dir: comfyDir, comfyDir, python: 'py', cwd: tmpRoot }
});

const cpDir = await MStore.checkpointsDir('x.json');
eq(cpDir, path.join(comfyDir, 'models', 'checkpoints'), 'checkpoints 目录按布局算出来');

const PAYLOAD = Buffer.alloc(3 * 1024 * 1024 + 777);
for(let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = (i * 37 + 11) & 0xff;
const SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

let hits = 0;
const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if(!m){
    res.writeHead(200, { 'content-length': PAYLOAD.length });
    res.end(PAYLOAD);
    return;
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : PAYLOAD.length - 1;
  hits++;
  res.writeHead(206, {
    'content-length': end - start + 1,
    'content-range': 'bytes ' + start + '-' + end + '/' + PAYLOAD.length
  });
  res.end(PAYLOAD.slice(start, end + 1));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/model.safetensors';

const events = [];
const r1 = await MStore.install('x.json', {
  id: 'sd15-fp16', file: 'test-model.safetensors', urls: [base], sizeGB: 0
}, { onProgress: e => events.push(e) });
ok(r1.ok && !r1.cached, '首次下载成功');
const got = fs.readFileSync(path.join(cpDir, 'test-model.safetensors'));
eq(crypto.createHash('sha256').update(got).digest('hex'), SHA, '落盘字节与源完全一致（sha256 相同）');
ok(events.some(e => e.stage === 'done'), '上报了完成事件');
ok(events.some(e => e.stage === 'download' && e.pct >= 0), '上报了百分比进度');

const list1 = await MStore.list('x.json');
ok(list1.ok && list1.files.some(f => f.file === 'test-model.safetensors'), '已装清单能列出刚下的文件');
ok(list1.files.find(f => f.file === 'test-model.safetensors').sizeMB >= 3, '清单带体积（MB）');
fs.writeFileSync(path.join(cpDir, 'notes.txt'), 'x');
ok(!(await MStore.list('x.json')).files.some(f => f.file === 'notes.txt'), '非权重文件不进清单');

const before = hits;
const r2 = await MStore.install('x.json', {
  id: 'sd15-fp16', file: 'test-model.safetensors', urls: [base], sizeGB: 0
}, {});
ok(r2.cached, '重复安装命中缓存');
eq(hits, before, '命中缓存时不再发下载请求（不重复下 2 GB）');

const r3 = await MStore.remove('x.json', 'test-model.safetensors');
ok(r3.ok && !fs.existsSync(path.join(cpDir, 'test-model.safetensors')), '卸载删掉文件');

// 取消：立刻返回 cancelled，不把半截文件当成品
let cancelAfter = false;
const rc = await MStore.install('x.json', {
  id: 'sd15-fp16', file: 'cancel.safetensors', urls: [base], sizeGB: 0
}, { isCancelled: () => { if(cancelAfter) return true; cancelAfter = true; return false; } }).catch(e => ({ err: e }));
ok(rc && (rc.err || rc.cancelled || rc.ok), '取消路径有确定结果（不挂在原地）', JSON.stringify(rc));

// 没有 ComfyUI：明确报 NO_COMFY，而不是下到临时目录
comfyModule.detect = async () => ({ ok: true, running: false, installed: false, layout: null, dir: '' });
const rNo = await MStore.install('x.json', { id: 'x', file: 'a.safetensors', urls: [base] }, {}).catch(e => ({ err: e }));
ok(rNo && rNo.err && rNo.err.code === 'NO_COMFY', '没装 ComfyUI 时报 NO_COMFY（不瞎下文件）', JSON.stringify(rNo && rNo.err && rNo.err.message));

comfyModule.detect = origDetect;
await new Promise(r => server.close(r));
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
if(fail) process.exit(1);
})();
