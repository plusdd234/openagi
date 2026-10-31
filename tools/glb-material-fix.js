/* GLB 材质修复（字节级，不重编码贴图）
 * 症状：Tripo/OBJ 链路导出的材质是 metallicFactor 0.5 / roughnessFactor 0.5 ——
 *      皮肤、布料被当金属算，观感发灰发暗，像「没做完」。
 * 做法：只改 JSON chunk 里的材质参数，BIN（几何 + 贴图）原样保留，一个字节都不重编码。
 * 用法：node tools/glb-material-fix.js <输入.glb> [输出.glb] [--metallic=0] [--roughness=0.75]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opts = { metallic: 0, roughness: 0.75 };
for (const a of args) {
  const m = /^--(metallic|roughness)=([\d.]+)$/.exec(a);
  if (m) opts[m[1]] = Number(m[2]);
}
const files = args.filter(a => !a.startsWith('--'));
const input = files[0];
const output = files[1] || input.replace(/\.glb$/i, '_fixed.glb');

const buf = fs.readFileSync(input);
if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('不是 GLB');
let off = 12, json = null, jsonStart = 0, jsonLen = 0, restStart = 0;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  if (type === 0x4E4F534A) { jsonStart = off + 8; jsonLen = len; restStart = off + 8 + len; break; }
  off += 8 + len + ((4 - (len % 4)) % 4);
}
json = JSON.parse(buf.slice(jsonStart, jsonStart + jsonLen).toString('utf8'));

let touched = 0;
for (const mat of json.materials || []) {
  const p = mat.pbrMetallicRoughness || (mat.pbrMetallicRoughness = {});
  const before = { metallic: p.metallicFactor, roughness: p.roughnessFactor };
  if (p.metallicFactor !== opts.metallic) { p.metallicFactor = opts.metallic; touched++; }
  if (p.roughnessFactor !== opts.roughness) { p.roughnessFactor = opts.roughness; touched++; }
  mat.__before = before;
}
for (const mat of json.materials || []) delete mat.__before;

let newJson = Buffer.from(JSON.stringify(json), 'utf8');
// JSON chunk 必须 4 字节对齐，用空格补齐（JSON 允许尾部空白）
const pad = (4 - (newJson.length % 4)) % 4;
if (pad) newJson = Buffer.concat([newJson, Buffer.alloc(pad, 0x20)]);

const head = Buffer.alloc(12);
head.writeUInt32LE(0x46546C67, 0);
head.writeUInt32LE(2, 4);
head.writeUInt32LE(12 + 8 + newJson.length + (buf.length - restStart), 8);

const chunkHead = Buffer.alloc(8);
chunkHead.writeUInt32LE(newJson.length, 0);
chunkHead.writeUInt32LE(0x4E4F534A, 4);

const out = Buffer.concat([head, chunkHead, newJson, buf.slice(restStart)]);
fs.writeFileSync(output, out);
console.log(JSON.stringify({
  input, output,
  materialsTouched: (json.materials || []).length,
  metallic: opts.metallic, roughness: opts.roughness,
  sizeBefore: +(buf.length / 1048576).toFixed(2), sizeAfter: +(out.length / 1048576).toFixed(2),
}, null, 1));
