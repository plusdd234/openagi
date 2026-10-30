// 驱动 tools/_paint_detail.html（本地静态服务 + Playwright 真浏览器跑 WebGL）
// 用法：node tools/_paint_detail.js [map|stats|paint]
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8951;
const MIME = { '.html':'text/html', '.js':'application/javascript', '.obj':'text/plain',
  '.mtl':'text/plain', '.png':'image/png', '.json':'application/json', '.jpg':'image/jpeg' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  let fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const mode = process.argv[2] || 'map';
const size = Number(process.argv[3]) || 2048;

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ channel: 'msedge', args: ['--ignore-gpu-blocklist','--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const logs = [];
  page.on('console', m => logs.push('[' + m.type() + '] ' + m.text()));
  page.on('pageerror', e => logs.push('[pageerror] ' + e.message));

  await page.addInitScript(([m, s]) => { window.__OPTS = { mode: m, size: s }; }, [mode, size]);
  await page.goto('http://localhost:' + PORT + '/tools/_paint_detail.html', { waitUntil: 'load' });
  await page.waitForFunction('window.__done === true', { timeout: 180000 });

  const r = await page.evaluate(() => ({
    err: window.__err || null,
    preview: window.__previewPng || null,
    tex: window.__texPng || null,
    closeup: window.__closeupPng || null,
    table: window.__table || null,
    trio: window.__trio || null,
    hits: window.__hits || null
  }));

  if (r.table) fs.writeFileSync(path.join(__dirname, '_islands_full.json'), JSON.stringify(r.table, null, 1));
  if (r.preview) fs.writeFileSync(path.join(__dirname, '_paint_' + mode + '.png'), Buffer.from(r.preview.split(',')[1], 'base64'));
  if (r.tex) fs.writeFileSync(path.join(__dirname, '_paint_tex.png'), Buffer.from(r.tex.split(',')[1], 'base64'));
  if (r.closeup) fs.writeFileSync(path.join(__dirname, '_paint_head.png'), Buffer.from(r.closeup.split(',')[1], 'base64'));
  if (r.trio) {
    const dir = path.join(__dirname, '_paint_out');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'body.obj'), Buffer.from(r.trio.obj.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(dir, 'body.mtl'), Buffer.from(r.trio.mtl.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(dir, 'texture.png'), Buffer.from(r.tex.split(',')[1], 'base64'));
  }

  console.log('mode:', mode, '| size:', size, '| err:', r.err || 'none', '| islands:', r.table ? r.table.length : 'n/a', '| detail texels:', r.hits == null ? 'n/a' : r.hits);
  logs.slice(0, 10).forEach(l => console.log(l));
  if (r.preview) console.log('preview -> tools/_paint_' + mode + '.png');

  await browser.close();
  server.close();
  if (r.err) process.exit(1);
})().catch(e => { console.error('DRIVER FAIL', e); process.exit(2); });
