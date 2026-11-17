/* 离线蒸馏参数音库：用老师模型（VITS Theresa）把每个带调音节读一遍，
 * 裁剪成 16 kHz 单声道 PCM，写进 <TTS_DIR>/param/{bank.json,units.bin}。
 *
 * 跑法：
 *   node tools/distill-voice.js                 # 全部音节，可反复跑（断点续传）
 *   node tools/distill-voice.js --limit 200     # 先做一小批试听
 *   node tools/distill-voice.js --dry-run       # 只打印会生成多少单元
 *   node tools/distill-voice.js --force         # 清空重来
 *
 * 依赖：模型商店里已装好「角色音色（VITS）」——sherpa 引擎 + vits-theresa 权重。
 * 产物只进 TTS_DIR，不入库；运行时由 plugins/runtime/tts-param.js 直接读取。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { wavInfo } = require('../plugins/runtime/tts-prosody');

const TARGET_RATE = 16000;
const MAX_UNIT_SECONDS = 1.2;
const MARGIN_SECONDS = 0.025;
const FADE_SECONDS = 0.005;

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (!v || v.indexOf('--') === 0) return true;
  return v;
}
function has(name) { return process.argv.indexOf('--' + name) >= 0; }

function ttsDir() {
  if (process.env.TTS_DIR) return process.env.TTS_DIR;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Open AGI', 'tts');
}

function findOne(dir, re) {
  try { return fs.readdirSync(dir).filter(n => re.test(n))[0] || ''; } catch (e) { return ''; }
}

function resolveEngine(root) {
  const exe = path.join(root, 'sherpa', 'bin', 'sherpa-onnx-offline-tts.exe');
  const vitsDir = path.join(root, 'vits-theresa');
  const model = findOne(vitsDir, /\.onnx$/i);
  const tokens = path.join(vitsDir, 'tokens.txt');
  const lexicon = path.join(vitsDir, 'lexicon.txt');
  const missing = [];
  if (!fs.existsSync(exe)) missing.push('sherpa 引擎（' + exe + '）');
  if (!model) missing.push('VITS 权重（' + vitsDir + '/*.onnx）');
  if (!fs.existsSync(tokens)) missing.push('tokens.txt');
  if (!fs.existsSync(lexicon)) missing.push('lexicon.txt');
  if (missing.length) {
    console.error('缺少蒸馏所需的老师模型：\n  - ' + missing.join('\n  - '));
    console.error('请先在模型商店下载「角色音色 · VITS」，再重新运行。');
    process.exit(2);
  }
  let fsts = '';
  try {
    fsts = fs.readdirSync(vitsDir).filter(f => /\.fst$/i.test(f)).sort()
      .map(f => path.join(vitsDir, f)).join(',');
  } catch (e) { fsts = ''; }
  return {
    exe: exe,
    cwd: path.dirname(exe),
    vitsDir: vitsDir,
    model: path.join(vitsDir, model),
    tokens: tokens,
    lexicon: lexicon,
    fsts: fsts
  };
}

/* 从 lexicon 抽「单字 → 带调音节」。多字词条、标点、英文条目都跳过。 */
function readLexicon(file) {
  const map = new Map();
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (e) { lines = []; }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.charAt(0) === '#') continue;
    const m = line.split(/\s+/);
    if (m.length < 2) continue;
    const ch = m[0];
    if (!/^[\u3400-\u9fff]$/.test(ch)) continue;
    const syl = m[1].toLowerCase();
    if (!/^[a-zü:]+[1-5]?$/.test(syl)) continue;
    if (!map.has(ch)) map.set(ch, syl);
  }
  return map;
}

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: cwd, windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} reject(new Error('超时')); }, timeoutMs || 60000);
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('引擎退出码 ' + code + (err ? '：' + err.slice(-300) : '')));
    });
  });
}

function toMono16(buf) {
  const info = wavInfo(buf);
  const { fmt, data, blockAlign } = info;
  const frames = Math.floor(data.length / blockAlign);
  const ch = fmt.ch;
  const out = new Float32Array(frames);
  if (fmt.bits === 16) {
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += data.readInt16LE(i * blockAlign + c * 2);
      out[i] = s / ch / 32768;
    }
  } else if (fmt.bits === 8) {
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < ch; c++) s += data[i * blockAlign + c] - 128;
      out[i] = s / ch / 128;
    }
  } else {
    throw new Error('不支持的位深 ' + fmt.bits);
  }
  return { samples: out, rate: fmt.rate };
}

function resampleTo(src, from, to) {
  if (from === to) return src;
  const n = Math.max(1, Math.round(src.length * to / from));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * from / to;
    const i0 = Math.floor(p);
    const f = p - i0;
    out[i] = (src[i0] || 0) * (1 - f) + (src[Math.min(i0 + 1, src.length - 1)] || 0) * f;
  }
  return out;
}

/* 去掉首尾静音：按 10ms 帧找最后一个明显有声帧，再留 25ms 余量。 */
function trim(src, rate) {
  const frame = Math.max(1, Math.round(rate * 0.01));
  let first = -1;
  let last = -1;
  for (let i = 0; i + frame <= src.length; i += frame) {
    let peak = 0;
    for (let j = 0; j < frame; j++) {
      const v = Math.abs(src[i + j]);
      if (v > peak) peak = v;
    }
    if (peak > 0.012) {
      if (first < 0) first = i;
      last = i + frame;
    }
  }
  if (first < 0) return new Float32Array(0);
  const margin = Math.round(rate * MARGIN_SECONDS);
  const start = Math.max(0, first - margin);
  const end = Math.min(src.length, last + margin);
  return src.subarray(start, end);
}

/* 基频中位数：只取能量足够的帧，避免气声把 f0 拉到很低。 */
function estimateF0(src, rate) {
  const frame = Math.round(rate * 0.04);
  const hop = Math.round(frame / 2);
  const minLag = Math.round(rate / 500);
  const maxLag = Math.round(rate / 60);
  const found = [];
  for (let start = 0; start + frame <= src.length; start += hop) {
    let rms = 0;
    for (let i = 0; i < frame; i++) rms += src[start + i] * src[start + i];
    rms = Math.sqrt(rms / frame);
    if (rms < 0.02) continue;
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < frame; i++) sum += src[start + i] * src[start + i + lag];
      if (sum > best) { best = sum; bestLag = lag; }
    }
    if (bestLag > 0) found.push(rate / bestLag);
  }
  if (!found.length) return 0;
  found.sort((a, b) => a - b);
  return Math.round(found[found.length >> 1] * 10) / 10;
}

function appendPcm(file, samples) {
  const all = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) all[i] = Math.max(-1, Math.min(1, samples[i]));
  const buf = Buffer.alloc(all.length * 2);
  for (let i = 0; i < all.length; i++) buf.writeInt16LE(Math.round(all[i] * 32767), i * 2);
  fs.appendFileSync(file, buf);
  return all.length;
}

function writeBank(file, data) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
}

async function main() {
  const root = String(arg('tts-dir', ttsDir()));
  const outDir = path.join(root, 'param');
  const bankFile = path.join(outDir, 'bank.json');
  const pcmFile = path.join(outDir, 'units.bin');
  const limit = Math.max(0, Number(arg('limit', 0)) || 0);
  const force = has('force');
  const dry = has('dry-run');

  const eng = resolveEngine(root);
  const charMap = readLexicon(eng.lexicon);
  if (!charMap.size) {
    console.error('lexicon 里没有解析出单字读音：' + eng.lexicon);
    process.exit(2);
  }

  /* 每个带调音节只蒸馏一次：选 lexicon 里第一次出现的字作为发音示例。 */
  const examples = new Map();
  charMap.forEach((syl, ch) => { if (!examples.has(syl)) examples.set(syl, ch); });
  let syllables = Array.from(examples.keys()).sort();
  if (limit) syllables = syllables.slice(0, limit);

  console.log('老师模型：' + eng.model);
  console.log('单字 ' + charMap.size + ' 个 → 带调音节 ' + examples.size + ' 个' +
    (limit ? '，本次只做前 ' + limit + ' 个' : ''));
  if (dry) {
    console.log('dry-run：不会启动合成。输出目录 ' + outDir);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  let bank = { v: 1, rate: TARGET_RATE, source: 'vits-theresa', units: {}, chars: {} };
  if (!force && fs.existsSync(bankFile) && fs.existsSync(pcmFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(bankFile, 'utf8'));
      if (old && old.v === 1 && Number(old.rate) === TARGET_RATE && old.units) {
        bank.units = old.units;
        bank.chars = old.chars || {};
        const pcmSize = fs.statSync(pcmFile).size;
        /* 索引里超出 PCM 长度的单元是上次中断的残片，丢掉重做 */
        Object.keys(bank.units).forEach(k => {
          const u = bank.units[k];
          if (!u || (Number(u.o) + Number(u.n)) * 2 > pcmSize) delete bank.units[k];
        });
        console.log('断点续传：已有 ' + Object.keys(bank.units).length + ' 个单元');
      }
    } catch (e) { /* 索引坏了就从头来 */ }
  }
  if (!fs.existsSync(pcmFile)) fs.writeFileSync(pcmFile, Buffer.alloc(0));
  if (force) fs.writeFileSync(pcmFile, Buffer.alloc(0));

  const threads = Math.max(1, Math.min(4, (os.cpus() || []).length || 2));
  let done = 0;
  let added = 0;
  const todo = syllables.filter(s => !bank.units[s]);
  console.log('待合成 ' + todo.length + ' 个音节；每个约 0.3 秒音频。\n');

  for (let i = 0; i < todo.length; i++) {
    const syl = todo[i];
    const ch = examples.get(syl);
    const tmp = path.join(os.tmpdir(), 'openagi-distill-' + process.pid + '-' + i + '.wav');
    const args = [
      '--vits-model=' + eng.model,
      '--vits-lexicon=' + eng.lexicon,
      '--vits-tokens=' + eng.tokens,
      '--vits-length-scale=1.0',
      '--num-threads=' + threads,
      '--output-filename=' + tmp,
      ch
    ];
    if (eng.fsts) args.splice(4, 0, '--tts-rule-fsts=' + eng.fsts);
    try {
      await run(eng.exe, args, eng.cwd, 60000);
      const raw = toMono16(fs.readFileSync(tmp));
      let pcm = resampleTo(raw.samples, raw.rate, TARGET_RATE);
      pcm = trim(pcm, TARGET_RATE);
      const cap = Math.round(TARGET_RATE * MAX_UNIT_SECONDS);
      if (pcm.length > cap) pcm = pcm.subarray(0, cap);
      if (pcm.length < Math.round(TARGET_RATE * 0.05)) throw new Error('合成结果太短');
      const f0 = estimateF0(pcm, TARGET_RATE);
      const fade = Math.min(Math.round(TARGET_RATE * FADE_SECONDS), pcm.length >> 1);
      for (let j = 0; j < fade; j++) {
        const g = j / fade;
        pcm[j] *= g;
        pcm[pcm.length - 1 - j] *= g;
      }
      const offset = fs.statSync(pcmFile).size / 2;
      const n = appendPcm(pcmFile, pcm);
      bank.units[syl] = { o: offset, n: n, f0: f0 };
      added++;
    } catch (e) {
      console.error('  ✗ ' + syl + '（' + ch + '）：' + e.message);
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* 已删 */ }
    }
    done++;
    if (done % 20 === 0 || done === todo.length) {
      console.log('  ' + done + ' / ' + todo.length + '，新增 ' + added + ' 个单元');
      writeBank(bankFile, bank);
    }
  }

  /* 只把真的有单元的字写进映射，避免运行时查到空单元 */
  bank.chars = {};
  charMap.forEach((syl, ch) => { if (bank.units[syl]) bank.chars[ch] = syl; });
  writeBank(bankFile, bank);

  const bytes = fs.statSync(pcmFile).size;
  console.log('\n完成：' + Object.keys(bank.units).length + ' 个音节，' +
    Object.keys(bank.chars).length + ' 个单字，PCM ' + (bytes / 1048576).toFixed(1) + ' MB');
  console.log('输出目录：' + outDir);
  console.log('在数字人语音面板点一次「检测」，音色里就会出现「参数合成 · 快问快答」。');
}

main().catch(e => {
  console.error('蒸馏失败：' + ((e && e.message) || e));
  process.exit(1);
});
