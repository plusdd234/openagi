/* 朗读韵律标记的纯逻辑测试：解析规则 + WAV 拼接。
 *
 * 跑法：node tools/tts-prosody.js
 */
'use strict';

const { parseProsody, stripProsody, concatWavs } = require('../plugins/runtime/tts-prosody');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){
  ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}

/* 生成 16-bit 单声道 PCM WAV，samples 为 -1~1 */
function makeWav(samples, rate){
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
function dataOf(buf){
  return buf.subarray(44, 44 + buf.readUInt32LE(40));
}

console.log('=== 标记解析 ===');
let p = parseProsody('你好，今天过得怎么样？', 1);
eq(p.used, false, '没有标记时 used=false');
eq(p.segments.length, 1, '没有标记时只有一段');
eq(p.segments[0].rate, 1, '默认语速为 1');
eq(p.lead, 0, '没有开头静音');

p = parseProsody('你好[[p=0.4]]啊', 1);
eq(p.used, true, '认出停顿标记');
eq(p.segments.length, 2, '停顿把文本切成两段');
eq(p.segments[0].text, '你好', '第一段文本正确', p.segments[0].text);
eq(p.segments[0].after, 0.4, '停顿挂在第一段之后');
eq(p.segments[1].text, '啊', '第二段文本正确');

p = parseProsody('[[p=0.5]]你好', 1);
eq(p.lead, 0.5, '文本前的停顿变成开头静音');
eq(p.segments.length, 1, '开头静音不产生空段');

p = parseProsody('你好[[r=0.8]]啊[[t=0.3]]', 1);
eq(p.segments.length, 2, '语速变化切段');
eq(p.segments[0].rate, 1, '语速变化前的段保持原速');
eq(p.segments[1].rate, 0.8, '语速变化后的段使用新速度');
eq(p.segments[1].after, 0.3, '句尾拖音挂到最后一段');

p = parseProsody('你好[[rate=1.2]][[pause=0.2]]啊', 1);
eq(p.segments[1].rate, 1.2, '长写法 rate 生效');
eq(p.segments[0].after, 0.2, '长写法 pause 生效');

p = parseProsody('慢一点[[r=9]]快一点', 1);
eq(p.segments[1].rate, 1.4, '语速上限钳到 1.4');
p = parseProsody('慢一点[[r=0.1]]快一点', 1);
eq(p.segments[1].rate, 0.7, '语速下限钳到 0.7');
p = parseProsody('停一下[[p=99]]继续', 1);
ok(p.segments[0].after <= 2, '停顿上限不超过 2 秒', p.segments[0].after);

p = parseProsody('你好[[x=1]]啊', 1);
eq(p.segments.length, 1, '未知标记不切段');
eq(p.segments[0].text, '你好啊', '未知标记从文本里剥掉');
eq(stripProsody('你好[[p=0.4]]啊'), '你好啊', 'stripProsody 去掉标记');

p = parseProsody('[[r=0.9]][[p=0.2]]你好', 1);
eq(p.segments.length, 1, '开头连续标记不产生空段');
eq(p.segments[0].rate, 0.9, '开头语速标记生效');
eq(p.lead, 0.2, '文本前的停顿变成开头静音');
eq(p.segments[0].after, 0, '开头静音不会重复挂到段尾');

console.log('\n=== 音调 / 重音参数 ===');
p = parseProsody('你好[[f=1.3]]啊[[e=1.4]]吧', 1);
eq(p.segments.length, 3, '音调 / 重音变化都会切段');
eq(p.segments[0].pitch, 1, '音调标记前的段保持 1');
eq(p.segments[1].pitch, 1.3, '音调标记生效');
eq(p.segments[2].gain, 1.4, '重音标记对之后的话生效');
p = parseProsody('[[pitch=1.2]]你好', 1);
eq(p.segments[0].pitch, 1.2, '长写法 pitch 生效');
p = parseProsody('[[gain=1.3]]你好', 1);
eq(p.segments[0].gain, 1.3, '长写法 gain 生效');
p = parseProsody('你好[[f=9]]啊', 1);
eq(p.segments[1].pitch, 1.5, '音调上限钳到 1.5');
p = parseProsody('你好[[f=0.1]]啊', 1);
eq(p.segments[1].pitch, 0.7, '音调下限钳到 0.7');
p = parseProsody('你好[[e=9]]啊', 1);
eq(p.segments[1].gain, 1.5, '重音上限钳到 1.5');
p = parseProsody('你好[[e=0.1]]啊', 1);
eq(p.segments[1].gain, 0.8, '重音下限钳到 0.8');

console.log('\n=== WAV 拼接 ===');
const a = makeWav(new Array(100).fill(0.5), 1000);   // 0.1s
const b = makeWav(new Array(50).fill(-0.5), 1000);   // 0.05s
const out = concatWavs([{ buf: a, after: 0.1 }, { buf: b, after: 0 }], 0.05);
eq(out.toString('ascii', 0, 4), 'RIFF', '输出是 RIFF');
eq(out.readUInt32LE(24), 1000, '采样率沿用第一段');
eq(out.readUInt32LE(40), 100 * 2 + 100 * 2 + 50 * 2 + 50 * 2, 'data 长度 = 开头静音 + 两段 + 中间静音');
const d = dataOf(out);
eq(d.readInt16LE(0), 0, '开头静音是 0');
eq(d.readInt16LE(50 * 2), Math.round(0.5 * 32767), '第一段在开头静音之后');
eq(d.readInt16LE((50 + 100 + 100) * 2), Math.round(-0.5 * 32767), '第二段在中间静音之后');

let threw = false;
try { concatWavs([{ buf: a, after: 0 }, { buf: makeWav([0.1], 22050), after: 0 }], 0); } catch (e) { threw = true; }
ok(threw, '采样率不一致时拒绝拼接');

threw = false;
try { concatWavs([], 0); } catch (e) { threw = true; }
ok(threw, '空列表拒绝拼接');

console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
process.exit(fail ? 1 : 0);
