/* 只读探针：批量实测候选镜像（各探 512KB），挑出可用的进白名单。不下载完整包。 */
const DL = require('../electron/ollama-download');
const LIST = [
  '', 'https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/',
  'https://gh.llkk.cc/', 'https://github.moeyy.xyz/', 'https://ghproxy.cc/',
  'https://gh-proxy.net/', 'https://gitproxy.click/', 'https://gh.api.99988866.xyz/',
  'https://hub.gitmirror.com/', 'https://ghproxy.cfd/', 'https://gp.zkv.workers.dev/',
  'https://cdn.jsdelivr.net/', 'https://gh.xxooo.cf/', 'https://gh-proxy.top/',
  'https://ghp.ci/', 'https://ghproxy.homeboyc.cn/', 'https://gh.monlor.com/',
  'https://gh.7t7.xyz/', 'https://gh.nxnow.top/'
];
(async () => {
  const r0 = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'openagi-probe' }
  });
  const j = await r0.json();
  const a = (j.assets || []).find(x => x.name === 'OllamaSetup.exe');
  const srcs = LIST.map(p => ({ url: p + a.browser_download_url, name: p || 'GitHub 直连' }));
  const t0 = Date.now();
  const rs = await Promise.all(srcs.map(s => DL.probeOne(s, DL.nodeHttpGet, 5000)));
  rs.sort((x, y) => y.speed - x.speed);
  console.log('探测耗时 ' + (Date.now() - t0) + ' ms\n');
  rs.forEach(x => {
    const sp = x.speed ? (x.speed / 1024).toFixed(0).padStart(6) + ' KB/s' : '   不可用';
    console.log('  ' + sp + '  ' + (x.name === 'GitHub 直连' ? x.name : x.name.replace(/^https?:\/\//, '').replace(/\/$/, '')) + (x.error ? '  ← ' + x.error : ''));
  });
  const good = rs.filter(x => x.speed > 0).map(x => x.name);
  console.log('\n可用 ' + good.length + '/' + rs.length + '：' + good.join(' , '));
})();
