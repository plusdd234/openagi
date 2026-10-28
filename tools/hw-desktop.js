/* 独显探测端到端（真实 Electron 主进程 + 真实渲染进程）
 *
 * tools/hw-probe.js 守的是判定/择优这层纯逻辑，但「独显没探测出来」的原始故障
 * 出在采集层：app.getGPUInfo('complete') 到底拿不拿得到独显、preload 桥通不通、
 * 面板拿到的 h.gpu 是不是 source:'desktop'。这些只有真跑一遍才知道。
 *
 * 跑法：unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe tools/hw-desktop.js
 */
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

app.whenReady().then(async () => {
  const { probeHardwareMain } = require('../electron/hardware-info');
  ipcMain.handle('hw:probe', () => probeHardwareMain());

  /* ---- 1. 主进程采集 ---- */
  console.log('\n=== 1. 主进程采集 ===');
  const m = await probeHardwareMain();
  ok(!!m && m.ok === true, '采集成功');
  ok(Array.isArray(m.adapters) && m.adapters.length > 0, '适配器列表非空 · ' + (m.adapters || []).length + ' 块');
  ok(!!m.best, '选出了首选显卡', JSON.stringify(m.best));
  ok(typeof m.totalMemBytes === 'number' && m.totalMemBytes > 0,
    '拿到真实物理内存 · ' + Math.round((m.totalMemBytes || 0) / 1073741824) + ' GB');
  m.adapters.forEach(a => console.log('    · ' + a.vendor + ' | ' + a.name + ' | ' +
    a.vramMB + ' MB | ' + (a.discrete ? '独显' : '核显') + (a.active ? ' | active' : '')));

  // 关键断言：机器上有独显时，首选必须是那块独显。
  // 原故障就是这里把所有适配器都当核显，`best` 落到 Intel 上。
  const hasDiscrete = m.adapters.some(a => a.discrete && a.vendor !== 'microsoft');
  if(hasDiscrete){
    ok(m.best.discrete === true, '有独显时首选就是独显（active 是核显也不影响）');
    ok(m.best.vramMB > 0, '首选显卡拿到了显存 · ' + m.best.vramMB + ' MB');
  } else {
    console.log('  - 本机没有独显，跳过首选断言');
  }
  ok(m.softwareOnly === false || !hasDiscrete, 'softwareOnly 与实际情况一致');

  /* ---- 2. 渲染进程桥 ---- */
  console.log('\n=== 2. 渲染进程（preload 桥 + 面板文案） ===');
  const win = new BrowserWindow({
    show: false, width: 900, height: 700,
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.js'), contextIsolation: true }
  });
  await win.loadURL('file:///' + path.join(__dirname, '..', 'index.html').replace(/\\/g, '/') + '?nostore=1');
  await new Promise(r => setTimeout(r, 1200));

  const r = await win.webContents.executeJavaScript(`(async () => {
    HARDWARE_CACHE = null;
    const h = await probeHardware(true);
    return { line: describeHardware(h), other: describeOtherGpus(h), gpu: h.gpu, mem: h.memory };
  })()`);

  ok(!!r.gpu && r.gpu.ok === true, '渲染进程拿到 GPU 信息');
  ok(r.gpu && r.gpu.source === 'desktop', "来源是桌面桥（不是只看到核显的 renderer）", r.gpu && r.gpu.source);
  if(hasDiscrete){
    ok(r.gpu.discrete === true, '渲染进程也认得出这是独显');
    ok(/（独显）/.test(r.line), '面板显示「（独显）」', r.line);
  }
  ok(typeof r.line === 'string' && r.line.length > 0, '硬件行能渲染出来');
  ok(r.mem && r.mem.exact === true, '内存是精确值（不是浏览器截断的 8 GB）');
  console.log('    面板：' + r.line);
  if(r.other) console.log('    副行：' + r.other);

  console.log('\n---------------------------------------');
  console.log('通过 ' + pass + ' / ' + (pass + fail) + '，失败 ' + fail);
  app.exit(fail ? 1 : 0);
}).catch(e => {
  console.log('  ✗ 抛异常：' + (e && e.stack));
  app.exit(1);
});
