/* 二次元机械音效果器纯逻辑测试：不启动 runtime、不合成语音。
 *
 * 守四件事：
 *   ① 只改 PCM 数据，WAV 头与时长原样保留；
 *   ② 波形确实被改写（不是「配置了但没生效」）；
 *   ③ 输出做峰值归一化，不削顶；
 *   ④ 非 16-bit PCM / 坏数据一律原样返回，不能把音频弄坏。
 *
 * 跑法：node tools/tts-mecha.js
 */
'use strict';

const { mechaizeWav } = require('../plugins/runtime/tts-mecha');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){
  ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}

/* 生成 16-bit 单声道 PCM WAV：纯测试用，不依赖第三方库 */
function makeWav(samples, rate, bits){
  bits = bits || 16;
  const bytes = bits === 16 ? 2 : 1;
  const data = Buffer.alloc(samples.length * bytes);
  samples.forEach((v, i) => {
    const x = Math.max(-1, Math.min(1, v));
    if(bits === 16) data.writeInt16LE(Math.round(x * 32767), i * 2);
    else data.writeUInt8(Math.round((x + 1) * 127.5), i);
  });
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * bytes, 28);
  h.writeUInt16LE(bytes, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
function dataOf(buf){
  let p = 12;
  while (p + 8 <= buf.length) {
    const sz = buf.readUInt32LE(p + 4);
    if (buf.toString('ascii', p, p + 4) === 'data') return buf.subarray(p + 8, p + 8 + sz);
    p += 8 + sz + (sz & 1);
  }
  return null;
}

const RATE = 22050;
const N = Math.floor(RATE * 0.4);
const tone = [];
for(let i = 0; i < N; i++) tone.push(0.5 * Math.sin(2 * Math.PI * 220 * i / RATE));
const src = makeWav(tone, RATE);
const out = mechaizeWav(src);

console.log('=== 机械音效果器 ===');
eq(out.length, src.length, 'WAV 总长度不变');
eq(out.toString('ascii', 0, 4), 'RIFF', 'RIFF 头保留');
eq(out.toString('ascii', 8, 12), 'WAVE', 'WAVE 头保留');
eq(out.readUInt32LE(24), RATE, '采样率不变');
eq(out.readUInt16LE(22), 1, '声道数不变');

const a = dataOf(src);
const b = dataOf(out);
eq(!!a && !!b, true, '能定位 data 段');
eq(b.length, a.length, 'PCM 采样数不变');

let diff = 0;
let peak = 0;
for(let i = 0; i < b.length; i += 2){
  if(Math.abs(a.readInt16LE(i) - b.readInt16LE(i)) > 32) diff++;
  peak = Math.max(peak, Math.abs(b.readInt16LE(i)));
}
const ratio = diff / (b.length / 2);
ok(ratio > 0.8, '绝大多数采样被改写（效果器确实生效）', (ratio * 100).toFixed(1) + '%');
ok(peak >= 25000 && peak <= 31700, '峰值归一化到 0.92 附近且不削顶', 'peak=' + peak);

/* 坏输入不能改坏 */
const junk = Buffer.from('not a wav at all, definitely not audio');
eq(mechaizeWav(junk).equals(junk), true, '非 WAV 原样返回');
const eightBit = makeWav(tone, RATE, 8);
eq(mechaizeWav(eightBit).equals(eightBit), true, '非 16-bit PCM 原样返回');
const tiny = makeWav([0.1, -0.1, 0.2], RATE);
eq(mechaizeWav(tiny).equals(tiny), true, '采样过少时不处理');

console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);
