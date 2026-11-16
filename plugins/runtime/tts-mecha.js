/* 二次元机械音效果器：同一份 VITS 模型合成后，在 PCM 上叠一层
 * 环形调制 + 比特压限 + 软削波，得到「机娘」的金属颗粒感，不额外下载权重。
 * 只处理 16-bit PCM WAV；格式不认识就原样返回，宁可没效果也不能把音频弄坏。
 * 独立成模块是为了能脱离 HTTP 服务做纯逻辑测试。 */
'use strict';

function mechaizeWav(buf) {
  const b = Buffer.from(buf);
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return b;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  let p = 12;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(p + 8),
        ch: b.readUInt16LE(p + 10),
        rate: b.readUInt32LE(p + 12),
        bits: b.readUInt16LE(p + 22)
      };
    } else if (id === 'data') {
      dataOff = p + 8;
      dataLen = Math.min(sz, b.length - dataOff);
      break;
    }
    p += 8 + sz + (sz & 1);
  }
  if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || dataOff < 0) return b;

  const rate = fmt.rate || 22050;
  const n = Math.floor(dataLen / 2);
  if (n < 8) return b;
  const out = new Int16Array(n);
  /* 42 Hz 环形调制是「机械声」的关键频率：再低像颤音，再高会盖住语音。 */
  const w = 2 * Math.PI * 42 / rate;
  const hp = 0.04;   // 一阶高通，去掉低频轰鸣，让金属感更干净
  const d = 3 * Math.floor(rate / 1000); // 3 ms 延迟，补一点金属共鸣
  let lp = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let x = b.readInt16LE(dataOff + i * 2) / 32768;
    lp += hp * (x - lp);
    x -= lp;
    const mod = 0.6 + 0.4 * Math.sin(w * i);
    let y = x * (0.35 + 0.75 * mod);
    if (i >= d) y += 0.18 * (b.readInt16LE(dataOff + (i - d) * 2) / 32768);
    /* 9-bit 量化：保留齿音，又能听出颗粒。 */
    y = Math.round(y * 256) / 256;
    y = Math.tanh(y * 1.25) * 0.8;
    if (Math.abs(y) > peak) peak = Math.abs(y);
    out[i] = Math.max(-32767, Math.min(32767, Math.round(y * 32767)));
  }
  const gain = peak > 0 ? 0.92 / peak : 1;
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(out[i] * gain))), dataOff + i * 2);
  }
  return b;
}

module.exports = { mechaizeWav };
