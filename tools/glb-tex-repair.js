/* 贴图黑块修复（一次性工具）
 * 用法：node tools/glb-tex-repair.js <输入.glb> [输出.glb]
 * 做什么：只填 UV 岛内「面积够大且实心」的近黑连通块（参考图投影污染），
 *         睫毛/发丝/衣服黑边这类又薄又小的深色块保持不动。
 * 产物：新 GLB（原件不动），并把每张贴图的修复统计打到 stdout。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8972;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.glb': 'model/gltf-binary', '.png': 'image/png' };

const server = http.createServer((q, s) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]));
  if (!fp.startsWith(ROOT)) { s.writeHead(403); return s.end('no'); }
  fs.readFile(fp, (e, b) => {
    if (e) { s.writeHead(404); return s.end('404'); }
    s.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    s.end(b);
  });
});

(async () => {
  const input = process.argv[2];
  if (!input) { console.error('用法：node tools/glb-tex-repair.js <输入.glb> [输出.glb]'); process.exit(1); }
  const output = process.argv[3] || input.replace(/\.glb$/i, '_fixed.glb');
  const rel = path.relative(ROOT, path.resolve(input)).replace(/\\/g, '/');

  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('[console]', m.text()); });

  await page.goto(`http://localhost:${PORT}/tools/tex-repair.html?file=${encodeURIComponent(rel)}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__done === true', { timeout: 300000 });
  const out = await page.evaluate(() => window.__out);

  fs.writeFileSync(path.resolve(output), Buffer.from(out.glbBase64, 'base64'));
  delete out.glbBase64;
  console.log(JSON.stringify(out, null, 1));
  console.log('→ ' + output + '  (' + (fs.statSync(path.resolve(output)).size / 1024 / 1024).toFixed(1) + ' MB)');

  await browser.close();
  server.close();
})();
