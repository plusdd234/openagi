/* 一次性工具：把 three r149 的 ESM 版 GLTFExporter 包成 UMD。
 * 用法：先把 https://unpkg.com/three@0.149.0/examples/jsm/exporters/GLTFExporter.js
 * 下载到 /tmp/GLTFExporter.jsm（或改下面的 SRC），再 node tools/_mkgltfexporter.js
 * 产出 vendor/GLTFExporter.js。以后升级 three 时重跑一遍即可。 */
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || '/tmp/GLTFExporter.jsm';
const OUT = path.join(__dirname, '..', 'vendor', 'GLTFExporter.js');

let src = fs.readFileSync(SRC, 'utf8');
if (!/export \{ GLTFExporter \};/.test(src)) throw new Error('源文件不含 GLTFExporter 导出，确认下载的是 exporters/GLTFExporter.js');

src = src.replace(/^import\s*\{([\s\S]*?)\}\s*from\s*'three';/m, (m, names) => {
  return 'const {\n' + names + '\n} = THREE__;';
});
src = src.replace(/export \{ GLTFExporter \};/, 'THREE__.GLTFExporter = GLTFExporter;');

const header = [
  '/* GLTFExporter —— three.js r149 (MIT)',
  ' * 来源：https://unpkg.com/three@0.149.0/examples/jsm/exporters/GLTFExporter.js',
  ' * 原文件是 ESM（r148 起 examples/js 目录已移除），这里包了一层 UMD：',
  " *   import {A,B} from 'three'  →  const {A,B} = 全局 THREE",
  ' *   export { GLTFExporter }     →  THREE.GLTFExporter = GLTFExporter',
  ' * 重新生成：下载源文件后 node tools/_mkgltfexporter.js（源文件 2800 行，除头尾两处外未改动）。',
  ' */',
  '(function (global) {',
  "  'use strict';",
  '  var THREE__ = global.THREE;',
  "  if (!THREE__) throw new Error('GLTFExporter.js 必须在 three.min.js 之后引入');"
].join('\n');

fs.writeFileSync(OUT, header + '\n' + src + '\n})(window);\n');
console.log('written', fs.statSync(OUT).size, 'bytes ->', OUT);
