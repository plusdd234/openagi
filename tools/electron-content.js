/* 体检：内容包热更新（P3 骨架，纯 Node，不需要 Electron / 浏览器）
 * 覆盖：内置版本 → 下载新版 → 验签 → 逐文件校验 → 原子切槽 → 自检通过；
 *       已是最新不重复下载；哈希不符整包拒绝且指针不动；签名不符拒绝；
 *       minShell 拦截；当前版本目录损坏自动回退；旧版本按槽位清理。
 * 用法：npm run test:content（或 node tools/electron-content.js）
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const content = require('../electron/content-updater');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function keypair(){
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: buf => crypto.sign(null, Buffer.from(buf), privateKey).toString('base64')
  };
}

function serve(dir){
  const srv = http.createServer(async (req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    const abs = path.join(dir, rel || 'manifest.json');
    try {
      const buf = await fsp.readFile(abs);
      res.writeHead(200, { 'content-type': abs.endsWith('.json') ? 'application/json' : 'text/plain' });
      res.end(buf);
    } catch(e){
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'openagi-content-'));
  const bundled = path.join(root, 'bundled');
  const baseDir = path.join(root, 'content');
  const publish = path.join(root, 'publish');
  await fsp.mkdir(path.join(bundled, 'js'), { recursive: true });
  await fsp.writeFile(path.join(bundled, 'index.html'), '<!doctype html><title>bundled</title>');
  await fsp.writeFile(path.join(bundled, 'js', 'app.js'), 'console.log("bundled")');
  await fsp.mkdir(baseDir, { recursive: true });
  await fsp.mkdir(publish, { recursive: true });

  const keys = keypair();
  const files = {
    'index.html': '<!doctype html><title>v1</title>',
    'js/app.js': 'console.log("v1")',
    'js/node-defs.js': '/* v1 nodes */'
  };
  const writeFiles = async (dir, map) => {
    for (const [rel, body] of Object.entries(map)) {
      const abs = path.join(dir, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, body);
    }
  };
  await writeFiles(publish, files);

  const manifest = {
    version: '2026.10.27.1',
    minShell: '0.1.0',
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha256(Buffer.from(v))]))
  };
  manifest.sig = keys.sign(content.canonicalManifest(manifest));
  await fsp.writeFile(path.join(publish, 'manifest.json'), JSON.stringify(manifest, null, 1));

  const srv = await serve(publish);
  const manifestUrl = 'http://127.0.0.1:' + srv.address().port + '/manifest.json';
  const opts = { baseDir, bundledRoot: bundled, manifestUrl, publicKey: keys.pub, appVersion: '0.1.0' };

  console.log('\n=== 1. 初始状态 ===');
  const r0 = await content.resolveRoot({ baseDir, bundledRoot: bundled });
  check(r0.version === 'bundled' && r0.root === bundled, '没有内容包时用内置版本', r0.version);
  check(r0.degraded === false, '首次启动不算降级');

  console.log('\n=== 2. 下载并切换 ===');
  const r1 = await content.check(opts);
  check(r1.ok && r1.updated && r1.version === '2026.10.27.1', '检查到新版并完成安装', JSON.stringify(r1));
  const installed = path.join(baseDir, '2026.10.27.1');
  check(fs.existsSync(path.join(installed, 'js', 'node-defs.js')), '文件确实落盘');
  check(fs.existsSync(path.join(installed, 'manifest.json')), '版本目录里留了自检用的 manifest');
  const st = JSON.parse(await fsp.readFile(path.join(baseDir, 'current.json'), 'utf8'));
  check(st.current === '2026.10.27.1', '指针指向新版本', JSON.stringify(st));

  const r2 = await content.resolveRoot({ baseDir, bundledRoot: bundled });
  check(r2.version === '2026.10.27.1' && r2.root === installed && !r2.degraded, '下次启动直接用新版', r2.version);

  console.log('\n=== 3. 幂等 ===');
  const r3 = await content.check(opts);
  check(r3.ok && r3.updated === false, '已是最新时不重复下载', JSON.stringify(r3));

  console.log('\n=== 4. 坏包被拒（指针不动） ===');
  const v2 = Object.assign({}, files, { 'index.html': '<!doctype html><title>v2</title>' });
  const m2 = {
    version: '2026.10.27.2',
    files: Object.fromEntries(Object.entries(v2).map(([k, val]) => [k, sha256(Buffer.from(val))]))
  };
  m2.files['index.html'] = sha256(Buffer.from('完全不同的内容'));   // 故意对不上
  m2.sig = keys.sign(content.canonicalManifest(m2));
  await writeFiles(path.join(publish, 'v2'), v2);
  // v2 的文件放在根下，才和 hashes 对应；这里直接把 v2 内容覆盖到根
  await writeFiles(publish, v2);
  await fsp.writeFile(path.join(publish, 'manifest.json'), JSON.stringify(m2, null, 1));
  const r4 = await content.check(opts);
  check(!r4.ok && /校验失败/.test(r4.reason || ''), '哈希不符时整包拒绝', r4.reason);
  const st4 = JSON.parse(await fsp.readFile(path.join(baseDir, 'current.json'), 'utf8'));
  check(st4.current === '2026.10.27.1', '失败后仍指向旧版本（不破坏可用性）', st4.current);

  console.log('\n=== 5. 签名与最低版本 ===');
  const m3 = JSON.parse(JSON.stringify(m2));
  m3.version = '2026.10.27.3';
  m3.files = Object.fromEntries(Object.entries(v2).map(([k, val]) => [k, sha256(Buffer.from(val))]));
  m3.sig = 'AAAA';   // 坏签名
  await fsp.writeFile(path.join(publish, 'manifest.json'), JSON.stringify(m3, null, 1));
  const r5 = await content.check(opts);
  check(!r5.ok && /签名/.test(r5.reason || ''), '签名不符直接拒绝', r5.reason);

  const m4 = Object.assign({}, m3, { minShell: '9.0.0' });
  m4.sig = keys.sign(content.canonicalManifest(m4));   // 必须先定字段再签
  await fsp.writeFile(path.join(publish, 'manifest.json'), JSON.stringify(m4, null, 1));
  const r6 = await content.check(opts);
  check(!r6.ok && /主程序/.test(r6.reason || ''), 'minShell 高于当前程序时拦下', r6.reason);

  console.log('\n=== 6. 目录损坏自动回退 ===');
  await fsp.writeFile(path.join(installed, 'index.html'), '被改坏了');
  const r7 = await content.resolveRoot({ baseDir, bundledRoot: bundled });
  check(r7.version === 'bundled' && r7.degraded === true, '当前版本自检失败 → 回退内置版本', r7.version);

  console.log('\n=== 7. 正常安装会清理旧版本 ===');
  const m5 = {
    version: '2026.10.27.4',
    files: Object.fromEntries(Object.entries(v2).map(([k, val]) => [k, sha256(Buffer.from(val))]))
  };
  m5.sig = keys.sign(content.canonicalManifest(m5));
  await writeFiles(publish, v2);
  await fsp.writeFile(path.join(publish, 'manifest.json'), JSON.stringify(m5, null, 1));
  const r8 = await content.check(opts);
  check(r8.ok && r8.updated, '损坏后仍能装上新版本', JSON.stringify(r8));
  const left = (await fsp.readdir(baseDir)).filter(n => !n.endsWith('.json'));
  check(left.length <= 2, '只保留当前与上一版（不无限堆积）', left.join(','));

  srv.close();
  await fsp.rm(root, { recursive: true, force: true });

  console.log('\n=== ' + (fails === 0 ? '全部通过' : fails + ' 项失败') + ' ===');
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试自身异常：', e);
  process.exit(1);
});
