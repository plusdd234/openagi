/* 本地语音商店（主进程）纯逻辑测试：不联网、不启动 piper。
 *
 * 只守三件事：
 *   ① 清单以磁盘为准（voices/*.onnx），不依赖引擎在跑；
 *   ② 文件名一律 basename，`../` 不能越出 voices/；
 *   ③ 缺地址 / 缺文件名时立刻报错，不进入下载流程。
 *
 * 跑法：node tools/tts-store.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const TTS = require('../electron/tts-store');

let pass = 0;
let fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(a, b, name){
  ok(a === b, name, 'got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b));
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'openagi-tts-'));
  const voices = TTS.voicesDir(userData);

  /* ---- 空目录 ---- */
  const empty = await TTS.list(userData);
  eq(empty.ok, true, '空目录也能列清单');
  eq(empty.engine, false, '没有 piper.exe 时 engine=false');
  eq(empty.voices.length, 0, '空目录没有音色');

  /* ---- 路径安全 ---- */
  eq(TTS.safeName('../evil.onnx'), 'evil.onnx', 'basename 掉 ../');
  eq(TTS.safeName('a/b/c.onnx'), 'c.onnx', 'basename 掉子目录');
  eq(TTS.safeName('..'), '', '.. 直接拒绝');
  eq(TTS.safeName(''), '', '空文件名拒绝');

  /* ---- 非法请求不进入下载 ---- */
  let err = '';
  try{ await TTS.install(userData, { voiceFile: '../evil.onnx', urls: ['https://example.com/a.onnx'] }, {}); }
  catch(e){ err = String(e.message || e); }
  ok(/不合法/.test(err), '带路径的音色文件名被拒绝', err);

  err = '';
  try{ await TTS.install(userData, { voiceFile: 'ok.onnx', urls: [] }, {}); }
  catch(e){ err = String(e.message || e); }
  ok(/下载地址/.test(err), '缺下载地址立即报错（不发起网络请求）', err);

  /* ---- 清单与删除 ---- */
  fs.mkdirSync(voices, { recursive: true });
  fs.writeFileSync(path.join(voices, 'zh_CN-test.onnx'), 'x');
  fs.writeFileSync(path.join(voices, 'zh_CN-test.onnx.json'), '{}');
  fs.writeFileSync(path.join(voices, 'notes.txt'), 'not a voice');
  const outside = path.join(userData, 'outside.onnx');
  fs.writeFileSync(outside, 'keep me');

  const list = await TTS.list(userData);
  eq(list.voices.length, 1, '只把 .onnx 当音色');
  eq(list.voices[0].file, 'zh_CN-test.onnx', '清单文件名正确');
  eq(list.voices[0].json, true, '能识别同名的 .onnx.json 配置');

  await TTS.remove(userData, { voiceFile: 'zh_CN-test.onnx', voiceJson: 'zh_CN-test.onnx.json' });
  ok(!fs.existsSync(path.join(voices, 'zh_CN-test.onnx')), '卸载删掉权重');
  ok(!fs.existsSync(path.join(voices, 'zh_CN-test.onnx.json')), '卸载删掉配置');
  ok(fs.existsSync(path.join(voices, 'notes.txt')), '不误删非音色文件');

  await TTS.remove(userData, { voiceFile: '../outside.onnx' });
  ok(fs.existsSync(outside), '带 ../ 的删除请求不能删到 voices/ 之外');

  const after = await TTS.list(userData);
  eq(after.voices.length, 0, '删除后清单为空');

  /* ---- Kokoro 共享模型（只验磁盘判定，不联网） ---- */
  const k0 = TTS.kokoroStatus(userData);
  eq(k0.ok, true, 'Kokoro 状态查询不因缺文件报错');
  eq(k0.installed, false, '没下载时 installed=false');
  eq(k0.engine, false, '缺 sherpa 引擎时 engine=false');
  eq(k0.model, false, '缺模型时分项 model=false');
  ok(/kokoro$/.test(TTS.kokoroDir(userData)), 'Kokoro 模型落在固定 kokoro 目录');
  ok(/sherpa[\\/]bin[\\/]sherpa-onnx-offline-tts\.exe$/.test(TTS.kokoroExe(userData)), '引擎可执行文件路径固定');

  /* 三个文件缺一不可：少 tokens.txt 仍然算未就绪 */
  const kd = TTS.kokoroDir(userData);
  fs.mkdirSync(path.dirname(TTS.kokoroExe(userData)), { recursive: true });
  fs.writeFileSync(TTS.kokoroExe(userData), 'x');
  fs.mkdirSync(kd, { recursive: true });
  fs.writeFileSync(path.join(kd, 'model.int8.onnx'), 'x');
  fs.writeFileSync(path.join(kd, 'voices.bin'), 'x');
  const k1 = TTS.kokoroStatus(userData);
  eq(k1.engine, true, 'exe 存在时 engine=true');
  eq(k1.installed, false, '少 tokens.txt 时不算就绪');
  fs.writeFileSync(path.join(kd, 'tokens.txt'), 'x');
  const k2 = TTS.kokoroStatus(userData);
  eq(k2.installed, true, '引擎 + 三个模型文件齐全时 installed=true');

  await TTS.removeKokoro(userData);
  ok(!fs.existsSync(kd), '卸载删除 Kokoro 模型目录');
  ok(!fs.existsSync(path.join(userData, 'tts', 'sherpa')), '卸载删除共享引擎目录');
  eq(TTS.kokoroStatus(userData).installed, false, '卸载后回到未就绪');

  fs.rmSync(userData, { recursive: true, force: true });
  console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
