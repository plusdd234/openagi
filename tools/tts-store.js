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

  /* ---- MeloTTS 共享模型（与 Kokoro 共用引擎，模型独立） ---- */
  const m0 = TTS.meloStatus(userData);
  eq(m0.ok, true, 'MeloTTS 状态查询不因缺文件报错');
  eq(m0.installed, false, '没下载时 MeloTTS installed=false');
  ok(/melo$/.test(TTS.meloDir(userData)), 'MeloTTS 模型落在固定 melo 目录');

  fs.mkdirSync(path.dirname(TTS.kokoroExe(userData)), { recursive: true });
  fs.writeFileSync(TTS.kokoroExe(userData), 'x');
  const md = TTS.meloDir(userData);
  fs.mkdirSync(md, { recursive: true });
  fs.writeFileSync(path.join(md, 'model.onnx'), 'x');
  fs.writeFileSync(path.join(md, 'tokens.txt'), 'x');
  eq(TTS.meloStatus(userData).installed, false, 'MeloTTS 少 lexicon.txt 时不算就绪');
  fs.writeFileSync(path.join(md, 'lexicon.txt'), 'x');
  eq(TTS.meloStatus(userData).installed, true, 'MeloTTS 引擎 + 三个模型文件齐全时 installed=true');

  /* 装了 Melo 时卸载 Kokoro 不能把共享引擎一起删掉 */
  fs.mkdirSync(TTS.kokoroDir(userData), { recursive: true });
  fs.writeFileSync(path.join(TTS.kokoroDir(userData), 'model.int8.onnx'), 'x');
  fs.writeFileSync(path.join(TTS.kokoroDir(userData), 'voices.bin'), 'x');
  fs.writeFileSync(path.join(TTS.kokoroDir(userData), 'tokens.txt'), 'x');
  await TTS.removeKokoro(userData);
  ok(fs.existsSync(TTS.kokoroExe(userData)), '还有 MeloTTS 在用引擎时不删 sherpa');
  eq(TTS.meloStatus(userData).installed, true, '卸载 Kokoro 不影响 MeloTTS');

  await TTS.removeMelo(userData);
  ok(!fs.existsSync(md), '卸载删除 MeloTTS 模型目录');
  ok(!fs.existsSync(path.join(userData, 'tts', 'sherpa')), '没有其它共享模型时才删引擎');
  eq(TTS.meloStatus(userData).installed, false, '卸载 MeloTTS 后回到未就绪');

  /* ---- ZipVoice 声音克隆：模型齐全 ≠ 克隆可用，还要参考录音与文本 ---- */
  fs.mkdirSync(path.dirname(TTS.kokoroExe(userData)), { recursive: true });
  fs.writeFileSync(TTS.kokoroExe(userData), 'x');
  const zd = TTS.zipvoiceDir(userData);
  fs.mkdirSync(zd, { recursive: true });
  fs.writeFileSync(path.join(zd, 'encoder.int8.onnx'), 'x');
  fs.writeFileSync(path.join(zd, 'decoder.int8.onnx'), 'x');
  fs.writeFileSync(path.join(zd, 'tokens.txt'), 'x');
  fs.writeFileSync(path.join(zd, 'lexicon.txt'), 'x');
  const z0 = TTS.zipvoiceStatus(userData);
  eq(z0.installed, false, 'ZipVoice 缺声码器时不算装好');
  fs.writeFileSync(path.join(zd, 'vocos_24khz.onnx'), 'x');
  const z1 = TTS.zipvoiceStatus(userData);
  eq(z1.installed, true, 'ZipVoice 模型与声码器齐全时 installed=true');
  eq(z1.clone, false, '没有参考录音时 clone=false');

  const wav = path.join(userData, 'ref-source.wav');
  fs.writeFileSync(wav, 'RIFF');
  let zerr = '';
  try{ await TTS.setReference(userData, { source: path.join(userData, 'ref.mp3'), text: '你好' }); }
  catch(e){ zerr = String(e.message || e); }
  ok(/WAV/.test(zerr), '参考音频只接受 WAV', zerr);

  const z2 = await TTS.setReference(userData, { source: wav, text: '这是我的声音样本。' });
  eq(z2.clone, true, '参考音频 + 文本齐全后 clone=true');
  eq(z2.referenceText, '这是我的声音样本。', '参考文本写入 status，设置页可回填');
  ok(fs.existsSync(TTS.referenceAudio(userData)), '参考音频复制到固定 ref.wav');

  const z3 = await TTS.removeReference(userData);
  eq(z3.clone, false, '清除参考录音后 clone=false');
  ok(!fs.existsSync(TTS.referenceAudio(userData)), '清除会删掉 ref.wav');

  await TTS.removeZipvoice(userData);
  ok(!fs.existsSync(zd), '卸载删除 ZipVoice 模型目录');
  eq(TTS.zipvoiceStatus(userData).installed, false, '卸载 ZipVoice 后回到未就绪');

  /* ---- 角色音色 VITS（共享引擎，模型文件名随模型变化） ---- */
  fs.mkdirSync(path.dirname(TTS.kokoroExe(userData)), { recursive: true });
  fs.writeFileSync(TTS.kokoroExe(userData), 'x');
  const vd = TTS.vitsDir(userData);
  ok(/vits-theresa$/.test(vd), '角色音色模型落在固定 vits-theresa 目录');
  eq(TTS.vitsStatus(userData).installed, false, '没下载时角色音色 installed=false');
  fs.mkdirSync(vd, { recursive: true });
  fs.writeFileSync(path.join(vd, 'theresa.onnx'), 'x');
  fs.writeFileSync(path.join(vd, 'tokens.txt'), 'x');
  eq(TTS.vitsStatus(userData).installed, false, '角色音色少 lexicon.txt 时不算就绪');
  fs.writeFileSync(path.join(vd, 'lexicon.txt'), 'x');
  eq(TTS.vitsStatus(userData).installed, true, 'onnx + tokens + lexicon 齐全时 installed=true');
  ok(/theresa\.onnx$/.test(TTS.vitsModelFile(userData)), '模型文件名按目录里的 *.onnx 取');

  /* 装了角色音色时卸载 MeloTTS 不能把共享引擎一起删掉 */
  fs.mkdirSync(md, { recursive: true });
  fs.writeFileSync(path.join(md, 'model.onnx'), 'x');
  fs.writeFileSync(path.join(md, 'tokens.txt'), 'x');
  fs.writeFileSync(path.join(md, 'lexicon.txt'), 'x');
  await TTS.removeVits(userData);
  ok(!fs.existsSync(vd), '卸载删除角色音色模型目录');
  ok(fs.existsSync(TTS.kokoroExe(userData)), '还有 MeloTTS 在用引擎时不删 sherpa');
  eq(TTS.meloStatus(userData).installed, true, '卸载角色音色不影响 MeloTTS');
  await TTS.removeMelo(userData);
  ok(!fs.existsSync(path.join(userData, 'tts', 'sherpa')), '角色音色与 Melo 都卸载后才删引擎');
  eq(TTS.vitsStatus(userData).installed, false, '卸载角色音色后回到未就绪');

  fs.rmSync(userData, { recursive: true, force: true });
  console.log('\n结果：' + pass + ' / ' + (pass + fail) + ' 通过');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
