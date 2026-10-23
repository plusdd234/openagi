/* 全盘扫描 Chromium localStorage 里是否残留含指定节点类型的工作流记录
 * 用法：node tools/scan-flows-disk.js [根目录...]
 */
const fs = require('fs');
const path = require('path');

const MARKS = ['tripoImg', 'imageSplit', 'tripoModel', 'imageCompress', 'aiTask', 'modelViews'];
const roots = process.argv.slice(2);
if (!roots.length) roots.push(path.join(process.homedir(), 'AppData'));

function findLeveldb(dir, out, depth){
  if (depth > 8) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name === 'leveldb') { out.push(p); continue; }
    if (e.name === 'node_modules' || e.name === 'Cache' || e.name === 'Code Cache') continue;
    try { findLeveldb(p, out, depth + 1); } catch (err) {}
  }
}

const dirs = [];
for (const r of roots) findLeveldb(r, dirs, 0);
console.log('找到 ' + dirs.length + ' 个 leveldb 目录，开始扫描…\n');

for (const d of dirs) {
  let files = [];
  try { files = fs.readdirSync(d).filter(f => /\.(log|ldb)$/.test(f)); } catch (e) { continue; }
  const hits = [];
  for (const f of files) {
    let b;
    try { b = fs.readFileSync(path.join(d, f)); } catch (e) { continue; }
    for (const m of MARKS) {
      const a = b.indexOf(Buffer.from(m, 'utf16le'));
      if (a >= 0) hits.push(f + ':' + m);
    }
  }
  if (hits.length) console.log('★ ' + d + '\n    ' + hits.join('  '));
}
console.log('\n扫描完成');
