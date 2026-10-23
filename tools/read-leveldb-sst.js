/* 从 Chromium localStorage 的 LevelDB SST（.ldb）里提取指定键的历史值
 * 用途：浏览器 localStorage 被覆盖后，仍可能从旧的 SST 块里找回历史数据。
 * 依赖：纯 JS 实现 snappy 解压 + LevelDB 表/块解析，无外部依赖。
 * 用法：node tools/read-leveldb-sst.js <leveldb目录> <键名子串>
 */
const fs = require('fs');
const path = require('path');

// ---------- snappy 原始块解压 ----------
function snappyDecompress(src) {
  let p = 0;
  let len = 0, shift = 0;
  while (p < src.length) {
    const b = src[p++];
    len |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  const out = Buffer.allocUnsafe(len);
  let o = 0;
  while (p < src.length) {
    const tag = src[p++];
    const t = tag & 0x03;
    if (t === 0) {
      let l = tag >> 2;
      if (l < 60) l = l + 1;
      else {
        const n = l - 59;
        let v = 0;
        for (let i = 0; i < n; i++) v |= src[p++] << (8 * i);
        l = v + 1;
      }
      src.copy(out, o, p, p + l); p += l; o += l;
    } else {
      let l, off;
      if (t === 1) { l = 4 + ((tag >> 2) & 0x07); off = ((tag >> 5) << 8) | src[p++]; }
      else if (t === 2) { l = (tag >> 2) + 1; off = src[p++] | (src[p++] << 8); }
      else { l = (tag >> 2) + 1; off = src[p++] | (src[p++] << 8) | (src[p++] << 16) | (src[p++] << 24); }
      const s = o - off;
      for (let i = 0; i < l; i++) out[o++] = out[s + i];
    }
  }
  return out;
}

// ---------- varint ----------
function readVarint(buf, pos) {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result, pos];
}

// ---------- 块内容解析 ----------
function parseBlock(data) {
  if (data.length < 4) return [];
  const numRestarts = data.readUInt32LE(data.length - 4);
  const limit = data.length - 4 - numRestarts * 4;
  const entries = [];
  let pos = 0;
  let key = Buffer.alloc(0);
  while (pos < limit) {
    let shared, nonShared, vlen;
    [shared, pos] = readVarint(data, pos);
    [nonShared, pos] = readVarint(data, pos);
    [vlen, pos] = readVarint(data, pos);
    if (pos + nonShared + vlen > data.length) break;
    const k = Buffer.concat([key.slice(0, shared), data.slice(pos, pos + nonShared)]);
    pos += nonShared;
    const v = data.slice(pos, pos + vlen);
    pos += vlen;
    entries.push([k, v]);
    key = k;
  }
  return entries;
}

// 读取一个块（offset/size 指向压缩数据，后面 5 字节是 trailer：1 字节类型 + 4 字节 crc）
function readBlock(buf, offset, size) {
  const raw = buf.slice(offset, offset + size);
  const type = buf[offset + size];
  const data = type === 1 ? snappyDecompress(raw) : raw;
  return parseBlock(data);
}

// ---------- SST 解析 ----------
function parseSST(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 48) return [];
  const footer = buf.slice(buf.length - 48);
  let p = 0, miOff, miSize, idxOff, idxSize;
  [miOff, p] = readVarint(footer, p);
  [miSize, p] = readVarint(footer, p);
  [idxOff, p] = readVarint(footer, p);
  [idxSize, p] = readVarint(footer, p);
  let out = [];
  try {
    const indexEntries = readBlock(buf, idxOff, idxSize);
    for (const [, handle] of indexEntries) {
      // handle = varint offset + varint size
      let hp = 0, off, size;
      [off, hp] = readVarint(handle, hp);
      [size, hp] = readVarint(handle, hp);
      try { out = out.concat(readBlock(buf, off, size)); } catch (e) {}
    }
  } catch (e) {}
  return out;
}

// ---------- 主流程 ----------
const dir = process.argv[2];
const needle = process.argv[3] || 'hf_flows';
if (!dir) { console.error('用法：node tools/read-leveldb-sst.js <leveldb目录> [键名子串]'); process.exit(1); }

const files = fs.readdirSync(dir).filter(f => /\.(ldb|log)$/.test(f));
for (const f of files) {
  let entries = [];
  if (/\.ldb$/.test(f)) {
    entries = parseSST(path.join(dir, f));
  } else {
    // .log 是写前日志，格式不同：直接扫明文（UTF-16LE 值）
    const b = fs.readFileSync(path.join(dir, f));
    const s = b.toString('latin1');
    let pos = 0;
    while (true) {
      const i = s.indexOf(needle, pos);
      if (i < 0) break;
      pos = i + needle.length;
      for (const off of [0, 1]) {
        const txt = b.slice(i + needle.length + off).toString('utf16le');
        const st = txt.indexOf('[{');
        if (st < 0) continue;
        let d = 0, e = -1, ins = false, esc = false;
        for (let k = st; k < txt.length; k++) {
          const c = txt[k];
          if (ins) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') ins = false; continue; }
          if (c === '"') { ins = true; continue; }
          if (c === '[') d++;
          else if (c === ']') { d--; if (!d) { e = k; break; } }
        }
        if (e < 0) continue;
        try {
          const arr = JSON.parse(txt.slice(st, e + 1));
          if (Array.isArray(arr) && arr[0] && arr[0].nodes) entries.push([Buffer.from('log'), Buffer.from(JSON.stringify(arr), 'utf8')]);
        } catch (err) {}
        break;
      }
    }
  }
  const hits = entries.filter(([k, v]) => {
    const kt = k.toString('latin1');
    const vt = v.toString('utf8');
    return kt.includes(needle) || vt.includes(needle);
  });
  if (!hits.length) continue;
  console.log('=== ' + f + ' · ' + entries.length + ' 条记录 · 命中 ' + hits.length + ' ===');
  for (const [k, v] of hits) {
    const kt = k.toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    let vt = v.toString('utf8');
    if (v.length && v[0] === 0x01 && v[1] === 0x00) vt = v.slice(2).toString('utf16le');   // Chrome 字符串编码
    let info = vt.slice(0, 120);
    try {
      const arr = JSON.parse(vt);
      if (Array.isArray(arr)) {
        const upd = Math.max(...arr.map(x => x.updated || 0));
        info = arr.map(x => '「' + x.name + '」' + x.nodes.length + '节点/' + x.links.length + '连线 @' + new Date(x.updated).toLocaleString('zh-CN')).join('  ');
        console.log('  key=' + kt + '\n    → ' + info + '  [最新updated=' + new Date(upd).toLocaleString('zh-CN') + ']');
        fs.writeFileSync(path.join(require('os').tmpdir(), 'sst_flows_' + f.replace(/\W/g, '_') + '_' + upd + '.json'), JSON.stringify(arr, null, 1), 'utf8');
        continue;
      }
    } catch (e) {}
    console.log('  key=' + kt + '\n    → ' + info);
  }
}
