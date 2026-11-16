/* tools/pack-live2d.js —— 把标准 Cubism 3/4 皮套打成 file:// 能读的数据包
 *
 * 目录约定（一个模型一个目录，互不影响）：
 *   apps/live2d/model/<id>/<name>.model3.json   ← 标准 Cubism 3/4 入口
 *   apps/live2d/model/<id>/meta.json            ← 可选：显示名与版权
 * 产物：
 *   apps/live2d/model/<id>/pack.js              ← 单模型数据包（生成物，别手改）
 *   apps/live2d/model/models.js                 ← 皮套清单（生成物，别手改）
 *
 * file:// 下 XHR 读不到本地文件，所以 moc3 → base64、纹理 → data URL、
 * physics / expressions / motions 的 json → 直接解析成对象。
 *
 * 用法：node tools/pack-live2d.js              # 重打全部模型并刷新清单
 *       node tools/pack-live2d.js c_0120       # 只重打某个模型，清单仍全量刷新
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'apps', 'live2d', 'model');
const only = process.argv[2] || '';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const dirs = fs.readdirSync(root, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

const models = [];

for (const id of dirs) {
  const dir = path.join(root, id);
  const entry = fs.readdirSync(dir).find(f => /\.model3\.json$/i.test(f));
  if (!entry) continue;

  const settings = readJson(path.join(dir, entry));
  const refs = settings.FileReferences || {};

  /* 清单项：包没打出来也能列出来，运行时再报错，方便定位 */
  let meta = {};
  try { meta = readJson(path.join(dir, 'meta.json')); } catch (e) { meta = {}; }
  models.push({
    id,
    name: String(meta.name || id),
    author: String(meta.author || ''),
    license: String(meta.license || ''),
    entry,
    dir: 'apps/live2d/model/' + id + '/',
    pack: 'apps/live2d/model/' + id + '/pack.js'
  });

  if (only && only !== id) continue;

  const files = new Set();
  const add = f => { if (f) files.add(f); };
  add(refs.Moc);
  add(refs.Physics);
  add(refs.Pose);
  add(refs.UserData);
  add(refs.DisplayInfo);
  (refs.Expressions || []).forEach(e => add(e.File));
  Object.keys(refs.Motions || {}).forEach(g => {
    (refs.Motions[g] || []).forEach(m => add(m.File));
  });

  const moc = fs.readFileSync(path.join(dir, refs.Moc)).toString('base64');
  const json = {};
  for (const f of files) {
    if (f === refs.Moc) continue;
    json[f] = readJson(path.join(dir, f));
  }
  /* 纹理走 data: URL —— file:// 下 <img> 带 crossOrigin 会被 CORS 拦掉 */
  const textures = (refs.Textures || []).map(f =>
    'data:image/png;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64'));

  const out = '/* 自动生成：moc3 与纹理为 base64，json 已解析。重跑 node tools/pack-live2d.js。\n' +
    ' * 模型版权见同目录 meta.json 与 model/PROVENANCE.md。\n' +
    ' */\n' +
    'window.L2D_PACKS = window.L2D_PACKS || {};\n' +
    'window.L2D_PACKS[' + JSON.stringify(id) + '] = ' +
    JSON.stringify({ entry, settings, moc, textures, json }) + ';\n';

  fs.writeFileSync(path.join(dir, 'pack.js'), out, 'utf8');
  console.log('  ', id, (out.length / 1048576).toFixed(2) + 'MB', 'json', Object.keys(json).length);
}

const reg = '/* 自动生成：皮套清单。重跑 node tools/pack-live2d.js，别手改。 */\n' +
  'window.L2D_MODELS = ' + JSON.stringify(models, null, 2) + ';\n';
fs.writeFileSync(path.join(root, 'models.js'), reg, 'utf8');
console.log('models.js', models.length + ' 个皮套：' + models.map(m => m.id).join(', '));
