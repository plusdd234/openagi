/* 打包 LumenAct 参考脸资源为 file:// 可加载的 JS 数据包
 *
 * 原项目把资源放在 Hugging Face，靠 Python 本地服务 + fetch 读取；本仓库的 App 跑在
 * file:// 下，XHR/fetch 读不到本地文件，所以这里把三块资源分别内联成全局变量：
 *
 *   face-meta.js      头像清单、通道表、曲线目录、贴图 data URL
 *   face-geometry.js  几何缓冲区（base64）
 *   face-curves.js    表演曲线（float32 → uint8 量化，体积约为原来的 1/4）
 *
 * 用法：node tools/pack-lumen3d.js [--src=<解压目录>]
 * 默认从 .workbuddy/lumenact-src 读取，来源为 AaBb-coder/LumenAct 的公开资源。
 * 资源不在 git 里，需要先从镜像下载（本机可直连 hf-mirror）：
 *   https://hf-mirror.com/AaBbcoder/LumenAct/resolve/main/assets/reference-face/avatar.json
 *   https://hf-mirror.com/AaBbcoder/LumenAct/resolve/main/assets/reference-face/channels.json
 *   https://hf-mirror.com/AaBbcoder/LumenAct/resolve/main/assets/reference-face/geometry.buffer.json
 *   https://hf-mirror.com/AaBbcoder/LumenAct/resolve/main/assets/reference-face/face_texture_0.png
 *   https://hf-mirror.com/AaBbcoder/LumenAct/resolve/main/models/expression/catalog.json
 *   https://hf-mirror.com/AaBbcoder/LumenAct/resolve/main/models/expression/curves.f32
 * 参考脸为 CC BY-NC 4.0，仅限非商用；打包结果里保留来源与授权说明。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const arg = process.argv.find(function (item) { return item.indexOf('--src=') === 0; });
const SRC = path.resolve(ROOT, arg ? arg.slice(6) : '.workbuddy/lumenact-src');
const OUT = path.join(ROOT, 'apps', 'lumen3d', 'model');

const FILES = {
  avatar: 'assets/reference-face/avatar.json',
  channels: 'assets/reference-face/channels.json',
  geometry: 'assets/reference-face/geometry.buffer.json',
  texture: 'assets/reference-face/face_texture_0.png',
  catalog: 'models/expression/catalog.json',
  curves: 'models/expression/curves.f32'
};

function read(rel) {
  const file = path.join(SRC, rel);
  if (!fs.existsSync(file)) {
    throw new Error('缺少资源：' + rel + '\n请先把 LumenAct 资源下载到 ' + SRC);
  }
  return fs.readFileSync(file);
}

function main() {
  const avatar = JSON.parse(read(FILES.avatar).toString('utf8'));
  const channels = JSON.parse(read(FILES.channels).toString('utf8'));
  const catalog = JSON.parse(read(FILES.catalog).toString('utf8'));
  const geometryJson = JSON.parse(read(FILES.geometry).toString('utf8'));
  const curves = read(FILES.curves);
  const texture = read(FILES.texture);

  if (avatar.schema !== 'lumen.web.avatar.v1') throw new Error('头像清单格式不支持：' + avatar.schema);
  if (channels.schema !== 'lumen.face.channels.v1') throw new Error('通道表格式不支持：' + channels.schema);
  if (catalog.schema !== 'lumenact.curves.v1') throw new Error('曲线目录格式不支持：' + catalog.schema);
  if (geometryJson.schema !== 'lumen.geometry.buffer.v1' || geometryJson.encoding !== 'base64') {
    throw new Error('几何缓冲区格式不支持');
  }

  const width = catalog.channel_count;
  if (!Number.isInteger(width) || width < 1 || curves.length % (width * 4) !== 0) {
    throw new Error('曲线缓冲区长度与通道数不匹配：' + curves.length + ' / ' + width);
  }
  const frames = curves.length / (width * 4);
  for (const style of catalog.styles) {
    if (!Number.isInteger(style.offset) || !Number.isInteger(style.frames) ||
        style.offset < 0 || style.frames < 1 ||
        (style.offset + style.frames) > frames) {
      throw new Error('片段越界：' + style.id);
    }
  }

  /* float32 → uint8：曲线取值 0–100，量化步长约 0.39，形态键权重上看不出差别 */
  const floats = new Float32Array(curves.buffer, curves.byteOffset, curves.byteLength / 4);
  let max = 0;
  for (let i = 0; i < floats.length; i++) if (floats[i] > max) max = floats[i];
  if (max > 100.5) throw new Error('曲线值超出预期范围：' + max);
  const quantized = Buffer.alloc(floats.length);
  for (let i = 0; i < floats.length; i++) {
    quantized[i] = Math.max(0, Math.min(255, Math.round(floats[i] / 100 * 255)));
  }

  const geometry = Buffer.from(geometryJson.data, 'base64');
  if (geometry.length !== geometryJson.byte_length) throw new Error('几何缓冲区长度不匹配');

  fs.mkdirSync(OUT, { recursive: true });

  const meta = {
    source: 'AaBb-coder/LumenAct',
    sourceUrl: 'https://github.com/AaBb-coder/LumenAct',
    license: '参考脸 CC BY-NC 4.0（仅限非商用）；曲线 CC BY 4.0；通道与目录数据见上游声明',
    avatar: avatar,
    channels: channels,
    catalog: catalog,
    texture: 'data:image/png;base64,' + texture.toString('base64')
  };

  write('face-meta.js', 'window.LUMEN3D_META = JSON.parse(\n' + packed(JSON.stringify(meta)) + '\n);\n');
  write('face-geometry.js', 'window.LUMEN3D_GEOMETRY =\n' + packed(geometry.toString('base64')) + ';\n');
  write('face-curves.js', 'window.LUMEN3D_CURVES = JSON.parse(\n' + packed(JSON.stringify({
    fps: catalog.fps,
    channelCount: width,
    frames: frames,
    valueMax: 100,
    data: quantized.toString('base64')
  })) + '\n);\n');

  console.log('输出目录：' + OUT);
  console.log('形态键 ' + (avatar.meshes[0].morphs || []).length + ' 个 · 可调通道 ' +
    channels.channels.length + ' 个 · 表演片段 ' + catalog.styles.length + ' 段 · ' + frames + ' 帧');
  console.log('曲线最大值 ' + max.toFixed(2) + '，量化后 ' + quantized.length + ' 字节');
  console.log('完成：face-meta.js / face-geometry.js / face-curves.js');
}

function write(name, text) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, text, 'utf8');
  const kb = (Buffer.byteLength(text) / 1024 / 1024).toFixed(2);
  console.log('  ' + name.padEnd(18) + kb + ' MB');
}

/* 大字符串按 4096 字符拆成 push 语句，运行时 join('')。
 *
 * 为什么不是 `"a" + "b" + …`：上千段的拼接表达式会让 Electron 的渲染进程直接崩溃
 * （实测 3392 段 / 13.9 MB 的 face-geometry.js 一注入 renderer 就没了，窗口全黑）；
 * 为什么不是单行几十 MB：静态守卫 conf-guard 的逐行正则会在超长行上爆栈。
 * 平铺 push 两边都躲开：单行只有 4 KB，表达式也不深。 */
function packed(value) {
  const lines = ['(function () {', '  var C = [];'];
  for (let i = 0; i < value.length; i += 4096) {
    lines.push('  C.push(' + JSON.stringify(value.slice(i, i + 4096)) + ');');
  }
  lines.push('  return C.join(\'\');', '})()');
  return lines.join('\n');
}

main();
