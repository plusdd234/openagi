#!/usr/bin/env node
'use strict';
/* embed-cdp 纯逻辑测试（不启 Electron / 不启浏览器）
 *
 * 覆盖三块最容易坏、又最难在真实环境里复现的逻辑：
 *   1) guest 选择：只认 type=webview + tripo3d 域名，openagi_embed=1 优先；
 *   2) WebSocket 握手 / 掩码帧 / CDP 请求响应：用本地 mock 服务端跑真连接；
 *   3) Runtime.evaluate / $$ / 文件选择拦截 / context.request 的外壳映射。
 *
 * 用法：node tools/embed-cdp.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const mod = require('../plugins/tripo/embed-cdp');

const errors = [];
function ok(name, fn) {
  try { fn(); console.log('  ✅ ' + name); }
  catch (e) { errors.push(name + '：' + e.message); console.log('  ❌ ' + name + ' — ' + e.message); }
}
async function okAsync(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); }
  catch (e) { errors.push(name + '：' + e.message); console.log('  ❌ ' + name + ' — ' + e.message); }
}

/* ------------------------------------------------------------------ *
 * 1. 目标选择
 * ------------------------------------------------------------------ */
function testPickGuest() {
  console.log('== guest 选择 ==');
  const base = { webSocketDebuggerUrl: 'ws://127.0.0.1:1/a', type: 'webview' };
  ok('只认 webview', () => {
    const hit = mod.pickGuest([
      Object.assign({}, base, { type: 'page', url: 'https://studio.tripo3d.com/' }),
    ]);
    assert.strictEqual(hit, null);
  });
  ok('只认 tripo3d 域名', () => {
    const hit = mod.pickGuest([
      Object.assign({}, base, { url: 'https://example.com/' }),
    ]);
    assert.strictEqual(hit, null);
  });
  ok('openagi_embed=1 优先于普通 studio 页', () => {
    const plain = Object.assign({}, base, { url: 'https://studio.tripo3d.com/zh/workspace' });
    const marked = Object.assign({}, base, { url: 'https://studio.tripo3d.com/?openagi_embed=1' });
    assert.strictEqual(mod.pickGuest([plain, marked]), marked);
    assert.strictEqual(mod.pickGuest([plain]), plain);
  });
  ok('支持 .ai 域名与子域', () => {
    const hit = Object.assign({}, base, { url: 'https://www.tripo3d.ai/x' });
    assert.strictEqual(mod.pickGuest([hit]), hit);
  });
  ok('缺 webSocketDebuggerUrl 的跳过', () => {
    const hit = mod.pickGuest([{ type: 'webview', url: 'https://studio.tripo3d.com/' }]);
    assert.strictEqual(hit, null);
  });
}

/* ------------------------------------------------------------------ *
 * 2. 数据 URL
 * ------------------------------------------------------------------ */
function testDataUrl() {
  console.log('== 数据 URL ==');
  const { decodeDataUrl, extFromType } = mod._internals;
  ok('base64 png', () => {
    const d = decodeDataUrl('data:image/png;base64,' + Buffer.from('hello').toString('base64'));
    assert.ok(d);
    assert.strictEqual(d.buffer.toString(), 'hello');
    assert.strictEqual(d.ext, '.png');
  });
  ok('文本 GLB 推断扩展名', () => {
    assert.strictEqual(extFromType('application/octet-stream', 'https://x/a.glb'), '.glb');
    assert.strictEqual(extFromType('application/zip', ''), '.zip');
  });
}

/* ------------------------------------------------------------------ *
 * mock WebSocket + CDP 服务端
 * ------------------------------------------------------------------ */
function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x81;
  return Buffer.concat([head, payload]);
}

function attachWsServer(server, onMessage) {
  server.on('upgrade', (req, socket) => {
    const key = String((req.headers && req.headers['sec-websocket-key']) || '').trim();
    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let buf = Buffer.alloc(0);
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        const masked = (b1 & 0x80) !== 0;
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        let payload = buf.slice(off + maskLen, off + maskLen + len);
        if (masked) {
          const mask = buf.slice(off, off + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.slice(off + maskLen + len);
        const op = b0 & 0x0f;
        if (op === 0x8) { try { socket.end(); } catch (e) { /* ignore */ } return; }
        if (op === 0x9) { socket.write(frame('')); continue; }
        if (op === 0x1) {
          try { onMessage(JSON.parse(payload.toString('utf8')), msg => socket.write(frame(msg))); }
          catch (e) { /* ignore */ }
        }
      }
    });
    socket.on('error', () => {});
  });
}

async function main() {
  testPickGuest();
  testDataUrl();

  console.log('== WebSocket / CDP ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-cdp-'));
  const uploadFile = path.join(tmp, 'ref.png');
  fs.writeFileSync(uploadFile, 'fake-image');
  let chooserSent = false;
  let fileSet = null;

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const port = server.address().port;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([
        { type: 'page', url: 'app://openagi/index.html' },
        { type: 'webview', url: 'https://studio.tripo3d.com/?openagi_embed=1', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/guest' },
        { type: 'webview', url: 'https://example.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/other' },
      ]));
      return;
    }
    if (req.url === '/file.glb') {
      res.setHeader('content-type', 'model/gltf-binary');
      res.end(Buffer.from('glb-bytes'));
      return;
    }
    res.statusCode = 404;
    res.end('');
  });
  attachWsServer(server, (msg, send) => {
    if (!msg || !msg.id) return;
    const method = msg.method;
    if (method === 'Runtime.evaluate') {
      const expr = String((msg.params && msg.params.expression) || '');
      if (/location\.href/.test(expr)) return send(JSON.stringify({ id: msg.id, result: { result: { type: 'string', value: 'https://studio.tripo3d.com/zh/workspace/generate' } } }));
      if (/document\.title/.test(expr)) return send(JSON.stringify({ id: msg.id, result: { result: { type: 'string', value: 'Tripo' } } }));
      if (/__tripoEmbedShim\.query/.test(expr)) return send(JSON.stringify({ id: msg.id, result: { result: { type: 'object', value: [11, 12] } } }));
      if (/__tripoEmbedShim\.el\(11\)/.test(expr)) return send(JSON.stringify({ id: msg.id, result: { result: { type: 'number', value: 11 } } }));
      if (/__tripoEmbedShim\.el\(12\)/.test(expr)) return send(JSON.stringify({ id: msg.id, result: { result: { type: 'number', value: 12 } } }));
      return send(JSON.stringify({ id: msg.id, result: { result: { type: 'number', value: 42 } } }));
    }
    if (method === 'Page.setInterceptFileChooserDialog' && msg.params && msg.params.enabled) {
      if (!chooserSent) {
        chooserSent = true;
        setTimeout(() => send(JSON.stringify({ method: 'Page.fileChooserOpened', params: { backendNodeId: 77, mode: 'selectSingle' } })), 30);
      }
      return send(JSON.stringify({ id: msg.id, result: {} }));
    }
    if (method === 'DOM.setFileInputFiles') {
      fileSet = msg.params;
      return send(JSON.stringify({ id: msg.id, result: {} }));
    }
    if (method === 'Page.captureScreenshot') {
      return send(JSON.stringify({ id: msg.id, result: { data: Buffer.from('shot').toString('base64') } }));
    }
    return send(JSON.stringify({ id: msg.id, result: {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const cdpBase = 'http://127.0.0.1:' + server.address().port;

  const emb = await mod.connect({ cdpBase, outDir: path.join(tmp, 'out'), timeoutMs: 4000 });
  await okAsync('connect 找到并连上 guest', () => {
    assert.ok(emb && emb.page);
    assert.strictEqual(emb.context.__embedded, true);
  });

  await okAsync('page.evaluate 走 CDP 往返', async () => {
    const v = await emb.page.evaluate((a, b) => a + b, 1, 2);
    assert.strictEqual(v, 42);
  });

  await okAsync('page.$$ 返回句柄', async () => {
    const list = await emb.page.$$('button');
    assert.strictEqual(list.length, 2);
    const id = await list[0].evaluate(el => el);
    assert.strictEqual(id, 11);
  });

  await okAsync('page.url 由轮询更新', async () => {
    await new Promise(r => setTimeout(r, 1600));
    assert.ok(/workspace\/generate/.test(emb.page.url()), emb.page.url());
  });

  await okAsync('文件选择拦截 + setFiles', async () => {
    const fc = await emb.page.waitForEvent('filechooser', { timeout: 3000 });
    assert.ok(fc && typeof fc.setFiles === 'function');
    await fc.setFiles([uploadFile]);
    assert.ok(fileSet && Array.isArray(fileSet.files) && fileSet.files[0] === uploadFile);
    assert.strictEqual(fileSet.backendNodeId, 77);
  });

  await okAsync('context.request.get 取响应体', async () => {
    const res = await emb.context.request.get(cdpBase + '/file.glb');
    assert.strictEqual(res.status(), 200);
    assert.strictEqual((await res.body()).toString(), 'glb-bytes');
  });

  await okAsync('关闭连接后 isClosed', async () => {
    emb.page._cdp.wire.close();
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(emb.page.isClosed(), true);
    assert.strictEqual(emb.context.pages().length, 0);
  });

  try { server.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('');
  if (errors.length) {
    console.log('❌ ' + errors.length + ' 项失败');
    errors.forEach(e => console.log('   - ' + e));
    process.exit(1);
  }
  console.log('✅ 全部通过');
  process.exit(0);
}

main().catch(e => { console.error('❌ 测试异常：' + (e && e.stack || e)); process.exit(1); });
