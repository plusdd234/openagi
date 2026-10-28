/* 只读探针：实测各下载源速度，验证「多源择优」选得对。
 * 只探测 1 MB，不下载完整安装包，不安装任何东西。
 * node tools/probe-ollama-src.js
 */
const DL = require('../electron/ollama-download');

const MIRRORS = [
  { prefix: '', name: 'GitHub 直连' },
  { prefix: 'https://gh-proxy.com/', name: 'gh-proxy' },
  { prefix: 'https://ghfast.top/', name: 'ghfast' },
  { prefix: 'https://ghproxy.net/', name: 'ghproxy.net' },
  { prefix: 'https://gh.llkk.cc/', name: 'llkk' },
  { prefix: 'https://github.moeyy.xyz/', name: 'moeyy' }
];

(async () => {
  const r0 = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'openagi-probe' }
  });
  const j = await r0.json();
  const a = (j.assets || []).find(x => x.name === 'OllamaSetup.exe');
  if(!a) throw new Error('未找到 OllamaSetup.exe');
  console.log('版本 ' + j.tag_name + ' · ' + (a.size / 1048576).toFixed(0) + ' MB · digest ' + (a.digest || '无'));

  const sources = MIRRORS.map(m => ({ url: (m.prefix || '') + a.browser_download_url, name: m.name }));
  const t0 = Date.now();
  const picked = await DL.pickSources(sources, DL.nodeHttpGet, { probeMs: 5000, keepBest: 3 });
  console.log('探测耗时 ' + (Date.now() - t0) + ' ms，探测到总大小 ' + (picked.total / 1048576).toFixed(0) + ' MB\n');

  console.log('全部源：');
  picked.all.forEach(x => {
    const sp = x.speed ? (x.speed / 1024).toFixed(0).padStart(6) + ' KB/s' : '   不可用';
    console.log('  ' + x.name.padEnd(13) + sp + (x.error ? '  ' + x.error : ''));
  });
  console.log('\n选用：');
  picked.chosen.forEach(x => console.log('  ' + x.name + '  ' + (x.speed / 1024).toFixed(0) + ' KB/s'));

  const best = picked.chosen[0].speed;
  const secs = picked.total / best;
  console.log('\n估算（' + picked.total + ' 字节 / ' + (best / 1024).toFixed(0) + ' KB/s）：');
  console.log('  单连接 ' + (secs / 60).toFixed(1) + ' 分钟 → ' + DL.WORKERS + ' 路并发理论 ' + (secs / DL.WORKERS / 60).toFixed(1) + ' 分钟');
})().catch(e => { console.error('探针失败：' + ((e && e.message) || e)); process.exit(1); });
