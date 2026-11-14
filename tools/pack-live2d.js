/* tools/pack-live2d.js —— 把皮套打成 file:// 能读的数据包
 *
 * file:// 页面下 XHR 读不到本地 moc3 / json，所以：
 *   · moc3 → base64
 *   · 纹理 → data: URL（PIXI 的 Image 请求带 crossOrigin，file:// 下会被 CORS 拦）
 *   · physics / expressions / motions 的 json → 直接解析成对象
 * 产物：apps/live2d/model/pack.js（生成物，别手改）
 *
 * 用法：node tools/pack-live2d.js     # 模型或表情/动作有变动时重跑
 */
'use strict';
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'apps', 'live2d', 'model');
const settings = JSON.parse(fs.readFileSync(path.join(dir, 'c_0120.model3.json'), 'utf8'));

const files = {};
files[settings.FileReferences.Moc] = settings.FileReferences.Moc;
files[settings.FileReferences.Physics] = settings.FileReferences.Physics;
(settings.FileReferences.Expressions || []).forEach(e => { files[e.File] = e.File; });
Object.keys(settings.FileReferences.Motions || {}).forEach(g => {
  settings.FileReferences.Motions[g].forEach(m => { files[m.File] = m.File; });
});

const moc = fs.readFileSync(path.join(dir, settings.FileReferences.Moc)).toString('base64');
const json = {};
for (const f of Object.keys(files)) {
  if (f === settings.FileReferences.Moc) continue;
  json[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
}
/* 纹理走 data: URL —— file:// 下 <img> 带 crossOrigin 会被 CORS 拦掉 */
const textures = settings.FileReferences.Textures.map(f =>
  'data:image/png;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64'));

const out = '/* 自动生成的模型数据包：moc3 与纹理为 base64，json 已解析。\n' +
  ' * 生成脚本 tools/_pack-l2d.js；模型版权见同目录 PROVENANCE.md，CC BY-NC-SA 4.0。\n' +
  ' */\n' +
  'window.L2D_PACK = ' + JSON.stringify({ settings, moc, textures, json }) + ';\n';

fs.writeFileSync(path.join(dir, 'pack.js'), out, 'utf8');
console.log('pack.js', (out.length / 1048576).toFixed(2) + 'MB', 'json files:', Object.keys(json).length);
