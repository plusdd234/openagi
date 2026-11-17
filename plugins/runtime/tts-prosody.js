/* 朗读韵律标记：让模型用极轻量的标记控制语速、停顿和句尾拖音。
 *
 * 语法（显示时会被完全剥离，不会读出来）：
 *   [[r=0.9]]  后面的话放慢到 0.9 倍（0.7~1.4）
 *   [[p=0.4]]  在这里停 0.4 秒（0~2）
 *   [[t=0.3]]  句尾再拖 0.3 秒（0~1.5）
 *   [[f=1.1]]  后面的话音调提高到 1.1 倍（0.7~1.5，参数合成引擎生效）
 *   [[e=1.2]]  后面的话加重到 1.2 倍音量（0.8~1.5，参数合成引擎生效）
 * 长短两种写法都认：r/rate、p/pause、t/tail、f/f0/pitch、e/emph/gain。
 *
 * 设计取舍：
 *   · 引擎本身不吃 SSML，所以由我们把标记编译成「分段 + 每段语速 + 段间静音」，
 *     再逐段合成、拼成一个 WAV；
 *   · 解析和拼接都是纯函数，不启动子进程，方便单测；
 *   · 任何不认识的 [[...]] 都从文本里剥掉，宁可没效果也不能让引擎把标记读出来。
 */
'use strict';

const TAG_RE = /\[\[\s*([a-z]+)\s*=\s*(-?[0-9.]+)\s*\]\]/gi;
const ANY_TAG_RE = /\[\[[^\]]*\]\]/g;

function clamp(n, a, b) {
  n = Number(n);
  if (!isFinite(n)) return a;
  return n < a ? a : (n > b ? b : n);
}
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}
function clampRate(n) {
  return round2(clamp(n || 1, 0.7, 1.4));
}
/* 音调 / 重音只给参数合成引擎用；对逐段调用神经引擎的链路没有副作用。 */
function clampPitch(n) {
  return round2(clamp(n || 1, 0.7, 1.5));
}
function clampGain(n) {
  return round2(clamp(n || 1, 0.8, 1.5));
}

/* 把带标记的文本编译成可执行计划：
 *   lead      —— 开头就要留的静音（秒）
 *   segments  —— [{ text, rate, pitch, gain, after }]，after 是该段之后要补的静音（秒）
 *   used      —— 是否出现过标记；没出现时调用方可以走原来的单次合成，零额外开销
 */
function parseProsody(raw, baseRate) {
  const s = String(raw == null ? '' : raw).slice(0, 2000);
  const used = ANY_TAG_RE.test(s);
  ANY_TAG_RE.lastIndex = 0;
  const segments = [];
  let buf = '';
  let rate = clampRate(baseRate || 1);
  let pitch = 1;
  let gain = 1;
  let after = 0;
  let lead = 0;
  let pos = 0;

  /* 收尾时把「没有文本、只跟了停顿」的标记挂到上一句，或挂到开头 */
  const flush = () => {
    const text = buf.replace(ANY_TAG_RE, '').trim();
    buf = '';
    if (text) {
      segments.push({ text: text, rate: rate, pitch: pitch, gain: gain, after: round2(after) });
      after = 0;
    } else if (segments.length && after) {
      const last = segments[segments.length - 1];
      last.after = round2(clamp(last.after + after, 0, 3));
      after = 0;
    } else if (!segments.length && after) {
      lead = round2(clamp(lead + after, 0, 3));
      after = 0;
    }
  };

  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(s))) {
    buf += s.slice(pos, m.index);
    pos = m.index + m[0].length;
    const key = String(m[1] || '').toLowerCase();
    const val = Number(m[2]);
    if (key === 'r' || key === 'rate') {
      flush();
      rate = clampRate(val);
    } else if (key === 'f' || key === 'f0' || key === 'pitch') {
      flush();
      pitch = clampPitch(val);
    } else if (key === 'e' || key === 'emph' || key === 'gain') {
      flush();
      gain = clampGain(val);
    } else if (key === 'p' || key === 'pause') {
      /* 停顿标记本身就是段落边界：先记停顿，再把当前文本收束成一段 */
      after = round2(clamp(after + clamp(val, 0, 2), 0, 3));
      flush();
    } else if (key === 't' || key === 'tail') {
      after = round2(clamp(after + clamp(val, 0, 1.5), 0, 3));
      flush();
    }
    /* 其它 key 只剥离不生效 */
  }
  buf += s.slice(pos);
  flush();

  if (after > 0) {
    if (segments.length) {
      const last = segments[segments.length - 1];
      last.after = round2(clamp(last.after + after, 0, 3));
    } else {
      lead = round2(clamp(lead + after, 0, 3));
    }
  }

  /* 段数上限 16：超出时把后面的文字并进最后一段，宁可语速不完美，也不能丢内容 */
  let list = segments;
  if (list.length > 16) {
    const keep = list.slice(0, 16);
    const rest = list.slice(16);
    const last = keep[15];
    last.text = [last.text].concat(rest.map(r => r.text)).join(' ');
    last.after = round2(clamp(last.after + rest.reduce((s, r) => s + r.after, 0), 0, 3));
    list = keep;
  }

  return {
    used: used,
    lead: round2(clamp(lead, 0, 2)),
    segments: list
  };
}

/* 显示 / 系统语音兜底用：标记一律不出现 */
function stripProsody(text) {
  return String(text == null ? '' : text).replace(ANY_TAG_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/* 读 16-bit PCM WAV 的格式与 data 段；不认识的直接抛错，避免拼出坏文件 */
function wavInfo(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是合法的 WAV');
  }
  let fmt = null;
  let data = null;
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const sz = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(p + 8),
        ch: buf.readUInt16LE(p + 10),
        rate: buf.readUInt32LE(p + 12),
        bits: buf.readUInt16LE(p + 22)
      };
    } else if (id === 'data') {
      data = buf.subarray(p + 8, p + 8 + Math.min(sz, buf.length - p - 8));
      break;
    }
    p += 8 + sz + (sz & 1);
  }
  if (!fmt || fmt.format !== 1 || !data) throw new Error('不是 16-bit PCM WAV');
  return { fmt: fmt, data: data, blockAlign: Math.max(1, fmt.ch * fmt.bits / 8) };
}

/* 把多段合成结果按「段 + 停顿」拼成一个 WAV。
 * items = [{ buf, after }]，lead 是开头静音秒数。 */
function concatWavs(items, lead) {
  if (!Array.isArray(items) || !items.length) throw new Error('没有可拼接的音频');
  const infos = items.map(it => ({ info: wavInfo(it.buf), after: clamp(it.after, 0, 3) }));
  const f = infos[0].info.fmt;
  for (let i = 1; i < infos.length; i++) {
    const g = infos[i].info.fmt;
    if (g.ch !== f.ch || g.rate !== f.rate || g.bits !== f.bits) {
      throw new Error('分段音频格式不一致，无法拼接');
    }
  }
  const ba = infos[0].info.blockAlign;
  const silenceBytes = sec => Math.round(clamp(sec, 0, 5) * f.rate) * ba;
  const leadBytes = silenceBytes(lead || 0);
  let total = leadBytes;
  infos.forEach(it => { total += it.info.data.length + silenceBytes(it.after); });

  const out = Buffer.alloc(44 + total);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + total, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(f.ch, 22);
  out.writeUInt32LE(f.rate, 24);
  out.writeUInt32LE(f.rate * ba, 28);
  out.writeUInt16LE(ba, 32);
  out.writeUInt16LE(f.bits, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(total, 40);

  let off = 44 + leadBytes;   // Buffer.alloc 已归零，静音段不用再写
  infos.forEach(it => {
    it.info.data.copy(out, off);
    off += it.info.data.length + silenceBytes(it.after);
  });
  return out;
}

module.exports = { parseProsody, stripProsody, concatWavs, wavInfo };
