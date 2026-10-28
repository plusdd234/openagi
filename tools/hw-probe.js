/* 独显探测（electron/hardware-info.js）
 *
 * 背景：本机是 RTX 3050 + Intel UHD 双显卡，面板却只报「Intel(R) UHD Graphics · 核显」，
 * 用户以为没探测到独显。根因两条：
 *   ① Chromium 把 WebGL/WebGPU 分配给核显（省电），渲染进程只看得到一块；
 *   ② Windows 上 adapter.info.description 是空串，连型号都拿不到。
 * 修法：主进程 app.getGPUInfo('complete') 列全部适配器 + Win32_VideoController 补型号显存。
 *
 * 本测试守的是「判定与择优」这层纯逻辑——它们出错时现象和「没探测到」一模一样，
 * 光看真实输出无法区分是采集不到还是判错了：
 *   1) 型号 → 厂商
 *   2) 核显/独显判定（APU 名字就叫 Radeon Graphics，最容易误判）
 *   3) 双显卡时择优必须选独显（即使 active 是核显）
 *   4) 软件渲染驱动不算可用显卡
 *   5) 真机 Win32 采集能拿到型号与显存（非 Windows 跳过）
 *
 * node tools/hw-probe.js > log 2>&1
 */
'use strict';

const HW = require('../electron/hardware-info');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){ ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)); }

/* ---------- 1. 型号 → 厂商 ---------- */
console.log('\n=== 1. 型号反推厂商 ===');
[
  ['NVIDIA GeForce RTX 3050 Laptop GPU', 'nvidia'],
  ['NVIDIA GeForce GTX 1660 SUPER', 'nvidia'],
  ['Quadro P2000', 'nvidia'],
  ['AMD Radeon RX 6600', 'amd'],
  ['AMD Radeon(TM) Graphics', 'amd'],
  ['Intel(R) UHD Graphics', 'intel'],
  ['Intel(R) Iris(R) Xe Graphics', 'intel'],
  ['Intel(R) Arc(TM) A770 Graphics', 'intel'],
  ['Microsoft Basic Render Driver', 'microsoft'],
  ['Microsoft Remote Display Adapter', 'microsoft'],
  ['VMware SVGA 3D', 'virtual'],
  ['', 'unknown'],
  [null, 'unknown']
].forEach(([name, want]) => eq(HW.gpuVendorOfName(name), want, JSON.stringify(name) + ' → ' + want));

/* ---------- 2. 核显 / 独显 ---------- */
console.log('\n=== 2. 核显还是独显 ===');
[
  // NVIDIA 的移动端芯片也叫 Laptop GPU，但仍是独显
  ['nvidia', 'NVIDIA GeForce RTX 3050 Laptop GPU', true],
  ['nvidia', 'NVIDIA GeForce MX150', true],
  // APU 的核显名字就叫 Radeon Graphics，不能见 AMD 就判独显
  ['amd', 'AMD Radeon(TM) Graphics', false],
  ['amd', 'AMD Radeon™ Graphics', false],
  ['amd', 'AMD Radeon Vega 8 Graphics', false],
  ['amd', 'AMD Radeon 780M', false],
  ['amd', 'AMD Radeon R7 Graphics', false],
  ['amd', 'AMD Radeon RX 6600', true],
  ['amd', 'AMD Radeon RX Vega 56', true],
  ['amd', 'AMD Radeon Pro 5500M', true],
  // Intel 只有 Arc 是独显
  ['intel', 'Intel(R) UHD Graphics 620', false],
  ['intel', 'Intel(R) Iris(R) Xe Graphics', false],
  ['intel', 'Intel(R) Arc(TM) A770 Graphics', true],
  ['microsoft', 'Microsoft Basic Render Driver', false],
  ['virtual', 'VMware SVGA 3D', false]
].forEach(([v, n, want]) => eq(HW.gpuIsDiscrete(v, n), want, v + ' / ' + n + ' → ' + (want ? '独显' : '核显')));

/* ---------- 3. 择优 ---------- */
console.log('\n=== 3. 双显卡择优 ===');
const laptop = [
  { vendor: 'intel', name: 'Intel(R) UHD Graphics', vramMB: 1024, discrete: false, active: true },
  { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3050 Laptop GPU', vramMB: 4096, discrete: true, active: false },
  { vendor: 'microsoft', name: '软件渲染（Microsoft Basic Render）', vramMB: null, discrete: false, active: false }
];
const best = HW.pickBest(laptop);
ok(!!best && best.vendor === 'nvidia', '双显卡选独显（active 是核显也不影响）', JSON.stringify(best));
eq(best && best.vramMB, 4096, '显存跟着独显走');
eq(best && best.discrete, true, '结果标记为独显');

// 没有独显时不能返回 null，要老实报核显
const apuOnly = [
  { vendor: 'amd', name: 'AMD Radeon(TM) Graphics', vramMB: 512, discrete: false, active: true }
];
const b2 = HW.pickBest(apuOnly);
ok(!!b2 && b2.vendor === 'amd' && b2.discrete === false, '只有核显时返回核显（不是 null）', JSON.stringify(b2));

// 两块独显取显存大的
const dual = [
  { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3050 Laptop GPU', vramMB: 4096, discrete: true, active: false },
  { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', vramMB: 24564, discrete: true, active: false }
];
eq(HW.pickBest(dual).vramMB, 24564, '两块独显取显存大的');

// 显存读不到（null）时不能把已有的卡丢掉
const unknownVram = [
  { vendor: 'nvidia', name: 'NVIDIA 显卡', vramMB: null, discrete: true, active: false },
  { vendor: 'intel', name: 'Intel(R) UHD Graphics', vramMB: 1024, discrete: false, active: true }
];
eq(HW.pickBest(unknownVram).vendor, 'nvidia', '独显显存未知仍优先于核显');

/* ---------- 4. 只剩软件渲染 ---------- */
console.log('\n=== 4. 只有软件渲染 ===');
eq(HW.pickBest([laptop[2]]), null, '只有软件渲染驱动 → best 为 null');
eq(HW.pickBest([]), null, '空列表 → null');
eq(HW.pickBest(null), null, 'null 输入 → null（不抛异常）');

/* ---------- 5. 推荐档位（js/hardware.js，浏览器脚本，用 vm 装进沙箱） ---------- */
console.log('\n=== 5. 推荐档位 ===');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'js', 'hardware.js'), 'utf8');
const sandbox = { window: {}, navigator: {}, document: {}, console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { recommendLLM, recommendImage } = sandbox;

// 4 GB 独显 + 16 GB 内存：档位必须按显存定，不能因为内存大就推荐 7~8B
const r4 = recommendLLM(1500, { vramGB: 4, ramGB: 16 });
eq(r4.tier, 'minimal', '4 GB 显存 → 3~4B 档（不是 7~8B）');
eq(r4.size, '3B', '4 GB 显存选的型号');
ok(!/6~8B/.test(r4.note), '文案不再自相矛盾地推荐 7~8B', r4.note);
ok(/offload/.test(r4.note), '提示更大模型可 offload 但要慢', r4.note);

eq(recommendLLM(1500, { vramGB: 8, ramGB: 16 }).tier, 'entry', '8 GB → 7~8B 档');
eq(recommendLLM(1500, { vramGB: 12, ramGB: 32 }).tier, 'mid', '12 GB → 13~14B 档');
eq(recommendLLM(1500, { vramGB: 24, ramGB: 64 }).tier, 'high', '24 GB → 30B 档');
ok(/CPU 推理/.test(recommendLLM(1500, { vramGB: 0, ramGB: 16 }).note), '没有独显时说明走 CPU');
eq(recommendLLM(1500, { vramGB: 0, ramGB: 8 }).tier, 'minimal', '无独显 + 8 GB 内存 → 小模型');
eq(recommendLLM(1500, { vramGB: 0, ramGB: 2 }).tier, 'none', '内存太小 → 建议云端');

// 4 GB 跑 SD1.5 是够的，不该一律劝去云端
const i4 = recommendImage(4096, { ok: true, discrete: true, name: 'RTX 3050', vramMB: 4096 });
ok(/SD1\.5/.test(i4.note), '4 GB 独显：SD1.5 可用', i4.note);
ok(!/建议用云端生图/.test(i4.note), '4 GB 独显不直接劝退到云端', i4.note);
ok(/核显/.test(recommendImage(1024, { ok: true, discrete: false, name: 'Intel UHD', vramMB: 1024 }).note), '只有核显时文案点明核显');
ok(/没检测到可用显卡/.test(recommendImage(0, { ok: false }).note), '无显卡的文案');
ok(/显存未知/.test(recommendImage(0, { ok: true, discrete: true, name: 'RTX 4090', vramMB: null }).note), '独显显存未知单独成档');

/* ---------- 6. 描述文案 ---------- */
console.log('\n=== 6. 描述文案 ===');
const { describeHardware, describeOtherGpus } = sandbox;
const hLine = describeHardware({
  gpu: { ok: true, discrete: true, name: 'NVIDIA GeForce RTX 3050 Laptop GPU', vramMB: 4096,
    adapters: [
      { name: 'Intel(R) UHD Graphics', vendor: 'intel', vramMB: 1024, discrete: false, active: true },
      { name: 'NVIDIA GeForce RTX 3050 Laptop GPU', vendor: 'nvidia', vramMB: 4096, discrete: true, active: false }
    ] },
  memory: { deviceMemoryGB: 16, exact: true },
  cpu: { cores: 16 },
  storage: { ok: true, available: 150 * 1073741824 }
});
ok(/（独显）/.test(hLine), '主行标出（独显）', hLine);
ok(/内存 16 GB/.test(hLine) && !/16 GB 以上/.test(hLine), '内存精确时不说「以上」', hLine);
const hLoose = describeHardware({
  gpu: { ok: true, discrete: false, name: 'Intel(R) UHD Graphics', vramMB: 1024, adapters: [] },
  memory: { deviceMemoryGB: 8, exact: false }, cpu: { cores: 8 }, storage: { ok: false }
});
ok(/（核显）/.test(hLoose), '核显标出（核显）', hLoose);
ok(/8 GB 以上/.test(hLoose), '内存是估算值时说「以上」（浏览器截到 8 GB）', hLoose);
const sub = describeOtherGpus({
  gpu: { name: 'NVIDIA GeForce RTX 3050 Laptop GPU', adapters: [
    { name: 'Intel(R) UHD Graphics', vendor: 'intel', discrete: false },
    { name: 'NVIDIA GeForce RTX 3050 Laptop GPU', vendor: 'nvidia', discrete: true }
  ] }
});
ok(/^另有：/.test(sub) && /Intel/.test(sub) && !/NVIDIA/.test(sub), '副显卡只列非首选那块', sub);
eq(describeOtherGpus({ gpu: { name: 'X', adapters: [{ name: 'X', vendor: 'nvidia', discrete: true }] } }), '', '只有一块卡时不显示「另有」');

/* ---------- 7. 真机采集 ---------- */
console.log('\n=== 7. 真机 Win32 采集 ===');
HW.winVideoControllers().then(list => {
  if(process.platform !== 'win32'){
    console.log('  - 非 Windows，跳过');
  } else if(!list.length){
    // PowerShell 被策略禁用时会走到这里，不能算回归
    console.log('  ! 没采到任何显卡（PowerShell 不可用？）——采集失败会退回「只有核显」，请人工确认');
    fail++;
    console.log('  ✗ 真机采集为空');
  } else {
    ok(list.every(v => v.name && v.name.length > 0), '每块卡都有型号 · ' + list.length + ' 块');
    ok(list.every(v => Number.isFinite(v.vramBytes)), '显存字段是数字（失败为 0，不是 NaN）');
    // NDJSON 解析曾经把型号全解析丢（多包了一层），这里守住
    ok(!list.some(v => /^"|\\u/g.test(v.name)), '型号里没有残留的 JSON 转义', JSON.stringify(list.map(v => v.name)));
    const named = list.filter(v => /geforce|radeon|uhd|iris|arc/i.test(v.name));
    ok(named.length > 0, '能认出真实型号', JSON.stringify(list.map(v => v.name)));
    list.forEach(v => console.log('    · ' + v.name + ' · ' + Math.round(v.vramBytes / 1048576) + ' MB'));
  }

  console.log('\n---------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
  process.exit(fail ? 1 : 0);
}).catch(e => {
  console.log('  ✗ 采集抛异常：' + (e && e.message));
  process.exit(1);
});
