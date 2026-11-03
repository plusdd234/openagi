/* GLB 元数据读写：只换 JSON chunk，不碰 BIN
 *
 * 为什么单独一个文件：
 *   GLB 是一个容器：12 字节头 + 若干 chunk（JSON / BIN / 未知扩展）。
 *   想在 asset.extras.seedModel 里塞文档，最稳的做法是**只替换 JSON chunk**，
 *   BIN 和未知 chunk 原样搬过去。整份重新打包会丢掉扩展 chunk，还会改顶点数据。
 *
 * 规则（对照 glTF 2.0 规范）：
 *   - chunk 长度必须 4 字节对齐；JSON 补空格（0x20），BIN 补 0（0x00）
 *   - 头里的 total length 必须跟着新文件更新
 *   - JSON chunk 必须是第一个 chunk
 *   - 读的时候不信任长度字段，按实际字节走，遇到截断直接报错
 *
 * 对外接口（全局 SeedGLB）：
 *   SeedGLB.parse(buf)                  → {version, chunks, json}
 *   SeedGLB.readJson(buf)               → JSON 对象
 *   SeedGLB.writeJson(buf, json)        → Uint8Array（只换 JSON chunk）
 *   SeedGLB.readSeedModel(buf)          → seedModel 对象 / null
 *   SeedGLB.injectSeedModel(buf, doc)   → Uint8Array（写回 extras）
 *   SeedGLB.toDataURL(u8) / fromDataURL(str)
 */
(function (global) {
  'use strict';

  var MAGIC = 0x46546C67;          // 'glTF'
  var CHUNK_JSON = 0x4E4F534A;     // 'JSON'
  var CHUNK_BIN = 0x004E4942;      // 'BIN\0'

  function asBytes(input) {
    if (!input) throw new Error('GLB 数据为空');
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input.buffer instanceof ArrayBuffer) {
      return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
    }
    throw new Error('不认识的 GLB 数据类型（需要 ArrayBuffer / Uint8Array）');
  }

  function parse(input) {
    var u8 = asBytes(input);
    if (u8.length < 12) throw new Error('GLB 太短（不足 12 字节头）');
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('不是 GLB（magic 不是 glTF）');
    var version = dv.getUint32(4, true);
    var total = dv.getUint32(8, true);
    if (total > u8.length + 3) throw new Error('GLB 头长度 ' + total + ' 超过实际字节 ' + u8.length);

    var chunks = [];
    var off = 12, json = null;
    while (off + 8 <= u8.length) {
      var len = dv.getUint32(off, true);
      var type = dv.getUint32(off + 4, true);
      var start = off + 8, end = start + len;
      if (end > u8.length) throw new Error('GLB chunk 截断（offset ' + off + '）');
      var bytes = u8.subarray(start, end);
      chunks.push({ type: type, bytes: bytes, offset: off, length: len });
      if (type === CHUNK_JSON && json == null) {
        var text = decodeUtf8(bytes);
        try { json = JSON.parse(text); }
        catch (e) { throw new Error('GLB 的 JSON chunk 解析失败：' + (e && e.message)); }
      }
      off = end;
    }
    if (!json) throw new Error('GLB 里没有 JSON chunk');
    return { version: version, total: total, chunks: chunks, json: json };
  }

  function decodeUtf8(bytes) {
    if (typeof global.TextDecoder === 'function') return new global.TextDecoder('utf-8').decode(bytes);
    /* 极旧环境兜底：GLB 的 JSON 里非 ASCII 只会出现在名字里，decodeURIComponent 足够 */
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += '%' + ('0' + bytes[i].toString(16)).slice(-2);
    try { return decodeURIComponent(s); } catch (e) { return String.fromCharCode.apply(null, bytes); }
  }

  function encodeUtf8(text) {
    if (typeof global.TextEncoder === 'function') return new global.TextEncoder('utf-8').encode(text);
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function padTo4(bytes, filler) {
    var n = bytes.length % 4;
    if (!n) return bytes;
    var out = new Uint8Array(bytes.length + (4 - n));
    out.set(bytes, 0);
    out.fill(filler, bytes.length);
    return out;
  }

  function readJson(input) { return parse(input).json; }

  function writeJson(input, json) {
    var p = parse(input);
    var jsonBytes = padTo4(encodeUtf8(JSON.stringify(json)), 0x20);
    var chunks = [];
    var replaced = false;
    for (var i = 0; i < p.chunks.length; i++) {
      var c = p.chunks[i];
      if (c.type === CHUNK_JSON) {
        if (replaced) continue;                 // 规范只允许一个 JSON chunk
        chunks.push({ type: c.type, bytes: jsonBytes });
        replaced = true;
      } else {
        chunks.push({ type: c.type, bytes: c.bytes });
      }
    }
    if (!replaced) chunks.unshift({ type: CHUNK_JSON, bytes: jsonBytes });

    var total = 12;
    chunks.forEach(function (c) { total += 8 + c.bytes.length; });
    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, MAGIC, true);
    dv.setUint32(4, p.version, true);
    dv.setUint32(8, total, true);
    var off = 12;
    chunks.forEach(function (c) {
      dv.setUint32(off, c.bytes.length, true);
      dv.setUint32(off + 4, c.type, true);
      out.set(c.bytes, off + 8);
      off += 8 + c.bytes.length;
    });
    return out;
  }

  function readSeedModel(input) {
    var json = readJson(input);
    var a = json && json.asset;
    return (a && a.extras && a.extras.seedModel)
      ? a.extras.seedModel
      : null;
  }

  function injectSeedModel(input, doc) {
    var json = JSON.parse(JSON.stringify(readJson(input)));
    json.asset = json.asset || { version: '2.0' };
    json.asset.extras = json.asset.extras || {};
    json.asset.extras.seedModel = doc;
    return writeJson(input, json);
  }

  /* ArrayBuffer → dataURL：分块转字符，几十万参数一次性 apply 会爆栈 */
  function bufToBase64(u8) {
    var s = '';
    var CH = 8192;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    }
    if (typeof global.btoa === 'function') return global.btoa(s);
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    throw new Error('当前环境没有 base64 编码能力');
  }

  function toDataURL(input) {
    var u8 = asBytes(input);
    return 'data:model/gltf-binary;base64,' + bufToBase64(u8);
  }

  function fromDataURL(dataURL) {
    var s = String(dataURL || '');
    var comma = s.indexOf(',');
    if (comma < 0) throw new Error('不是 dataURL');
    var b64 = s.slice(comma + 1);
    var bin;
    if (typeof global.atob === 'function') bin = global.atob(b64);
    else if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    else throw new Error('当前环境没有 base64 解码能力');
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  global.SeedGLB = {
    CHUNK_JSON: CHUNK_JSON,
    CHUNK_BIN: CHUNK_BIN,
    parse: parse,
    readJson: readJson,
    writeJson: writeJson,
    readSeedModel: readSeedModel,
    injectSeedModel: injectSeedModel,
    toDataURL: toDataURL,
    fromDataURL: fromDataURL
  };
})(typeof window !== 'undefined' ? window : globalThis);
