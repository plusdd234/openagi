/* 真实硬件信息（显卡 / 显存 / 内存），只在主进程用。
 *
 * 为什么不交给渲染进程的 navigator.gpu：
 * ① Chromium 默认把 WebGL/WebGPU 分配给**核显**（省电策略），双显卡机器上永远只看得到 Intel/AMD 核显；
 * ② Windows 上 adapter.info.description / device 是**空字符串**，既认不出型号也算不出显存，
 *    最后只能落到「无独立 GPU」——独显机器被误判就是这么来的。
 * app.getGPUInfo('complete') 能列出全部适配器（含独显），Win32_VideoController 补型号与显存。
 */
'use strict';
const os = require('os');
const { app } = require('electron');
const { execFile } = require('child_process');

const GPU_VENDOR_OF = {
  0x10de: 'nvidia', 0x1002: 'amd', 0x1022: 'amd', 0x8086: 'intel',
  0x1414: 'microsoft', 0x15ad: 'vmware', 0x1af4: 'virtio', 0x1234: 'qemu'
};

/* 从型号名反推厂商：Win32_VideoController 的 Name 里一定有厂商字样 */
function gpuVendorOfName(name){
  const t = String(name || '').toLowerCase();
  if(/nvidia|geforce|quadro|rtx|gtx|tesla/.test(t)) return 'nvidia';
  if(/amd|radeon|firepro/.test(t)) return 'amd';
  if(/intel|arc|iris|uhd graphics|hd graphics/.test(t)) return 'intel';
  if(/microsoft|basic render|remote display/.test(t)) return 'microsoft';
  if(/vmware|virtualbox|parallels|qxl|virtio/.test(t)) return 'virtual';
  return 'unknown';
}

/* 型号名里夹着 ® / ™ / (TM) / (R) 这些商标符，正则按字面匹配会漏掉：
 * "AMD Radeon(TM) Graphics" 里 Radeon 和 Graphics 中间隔了个 (TM)，
 * 于是 /radeon\s*graphics/ 匹配不上，APU 被误判成独显。先剥壳再判。 */
function normGpuName(name){
  return String(name || '')
    .replace(/\((?:tm|r|c)\)/gi, ' ')
    .replace(/[®™©]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* 集显还是独显：能按型号判就按型号，否则按厂商兜底。
 * 兜底方向是「宁可当独显」——判错了顶多建议保守一点，
 * 判成核显却会让整台机器降级到 CPU 推理。 */
function gpuIsDiscrete(vendor, name){
  const t = normGpuName(name);
  if(vendor === 'nvidia') return true;
  // APU 核显的型号名：Radeon Graphics / Radeon Vega 8 / Radeon 780M / Radeon R7
  if(vendor === 'amd') return !/\bradeon\s+(?:graphics|vega|r\d|(?:\d{3}m))\b/.test(t);
  if(vendor === 'intel') return /\barc\b/.test(t);       // Arc A 系列是独显
  return false;
}

/* 从一堆适配器里挑「最该用来跑模型」的那块。
 * 排序是 discrete → 显存 → active：双显卡笔记本上 Chromium 的 active 是核显，
 * 若按 active 优先就会把独显排掉，等于白探测。
 * 软件渲染驱动（Microsoft Basic Render）不算真显卡，直接排除。 */
function pickBest(adapters){
  const usable = (adapters || []).filter(a => a && a.vendor !== 'microsoft');
  if(!usable.length) return null;
  const b = usable.slice().sort((x, y) =>
    (y.discrete ? 1 : 0) - (x.discrete ? 1 : 0) ||
    (y.vramMB || 0) - (x.vramMB || 0) ||
    (y.active ? 1 : 0) - (x.active ? 1 : 0)
  )[0];
  return { vendor: b.vendor, name: b.name, vramMB: b.vramMB, discrete: b.discrete };
}

/* Windows：Win32_VideoController 拿型号，注册表 qwMemorySize 拿真实显存。
 * AdapterRAM 是 uint32，>4 GB 的卡会溢出成错误值，所以优先 REG_QWORD。
 *
 * 输出用 NDJSON（一行一个 JSON），不要用 ConvertTo-Json 序列化整个数组：
 * PowerShell 5.1 对「单元素数组」会退化成对象，用 `,@($out)` 强转又会多包一层，
 * 解析端拿到的结构永远对不上（实测就是这样把型号全丢了的）。 */
function winVideoControllers(){
  return new Promise(resolve => {
    if(process.platform !== 'win32') return resolve([]);
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$base='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
      "$reg=@{}",
      "Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {",
      "  $p=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue",
      "  if($p.DriverDesc -and $p.'HardwareInformation.qwMemorySize'){ $reg[$p.DriverDesc]=[int64]$p.'HardwareInformation.qwMemorySize' }",
      "}",
      "Get-CimInstance Win32_VideoController | ForEach-Object {",
      "  $n=$_.Name",
      "  if($reg.ContainsKey($n)){ $ram=$reg[$n] } else { $ram=[int64]$_.AdapterRAM }",
      "  [PSCustomObject]@{ name=$n; vram=$ram } | ConvertTo-Json -Compress",
      "}"
    ].join('\n');
    let done = false;
    const finish = v => { if(!done){ done = true; resolve(v); } };
    try{
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 6000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
          if(!stdout) return finish([]);
          const out = [];
          String(stdout).split(/\r?\n/).forEach(line => {
            const t = line.trim();
            if(!t || t[0] !== '{') return;
            try{
              const j = JSON.parse(t);
              if(j && j.name) out.push({ name: String(j.name), vramBytes: Number(j.vram) || 0 });
            }catch(e){/* 单行坏掉不影响其他卡 */}
          });
          finish(out);
        });
    }catch(e){ finish([]); }
  });
}

/* 汇总：GPUInfo 给「有几块卡、vendorId/deviceId / active」，Win32 给「型号与显存」 */
async function probeHardwareMain(){
  const [gpuInfo, videos] = await Promise.all([
    app.getGPUInfo('complete').catch(() => null),
    winVideoControllers()
  ]);
  const list = ((gpuInfo && gpuInfo.gpuDevice) || []).map(d => ({
    vendorId: Number(d.vendorId) || 0,
    deviceId: Number(d.deviceId) || 0,
    vendor: GPU_VENDOR_OF[Number(d.vendorId) || 0] || 'unknown',
    name: '',
    vramMB: null,
    discrete: false,
    active: !!d.active
  }));

  /* 型号按厂商配到 GPUInfo 的条目上：两边顺序不保证一致，按厂商配对最稳 */
  videos.forEach(v => {
    const vendor = gpuVendorOfName(v.name);
    const slot = list.find(a => !a.name && (a.vendor === vendor ||
      (vendor === 'unknown' && a.vendor === 'unknown')));
    const item = slot || list.find(a => !a.name);
    if(!item) return;
    item.name = v.name;
    if(item.vendor === 'unknown') item.vendor = vendor;
    if(v.vramBytes > 0) item.vramMB = Math.round(v.vramBytes / 1048576);
  });
  // GPUInfo 少了条目（或名字没配上）时补进来，宁多不漏
  videos.forEach(v => {
    if(list.some(a => a.name === v.name)) return;
    list.push({ vendorId: 0, deviceId: 0, vendor: gpuVendorOfName(v.name), name: v.name,
      vramMB: v.vramBytes > 0 ? Math.round(v.vramBytes / 1048576) : null, discrete: false, active: false });
  });

  list.forEach(a => {
    if(!a.name){
      a.name = ({ nvidia:'NVIDIA 显卡', amd:'AMD 显卡', intel:'Intel 显卡',
        microsoft:'软件渲染（Microsoft Basic Render）' })[a.vendor] || '';
    }
    a.discrete = gpuIsDiscrete(a.vendor, a.name);
  });

  // 软件渲染驱动不是真显卡：留着能提示「GPU 没起来」，但不算可用显卡
  const usable = list.filter(a => a.vendor !== 'microsoft');
  const best = pickBest(list);

  return {
    ok: !!usable.length,
    platform: process.platform,
    // navigator.deviceMemory 在 Chromium 里被截到 8 GB，真实内存只能从这里拿
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    adapters: list,
    best,
    softwareOnly: !usable.length,
    reason: usable.length ? '' : (list.length ? '只检测到软件渲染驱动（GPU 未启用）' : '未检测到显卡')
  };
}

module.exports = { probeHardwareMain, gpuVendorOfName, gpuIsDiscrete, pickBest, winVideoControllers };
