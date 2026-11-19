/* 参数合成引擎：运行时不加载任何神经网络，只读一份「蒸馏音库」。
 *
 * 思路：
 *   · 老师模型（VITS Theresa）离线把每个带调音节读一遍，裁剪、归一化后存成
 *     16-bit PCM 单元（tools/distill-voice.js 生成）；
 *   · 运行时把文字拆成音节 → 查音库 → 用 TD-PSOLA 改时长 / 音调 → 按标点与
 *     LLM 的 [[r]]/[[p]]/[[f]]/[[e]]/[[t]] 参数拼成 WAV；
 *   · 不启动子进程、不加载 onnx，短句合成只有几毫秒，适合快问快答。
 *
 * 音库目录（runtime 解析：用户 <TTS_DIR>/param 优先，其次随包内置的 runtime/param-bank）：
 *   bank.json  { v:1, rate:16000, source:"vits-theresa", units:{ ni3:{o,n,f0} }, chars:{ 你:"ni3" } }
 *   units.bin  所有单元首尾相接的 int16 LE 单声道 PCM；o/n 是采样点偏移与长度。
 *
 * 找不到音库时返回 null，由调用方退回原有神经引擎；音库损坏才抛错。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseProsody } = require('./tts-prosody');

const BANK_JSON = 'bank.json';
const BANK_PCM = 'units.bin';
const MAX_SECONDS = 45;
const MAX_CACHE = 64;
/* 单元是老师「孤立读一个字」录的，自带句末拉长：音库实测中位 0.365s，
 * 而自然语流里普通音节约 0.2s。不压缩就会一字一顿，所以默认收 25%。
 * 这是时长补偿，不是语速：用户/LLM 的 [[r=]] 仍在此之上缩放。 */
const UNIT_TIME = 0.75;
/* 自然语句的音高会从开头到结尾缓慢下倾；单元直接拼接没有这条曲线，
 * 整句听起来像逐条列读。全程最多降 6%，正好落在自然下倾的量级。 */
const DECLINATION = 0.06;

/* 标点自带的基础停顿（秒）；LLM 的 [[p=]] 是在此之上额外追加。 */
const PUNCT_PAUSE = {
  '，': 0.16, ',': 0.14, '、': 0.10,
  '。': 0.26, '.': 0.22, '！': 0.28, '!': 0.26, '？': 0.28, '?': 0.26,
  '；': 0.20, ';': 0.18, '：': 0.18, ':': 0.16,
  '…': 0.30, '—': 0.12, '·': 0.10
};

let bankCache = null;   // { dir, key, bank }
let wavCache = new Map(); // key → Buffer

function clamp(n, a, b) {
  n = Number(n);
  if (!isFinite(n)) return a;
  return n < a ? a : (n > b ? b : n);
}

function bankPath(dir) {
  return path.join(String(dir || ''), BANK_JSON);
}

function pcmPath(dir) {
  return path.join(String(dir || ''), BANK_PCM);
}

/* 只读索引，用来回答「音库装没装、有多少单元」，不把 PCM 读进内存。 */
function readMeta(dir) {
  const file = bankPath(dir);
  let st;
  try { st = fs.statSync(file); } catch (e) { return null; }
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    const err = new Error('参数音库索引损坏：' + e.message);
    err.code = 'BANK_CORRUPT';
    throw err;
  }
  if (!d || d.v !== 1 || !d.units || typeof d.units !== 'object') {
    const err = new Error('参数音库索引格式不认识');
    err.code = 'BANK_CORRUPT';
    throw err;
  }
  return { raw: d, mtime: Math.round(st.mtimeMs), size: st.size };
}

function paramStatus(dir) {
  if (!dir) return { ready: false, units: 0, chars: 0, rate: 0, source: '', dir: '' };
  let meta;
  try { meta = readMeta(dir); } catch (e) {
    return { ready: false, units: 0, chars: 0, rate: 0, source: '', dir: String(dir), error: e.message };
  }
  if (!meta) return { ready: false, units: 0, chars: 0, rate: 0, source: '', dir: String(dir) };
  let pcmOk = false;
  try { pcmOk = fs.statSync(pcmPath(dir)).size > 0; } catch (e) { pcmOk = false; }
  const units = Object.keys(meta.raw.units).length;
  return {
    ready: pcmOk && units > 0,
    units: units,
    chars: Object.keys(meta.raw.chars || {}).length,
    rate: Number(meta.raw.rate) || 0,
    source: String(meta.raw.source || ''),
    dir: String(dir),
    error: pcmOk ? '' : '参数音库缺少 units.bin'
  };
}

function loadBank(dir) {
  if (!dir) return null;
  const meta = readMeta(dir);
  if (!meta) return null;
  const key = meta.mtime + ':' + meta.size;
  if (bankCache && bankCache.dir === dir && bankCache.key === key) return bankCache.bank;

  const rate = Math.round(Number(meta.raw.rate) || 0);
  if (rate < 8000 || rate > 48000) {
    const err = new Error('参数音库采样率不合法：' + rate);
    err.code = 'BANK_CORRUPT';
    throw err;
  }
  const data = fs.readFileSync(pcmPath(dir));
  if (!data.length || data.length % 2) {
    const err = new Error('参数音库 PCM 数据为空或长度不是 16-bit 对齐');
    err.code = 'BANK_CORRUPT';
    throw err;
  }
  const bank = {
    dir: String(dir),
    rate: rate,
    source: String(meta.raw.source || ''),
    units: meta.raw.units,
    chars: meta.raw.chars && typeof meta.raw.chars === 'object' ? meta.raw.chars : {},
    data: data,
    key: key
  };
  bankCache = { dir: dir, key: key, bank: bank };
  return bank;
}

function unitKeyFor(bank, ch) {
  if (!ch) return '';
  if (bank.chars[ch]) return bank.chars[ch];
  if (bank.units[ch]) return ch;
  const lower = ch.toLowerCase();
  if (lower !== ch && bank.chars[lower]) return bank.chars[lower];
  if (bank.units[lower]) return lower;
  return '';
}

function readUnit(bank, key) {
  const u = bank.units[key];
  if (!u) return null;
  const off = Math.max(0, Math.round(Number(u.o) || 0));
  const n = Math.max(0, Math.round(Number(u.n) || 0));
  if (!n || off < 0 || (off + n) * 2 > bank.data.length) return null;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = bank.data.readInt16LE((off + i) * 2) / 32768;
  return { samples: out, f0: Number(u.f0) || 0 };
}

/* 线性插值重采样：factor = 输出长度 / 输入长度。 */
function resample(src, factor) {
  const n = Math.max(1, Math.round(src.length * factor));
  if (n === src.length) return src;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i / factor;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const a = src[i0] || 0;
    const b = src[Math.min(i0 + 1, src.length - 1)] || 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/* TD-PSOLA：按基频找周期，在输出侧改变周期长度（音调），同时按 durFactor
 * 改变读取速度（时长）。两个参数互不干扰，这是参数合成能「按字调」的关键。 */
function psola(src, sr, f0, durFactor, pitchFactor) {
  const nOut = Math.max(8, Math.round(src.length * durFactor));
  const Pa = sr / Math.max(50, Math.min(500, f0));
  if (!isFinite(Pa) || Pa < 8 || Pa > src.length / 2) {
    return resample(resample(src, pitchFactor), durFactor / pitchFactor);
  }
  const winLen = Math.max(8, Math.round(2 * Pa));
  const win = new Float32Array(winLen);
  for (let i = 0; i < winLen; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (winLen - 1));
  const out = new Float32Array(nOut);
  const wsum = new Float32Array(nOut);
  const hop = Math.max(2, Pa / pitchFactor);
  const half = winLen >> 1;
  let k = 0;
  for (let outPos = 0; outPos < nOut + half && k < 200000; k++) {
    const srcCenter = outPos / durFactor;
    const mark = Math.round(srcCenter / Pa) * Pa;
    const start = Math.round(mark) - half;
    for (let i = 0; i < winLen; i++) {
      const oi = outPos - half + i;
      if (oi < 0 || oi >= nOut) continue;
      const si = start + i;
      if (si < 0 || si >= src.length) continue;
      const w = win[i];
      out[oi] += src[si] * w;
      wsum[oi] += w;
    }
    outPos = Math.round((k + 1) * hop);
  }
  for (let i = 0; i < nOut; i++) {
    if (wsum[i] > 0.05) out[i] /= wsum[i];
  }
  return out;
}

function fadeEdges(buf, sr) {
  const n = Math.min(Math.round(sr * 0.003), buf.length >> 1);
  if (n < 2) return buf;
  for (let i = 0; i < n; i++) {
    const g = i / n;
    buf[i] *= g;
    buf[buf.length - 1 - i] *= g;
  }
  return buf;
}

/* 蒸馏时每个单元首尾各留了 25ms 静音余量；逐字拼接后这些余量会变成
 * 字与字之间 50ms 的空白，听感就是「断断续续」。播之前先按能量把静音剪掉，
 * 只留 6ms 保护音头，之后靠交叉淡化接缝。 */
function trimSilence(src, sr) {
  const frame = Math.max(1, Math.round(sr * 0.008));
  const thr = 0.012;
  let first = -1;
  let last = -1;
  for (let i = 0; i + frame <= src.length; i += frame) {
    let peak = 0;
    for (let j = 0; j < frame; j++) {
      const v = Math.abs(src[i + j]);
      if (v > peak) peak = v;
    }
    if (peak > thr) {
      if (first < 0) first = i;
      last = i + frame;
    }
  }
  if (first < 0) return src;
  const margin = Math.round(sr * 0.006);
  const start = Math.max(0, first - margin);
  const end = Math.min(src.length, last + margin);
  if (start === 0 && end === src.length) return src;
  return src.subarray(start, end);
}

function renderUnit(unit, sr, rate, pitch, gain) {
  const src = trimSilence(unit.samples, sr);
  const durFactor = UNIT_TIME / Math.max(0.5, Math.min(2, rate));
  const p = Math.max(0.7, Math.min(1.5, pitch));
  if (Math.abs(durFactor - 1) < 0.01 && Math.abs(p - 1) < 0.01) return src.slice();
  if (unit.f0 >= 50) return psola(src, sr, unit.f0, durFactor, p);
  return resample(resample(src, p), durFactor / p);
}

function silence(seconds, sr) {
  const n = Math.max(0, Math.round(clamp(seconds, 0, 5) * sr));
  return new Float32Array(n);
}

/* 把文字交给参数合成：返回 16-bit PCM WAV；音库不存在时返回 null。 */
function synth(text, opt) {
  const o = opt || {};
  const dir = String(o.dir || '');
  const src = String(text == null ? '' : text).slice(0, 2000);
  if (!dir || !src.trim()) return null;
  const bank = loadBank(dir);
  if (!bank) return null;

  const baseRate = clamp(o.rate || 1, 0.6, 1.6);
  const basePitch = clamp(o.pitch || 1, 0.7, 1.5);
  const baseGain = clamp(o.gain || 1, 0.5, 1.8);
  const key = bank.key + '|' + baseRate + '|' + basePitch + '|' + baseGain + '|' + src;
  const hit = wavCache.get(key);
  if (hit) {
    wavCache.delete(key);
    wavCache.set(key, hit);
    return hit;
  }

  const plan = parseProsody(src, baseRate);
  const sr = bank.rate;
  const chunks = [];
  const limit = Math.round(MAX_SECONDS * sr);
  let total = 0;
  let lastVoiced = -1;       // chunks 里最后一个「有声」块的下标，用于接缝

  function pushSilence(seconds) {
    if (total >= limit) return;
    const s = silence(seconds, sr);
    const take = Math.min(s.length, limit - total);
    if (take <= 0) return;
    chunks.push(take === s.length ? s : s.subarray(0, take));
    total += take;
  }

  /* 字与字之间不再插静音：拼接合成（concatenative TTS）的标准做法是把
   * 相邻浊音段做 10–30ms 等功率交叉淡化，靠重叠消掉接缝处的爆音与断口。
   * 只在标点、空格和 [[p=]] 处才真正插入静音。 */
  function pushVoiced(arr) {
    if (!arr || !arr.length || total >= limit) return;
    let buf = arr;
    if (buf.length > limit - total) buf = buf.subarray(0, Math.max(0, limit - total));
    if (!buf.length) return;
    const prev = lastVoiced >= 0 && lastVoiced === chunks.length - 1 ? chunks[lastVoiced] : null;
    const xf = prev ? Math.min(Math.round(sr * 0.012), prev.length, buf.length) : 0;
    if (!prev || xf < 8) {
      chunks.push(buf);
      total += buf.length;
      lastVoiced = chunks.length - 1;
      return;
    }
    const merged = new Float32Array(prev.length + buf.length - xf);
    merged.set(prev, 0);
    for (let i = 0; i < xf; i++) {
      const t = (i + 0.5) / xf;
      const a = Math.cos(t * Math.PI / 2);
      const b = Math.sin(t * Math.PI / 2);
      merged[prev.length - xf + i] = prev[prev.length - xf + i] * a + buf[i] * b;
    }
    merged.set(buf.subarray(xf), prev.length);
    chunks[lastVoiced] = merged;
    total += buf.length - xf;
  }

  pushSilence(plan.lead);
  /* 先数一遍整句有多少个能发音的音节，用来把下倾均匀摊到每个字上。 */
  let voicedTotal = 0;
  for (let si = 0; si < plan.segments.length; si++) {
    const chars = Array.from(plan.segments[si].text);
    for (let ci = 0; ci < chars.length; ci++) {
      const ch = chars[ci];
      if (/\s/.test(ch) || PUNCT_PAUSE[ch] != null) continue;
      if (unitKeyFor(bank, ch)) voicedTotal++;
    }
  }
  let voicedIndex = 0;
  for (let si = 0; si < plan.segments.length; si++) {
    const seg = plan.segments[si];
    const rate = clamp(seg.rate || baseRate, 0.6, 1.6);
    const gain = clamp((seg.gain || 1) * baseGain, 0.5, 1.8);
    const chars = Array.from(seg.text);
    for (let ci = 0; ci < chars.length; ci++) {
      const ch = chars[ci];
      if (/\s/.test(ch)) { pushSilence(0.04); continue; }
      const pause = PUNCT_PAUSE[ch];
      if (pause != null) {
        /* 标点停顿跟着语速轻微缩放，但不受 LLM 的 [[p=]] 影响（p 之后会额外加） */
        pushSilence(pause / clamp(rate, 0.8, 1.2));
        continue;
      }
      const key2 = unitKeyFor(bank, ch);
      if (!key2) continue;
      const unit = readUnit(bank, key2);
      if (!unit) continue;
      const decl = voicedTotal > 1 ? 1 - DECLINATION * (voicedIndex / (voicedTotal - 1)) : 1;
      voicedIndex++;
      const pitch = clamp((seg.pitch || 1) * basePitch * decl, 0.7, 1.5);
      const buf = renderUnit(unit, sr, rate, pitch, gain);
      for (let i = 0; i < buf.length; i++) buf[i] *= gain;
      pushVoiced(buf);
    }
    pushSilence(seg.after);
  }

  /* 整段只做 3ms 首尾淡入淡出，防止播放器起停爆音；字间接缝交给交叉淡化。 */
  if (chunks.length) {
    fadeEdges(chunks[0], sr);
    fadeEdges(chunks[chunks.length - 1], sr);
  }

  let sampleCount = 0;
  chunks.forEach(c => { sampleCount += c.length; });
  if (!sampleCount) return null;
  const wav = encodeWav(chunks, sr, sampleCount);
  wavCache.set(key, wav);
  if (wavCache.size > MAX_CACHE) {
    const first = wavCache.keys().next().value;
    wavCache.delete(first);
  }
  return wav;
}

function encodeWav(chunks, rate, sampleCount) {
  const dataBytes = sampleCount * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    for (let j = 0; j < c.length; j++) {
      const v = Math.max(-1, Math.min(1, c[j]));
      out.writeInt16LE(Math.round(v * 32767), off);
      off += 2;
    }
  }
  return out;
}

function clearCache() {
  wavCache = new Map();
  bankCache = null;
}

module.exports = {
  paramStatus,
  loadBank,
  synth,
  encodeWav,
  clearCache,
  PUNCT_PAUSE
};
