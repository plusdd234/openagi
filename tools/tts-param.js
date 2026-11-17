/* 参数合成引擎的纯逻辑测试：音库读取、拼接、停顿、PSOLA 变调、缓存与坏索引。
 * 用临时目录里现造的 2 个正弦单元，不依赖真实蒸馏产物。
 *
 * 跑法：node tools/tts-param.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { paramStatus, synth, clearCache } = require('../plugins/runtime/tts-param');

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}
function near(a, b, tol, name) {
  ok(Math.abs(a - b) <= tol, name, 'got=' + a + ' want≈' + b + ' ±' + tol);
}

const RATE = 16000;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-param-'));

function sine(hz, seconds, amp) {
  const n = Math.round(RATE * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * hz * i / RATE) * (amp || 0.45);
  return out;
}

function writeBank(units, chars, extra) {
  const chunks = [];
  const index = {};
  let offset = 0;
  Object.keys(units).forEach(k => {
    const u = units[k];
    index[k] = { o: offset, n: u.samples.length, f0: u.f0 };
    chunks.push(u.samples);
    offset += u.samples.length;
  });
  const pcm = Buffer.alloc(offset * 2);
  let p = 0;
  chunks.forEach(c => {
    for (let i = 0; i < c.length; i++) {
      pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, c[i])) * 32767), p);
      p += 2;
    }
  });
  fs.writeFileSync(path.join(DIR, 'units.bin'), pcm);
  fs.writeFileSync(path.join(DIR, 'bank.json'), JSON.stringify(Object.assign({
    v: 1, rate: RATE, source: 'test', units: index, chars: chars
  }, extra || {})));
  clearCache();
}

function wavData(buf) {
  return {
    rate: buf.readUInt32LE(24),
    ch: buf.readUInt16LE(22),
    bits: buf.readUInt16LE(34),
    len: buf.readUInt32LE(40),
    data: buf.subarray(44, 44 + buf.readUInt32LE(40))
  };
}

function zeroCrossings(data) {
  let n = 0;
  let prev = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    const v = data.readInt16LE(i);
    if ((v >= 0) !== (prev >= 0)) n++;
    prev = v;
  }
  return n;
}

function peak(data) {
  let m = 0;
  for (let i = 0; i + 1 < data.length; i += 2) {
    const v = Math.abs(data.readInt16LE(i));
    if (v > m) m = v;
  }
  return m;
}

console.log('=== 音库状态 ===');
writeBank(
  { ni3: { samples: sine(120, 0.25), f0: 120 }, hao3: { samples: sine(180, 0.25), f0: 180 } },
  { '你': 'ni3', '好': 'hao3' }
);
let st = paramStatus(DIR);
eq(st.ready, true, '音库就绪');
eq(st.units, 2, '单元数');
eq(st.chars, 2, '单字数');
eq(st.rate, RATE, '采样率');
eq(paramStatus('').units, 0, '空目录单元数为 0');
eq(paramStatus('').ready, false, '空目录未就绪');

console.log('\n=== 基本合成 ===');
let wav = synth('你好', { dir: DIR });
ok(Buffer.isBuffer(wav), '返回 Buffer');
eq(wav.toString('ascii', 0, 4), 'RIFF', 'WAV 头正确');
let d = wavData(wav);
eq(d.rate, RATE, '采样率沿用音库');
eq(d.ch, 1, '单声道');
eq(d.bits, 16, '16-bit');
ok(d.len > RATE * 0.4 * 2, '两个 0.25s 单元 + 间隔', 'len=' + d.len);
eq(synth('', { dir: DIR }), null, '空文本返回 null');
eq(synth('你好', { dir: path.join(DIR, 'nope') }), null, '没有音库返回 null');

console.log('\n=== 语速 / 停顿 ===');
const normal = wavData(synth('你好', { dir: DIR }));
const slow = wavData(synth('[[r=0.8]]你好', { dir: DIR }));
ok(slow.len > normal.len * 1.15, '放慢后音频更长', normal.len + ' → ' + slow.len);
const pause = wavData(synth('你好[[p=0.5]]', { dir: DIR }));
near((pause.len - normal.len) / 2 / RATE, 0.5, 0.03, '停顿标记额外增加 0.5 秒');

console.log('\n=== PSOLA 变调 / 重音 ===');
const low = wavData(synth('你', { dir: DIR }));
const high = wavData(synth('[[f=1.4]]你', { dir: DIR }));
ok(zeroCrossings(high.data) > zeroCrossings(low.data) * 1.2,
  '音调提高后过零次数明显增加', zeroCrossings(low.data) + ' → ' + zeroCrossings(high.data));
const plain = wavData(synth('你', { dir: DIR }));
const loud = wavData(synth('[[e=1.3]]你', { dir: DIR }));
ok(peak(loud.data) > peak(plain.data) * 1.1,
  '重音提高峰值', peak(plain.data) + ' → ' + peak(loud.data));

console.log('\n=== 缓存与坏索引 ===');
const a = synth('你好', { dir: DIR });
const b = synth('你好', { dir: DIR });
ok(a === b, '相同请求命中缓存（同一 Buffer）');
fs.writeFileSync(path.join(DIR, 'bank.json'), '{ bad json');
clearCache();
eq(paramStatus(DIR).ready, false, '坏索引报告未就绪');
let threw = false;
try { synth('你好', { dir: DIR }); } catch (e) { threw = true; }
ok(threw, '坏索引合成时抛错');

fs.rmSync(DIR, { recursive: true, force: true });
console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);
