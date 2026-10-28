/* 硬件探测模块（阶段 A）：WebGPU / CPU / 内存 / 磁盘
 * 供阶段 B 的模型控制台与阶段 D 的按硬件自动配置使用。
 * 探测只读、无副作用；结果在内存中缓存，可强制刷新。
 */
let HARDWARE_CACHE = null;

const GPU_VRAM_GUESS = [
  [/rtx\s*4090/i, 24 * 1024],
  [/rtx\s*4080/i, 16 * 1024],
  [/rtx\s*4070\s*ti\s*super/i, 16 * 1024],
  [/rtx\s*4070\s*super/i, 12 * 1024],
  [/rtx\s*4070\s*ti/i, 12 * 1024],
  [/rtx\s*4070/i, 12 * 1024],
  [/rtx\s*4060\s*ti/i, 16 * 1024],
  [/rtx\s*4060/i, 8 * 1024],
  [/rtx\s*3090\s*ti/i, 24 * 1024],
  [/rtx\s*3090/i, 24 * 1024],
  [/rtx\s*3080\s*ti/i, 12 * 1024],
  [/rtx\s*3080/i, 10 * 1024],
  [/rtx\s*3070\s*ti/i, 8 * 1024],
  [/rtx\s*3070/i, 8 * 1024],
  [/rtx\s*3060\s*ti/i, 8 * 1024],
  [/rtx\s*3060/i, 12 * 1024],
  [/rtx\s*3050/i, 8 * 1024],
  [/rtx\s*2080\s*ti/i, 11 * 1024],
  [/rtx\s*2080/i, 8 * 1024],
  [/rtx\s*2070\s*super/i, 8 * 1024],
  [/rtx\s*2070/i, 8 * 1024],
  [/rtx\s*2060\s*super/i, 8 * 1024],
  [/rtx\s*2060/i, 6 * 1024],
  [/gtx\s*1080\s*ti/i, 11 * 1024],
  [/gtx\s*1080/i, 8 * 1024],
  [/gtx\s*1070\s*ti/i, 8 * 1024],
  [/gtx\s*1070/i, 8 * 1024],
  [/gtx\s*1060/i, 6 * 1024],
  [/gtx\s*1660\s*ti/i, 6 * 1024],
  [/gtx\s*1660/i, 6 * 1024],
  [/gtx\s*1650/i, 4 * 1024],
  [/rx\s*7900\s*xtx/i, 24 * 1024],
  [/rx\s*7900\s*xt/i, 20 * 1024],
  [/rx\s*7900\s*gre/i, 16 * 1024],
  [/rx\s*7800\s*xt/i, 16 * 1024],
  [/rx\s*7700\s*xt/i, 12 * 1024],
  [/rx\s*7600/i, 8 * 1024],
  [/rx\s*6800\s*xt/i, 16 * 1024],
  [/rx\s*6800/i, 16 * 1024],
  [/rx\s*6700\s*xt/i, 12 * 1024],
  [/rx\s*6600/i, 8 * 1024]
];

function gpuVramGuess(name){
  if(!name) return null;
  const t = String(name).toLowerCase();
  for(const [re, mb] of GPU_VRAM_GUESS){
    if(re.test(t)) return mb;
  }
  const m = t.match(/(\d{1,2})\s*(?:gb|gib)\b/);
  if(m && +m[1] >= 2 && +m[1] <= 96) return +m[1] * 1024;
  return null;
}

/* 从 WebGL 的 renderer 字符串里抠出型号。
 * Windows 上形如 "ANGLE (NVIDIA, NVIDIA GeForce RTX 2050 Laptop GPU (0x000025A2) Direct3D11 vs_5_0 ps_5_0, D3D11)"，
 * 去掉 ANGLE 外壳与括号里的 PCI ID 就是可读型号。
 * 这条很重要的原因：WebGPU 的 adapter.info.description 在 Windows 上是空串，
 * 只靠它既认不出型号也算不出显存，最后就会误判成「无独立 GPU」。 */
function nameFromAngle(s){
  let t = String(s || '').trim();
  if(!t) return '';
  const m = /^ANGLE\s*\(([\s\S]*)\)\s*$/i.exec(t);
  if(m){
    t = m[1];
    t = t.replace(/^[^,]*,\s*/, '');        // 首段是厂商名（"NVIDIA, ..."），去掉
  }
  t = t.replace(/\(0x[0-9a-f]+\)/ig, '')
       .replace(/\b(Direct3D\d+|vs_\d+_\d+|ps_\d+_\d+|D3D\d+)\b/ig, '')
       .replace(/\s{2,}/g, ' ')
       .replace(/[,\s]+$/, '')
       .trim();
  return t;
}

/* 渲染进程视角的 GPU（WebGPU 优先，WebGL 兜底）。
 * 注意：这里拿到的**只是 Chromium 分配的那块卡**——双显卡机器上通常是核显，
 * 所以它只用于「有没有 WebGPU」「型号兜底」，不能当成「本机最强的卡」。 */
async function probeGPURenderer(){
  const out = { webgpu: false, vendor: '', name: '', glRenderer: '' };
  // WebGL 先取：型号字符串最完整，WebGPU 拿不到名字时靠它
  try{
    if(typeof document !== 'undefined'){
      const cv = document.createElement('canvas');
      const gl = cv.getContext('webgl2') || cv.getContext('webgl');
      if(gl){
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        out.glRenderer = String((ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '');
      }
    }
  }catch(e){/* 无 WebGL 不影响后面的判断 */}
  if(typeof navigator === 'undefined' || !navigator.gpu || typeof navigator.gpu.requestAdapter !== 'function') return out;
  try{
    // high-performance 让 Chromium 优先选独显（有的驱动会因此给出独显适配器）
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      || await navigator.gpu.requestAdapter();
    if(!adapter) return out;
    out.webgpu = true;
    if(adapter.info){
      out.vendor = String(adapter.info.vendor || '');
      out.name = String(adapter.info.description || adapter.info.device || '');
      if(adapter.info.fallback === true) out.software = true;
    }
    if(!out.name) out.name = nameFromAngle(out.glRenderer);
  }catch(e){
    out.error = String((e && e.message) || e);
  }
  return out;
}

function vendorKeyOf(raw){
  const t = String(raw || '').toLowerCase();
  if(/nvidia|geforce|quadro|rtx|gtx/.test(t)) return 'nvidia';
  if(/amd|radeon|firepro/.test(t)) return 'amd';
  if(/apple/.test(t)) return 'apple';
  if(/intel|arc|iris|uhd graphics|hd graphics/.test(t)) return 'intel';
  if(/microsoft|basic render|warp|swiftshader/.test(t)) return 'software';
  return 'unknown';
}

/* 型号名里的 ® / ™ / (TM) 会让字面正则漏匹配（"AMD Radeon(TM) Graphics"），先剥壳 */
function normGpuName(name){
  return String(name || '')
    .replace(/\((?:tm|r|c)\)/gi, ' ')
    .replace(/[®™©]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* 是否独立显卡：型号能判断就按型号，判断不了就按厂商兜底。
 * 与主进程 hardware-info.js 的同名判定保持一致——两边结论不一样时，
 * 面板显示的（独显）/（核显）和推荐档位会互相矛盾。 */
function isDiscreteGpu(vendor, name){
  const t = normGpuName(name);
  if(vendor === 'nvidia') return true;
  // APU 核显：Radeon Graphics / Radeon Vega 8 / Radeon 780M / Radeon R7
  if(vendor === 'amd') return !/\bradeon\s+(?:graphics|vega|r\d|(?:\d{3}m))\b/.test(t);
  if(vendor === 'intel') return /\barc\b/.test(t);
  return false;
}

async function probeGPU(){
  const [desk, web] = await Promise.all([
    (async () => {
      try{
        const d = window.openagiDesktop;
        if(d && typeof d.hardware === 'function') return await d.hardware();
      }catch(e){/* 网页版没有桌面桥，正常回落 */}
      return null;
    })(),
    probeGPURenderer()
  ]);

  /* 有桌面数据时，以「本机最强的卡」为准来判断能不能跑本地模型。
   * 本地引擎（Ollama / ComfyUI）是独立进程，直接用独显，
   * 不受「Chromium 把页面画在核显上」影响——这点以前判断错了，才会在独显机器上说没有独显。 */
  if(desk && desk.ok && Array.isArray(desk.adapters) && desk.adapters.length){
    const best = desk.best || {};
    let vramMB = best.vramMB != null ? best.vramMB : gpuVramGuess(best.name);
    const vendor = best.vendor && best.vendor !== 'unknown' ? best.vendor : vendorKeyOf(best.name);
    return {
      ok: true,
      webgpu: !!web.webgpu,
      vendor,
      name: best.name || nameFromAngle(web.glRenderer),
      vramMB,
      discrete: best.discrete != null ? !!best.discrete : isDiscreteGpu(vendor, best.name),
      adapters: desk.adapters.map(a => ({
        name: a.name, vendor: a.vendor, vramMB: a.vramMB, discrete: !!a.discrete, active: !!a.active
      })),
      rendererGpu: (web.name || nameFromAngle(web.glRenderer)),
      sysMemGB: desk.totalMemBytes ? Math.round(desk.totalMemBytes / 1073741824) : 0,
      source: 'desktop',
      reason: ''
    };
  }

  // 网页版 / 桌面桥不可用：只能看 Chromium 给的那块，结论会偏保守
  if(!web.webgpu && !web.glRenderer){
    return { ok: false, webgpu: false, vendor: '', name: '', vramMB: null, discrete: false,
      reason: web.error || '当前环境既没有 WebGPU 也没有 WebGL' };
  }
  const vendor = vendorKeyOf(web.vendor) !== 'unknown' ? vendorKeyOf(web.vendor) : vendorKeyOf(web.name);
  const name = web.name || nameFromAngle(web.glRenderer);
  const vramMB = gpuVramGuess(name);
  return {
    ok: true, webgpu: !!web.webgpu, vendor, name, vramMB,
    discrete: isDiscreteGpu(vendor, name),
    adapters: [],
    rendererGpu: name,
    source: 'renderer',
    reason: ''
  };
}

async function probeStorage(){
  if(typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.estimate !== 'function'){
    return { ok: false, quota: 0, usage: 0, available: 0 };
  }
  try{
    const est = await navigator.storage.estimate();
    const quota = est && est.quota ? est.quota : 0;
    const usage = est && est.usage ? est.usage : 0;
    return { ok: true, quota, usage, available: Math.max(0, quota - usage) };
  }catch(e){
    return { ok: false, quota: 0, usage: 0, available: 0 };
  }
}

/* LLM 建议：档位只按**显存**定，内存只用来补充「塞不下时还能不能 offload」。
 *
 * 早先用 max(显存, 内存×0.6) 定档：4 GB 显存 + 16 GB 内存算出 9.6 GB → 推荐 7~8B，
 * 却在同一句补「显存不够，会走 CPU 推理」，前后自相矛盾（实测就出现了）。
 * 显存才是决定「能不能正常速度跑」的东西，内存再大也只是跑得动的上限。 */
function recommendLLM(estMB, opts){
  const o = opts || {};
  const vramGB = o.vramGB || 0;
  const ramGB = o.ramGB || 0;
  /* 有显存就按显存定档；没显存（纯 CPU 推理）时内存才是唯一依据。
   * CPU 推理要留出系统占用，按 50% 估——不能因为「没有显存」就直接判「跑不动」，
   * 16 GB 内存跑 7B Q4 是完全可行的。 */
  const gb = vramGB > 0
    ? Math.max(vramGB, estMB / 1024)
    : Math.max(ramGB * 0.5, estMB / 1024);
  const tiers = [
    { min: 20, tier: 'high',    size: '30B',   text: '可流畅运行 30B 量化模型（如 Qwen2.5-32B）' },
    { min: 10, tier: 'mid',     size: '14B',   text: '推荐 13~14B 量化模型（如 Qwen2.5-14B）' },
    { min: 6,  tier: 'entry',   size: '7B',    text: '推荐 6~8B 量化模型（如 Qwen2.5-7B / Llama-3.1-8B）' },
    { min: 3,  tier: 'minimal', size: '3B',    text: '推荐 3~4B 量化模型（如 Qwen2.5-3B / Phi-3.5-mini）' },
    { min: 1.5,tier: 'minimal', size: '1.5B',  text: '推荐 1.5B 量化模型（如 Qwen2.5-1.5B）' }
  ];
  const pick = tiers.find(t => gb >= t.min);
  if(!pick) return { tier: 'none', quant: '', size: '', note: '显存/内存不足：建议继续用云端对话' };

  let note = pick.text;
  if(!vramGB){
    note += '（CPU 推理，较慢）';
  } else if(ramGB >= 12){
    // 显存放不下的更大模型可以 offload，但要提前说清代价，别让人以为能同样流畅
    const bigger = { '1.5B': '3~4B', '3B': '7~8B', '7B': '13~14B', '14B': '30B' }[pick.size];
    if(bigger) note += '；' + bigger + ' 也能 offload 到内存跑，速度会明显下降';
  }
  return { tier: pick.tier, quant: 'Q4_K_M', size: pick.size, note };
}

/* 生图建议：先看「有没有独显」，再看「显存够不够」——这两件事的结论完全不同，
 * 以前混成一句「无独立 GPU 或显存不足」，结果独显机器也被告知没有独显。 */
function recommendImage(estMB, gpu){
  const gb = estMB / 1024;
  const hasGpu = !!(gpu && gpu.ok);
  const discrete = !!(gpu && gpu.discrete);
  if(!hasGpu){
    return { tier: 'minimal', note: '没检测到可用显卡：本地生图会很慢，建议继续用云端生图', slow: true };
  }
  if(!discrete){
    return { tier: 'minimal', note: '只有核显（' + (gpu.name || '集成显卡') + '）：本地生图会很慢，建议继续用云端生图', slow: true };
  }
  if(!gpu.vramMB){
    return { tier: 'unknown', note: '独显 ' + (gpu.name || '') + '（显存未知，需 8 GB 以上才流畅）', slow: false };
  }
  if(gb >= 16) return { tier: 'high', note: '独显 ' + Math.round(gb) + ' GB：可跑 SDXL fp16 / Flux.1 dev fp8' };
  if(gb >= 8) return { tier: 'mid', note: '独显 ' + Math.round(gb) + ' GB：可跑 SDXL fp8 / SD1.5' };
  if(gb >= 5) return { tier: 'entry', note: '独显 ' + Math.round(gb) + ' GB：可跑 SD1.5 fp8，SDXL 会吃力', slow: true };
  // 4 GB 跑 SD1.5 512×512 是够的（这是最常见的入门卡），别一律劝去云端
  return { tier: 'minimal', note: '独显 ' + Math.round(gb) + ' GB：够跑 SD1.5（512×512），SDXL 基本跑不动，出大图建议走云端', slow: true };
}

async function probeHardware(force){
  if(HARDWARE_CACHE && !force) return HARDWARE_CACHE;
  const [gpu, disk] = await Promise.all([probeGPU(), probeStorage()]);
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 0;
  /* navigator.deviceMemory 在 Chromium 里被硬性截到 8 GB，8/16/32 GB 的机器全都显示 8。
   * 桌面端从主进程拿 os.totalmem() 才是真值；网页版只能标注「至少」。 */
  let ramGB = 0;
  let ramExact = false;
  if(gpu && gpu.sysMemGB){
    ramGB = gpu.sysMemGB;
    ramExact = true;
  } else if(typeof navigator !== 'undefined' && navigator.deviceMemory){
    ramGB = navigator.deviceMemory;
  }
  const vramMB = gpu && gpu.vramMB ? gpu.vramMB : 0;
  const estMB = vramMB || (ramGB ? Math.round(ramGB * 1024) : 0);
  HARDWARE_CACHE = {
    probedAt: Date.now(),
    gpu,
    cpu: { cores },
    memory: { deviceMemoryGB: ramGB, exact: ramExact },
    disk,
    estimateMB: estMB,
    recommend: {
      llm: recommendLLM(estMB, { vramGB: vramMB / 1024, ramGB }),
      image: recommendImage(estMB, gpu)
    }
  };
  return HARDWARE_CACHE;
}

function describeHardware(h){
  if(!h) return '未探测';
  const parts = [];
  const g = h.gpu || {};
  if(g.name){
    parts.push(g.name + (g.discrete ? '（独显）' : (g.ok ? '（核显）' : '')));
  } else if(!g.ok && g.reason){
    parts.push('显卡未识别');
  }
  if(g.vramMB) parts.push('显存约 ' + Math.round(g.vramMB / 1024) + ' GB');
  if(h.memory && h.memory.deviceMemoryGB){
    parts.push('内存 ' + h.memory.deviceMemoryGB + ' GB' + (h.memory.exact ? '' : ' 以上'));
  }
  if(h.cpu && h.cpu.cores) parts.push(h.cpu.cores + ' 核');
  if(h.disk && h.disk.available) parts.push('磁盘可用约 ' + Math.round(h.disk.available / 1024 / 1024 / 1024) + ' GB');
  return parts.join(' · ') || '无可描述信息';
}

/* 其它显卡（双显卡机器上把核显也列出来，避免「明明有独显却像没检测到」的错觉） */
function describeOtherGpus(h){
  const list = (h && h.gpu && h.gpu.adapters) || [];
  if(list.length < 2) return '';
  const best = (h.gpu.name || '').toLowerCase();
  const others = list.filter(a => String(a.name || '').toLowerCase() !== best)
    .map(a => String(a.name || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return others.length ? '另有：' + others.join('、') : '';
}
