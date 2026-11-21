'use strict';
/* 内嵌 Tripo 页面驱动（CDP over WebSocket）
 *
 * 背景（改之前先读）：
 *   App 里的 <webview> 是一个独立 guest，Playwright 的 connectOverCDP 只能看到宿主页
 *   （/json/list 里 guest 是 type=webview，Playwright 不把它当 Page），所以高层 API
 *   完全驱动不了它。但 guest 自己有 webSocketDebuggerUrl，裸 CDP 可以做任何事。
 *
 * 本文件只做两件事：
 *   1) 一个不依赖第三方包的 WebSocket 客户端 + 最小 CDP 客户端；
 *   2) 一层「够用就好」的 Playwright 页面/元素外壳，让 tripo-web.js 里上千行页面流程
 *      一行不改地跑在 guest 上。
 *
 * 刻意实现的能力边界（与 tripo-web.js 实际调用面一一对应）：
 *   page.evaluate / $$ / url / title / goto / reload / bringToFront /
 *   on('request'|'response') / waitForEvent('filechooser') / keyboard
 *   element.getAttribute / isVisible / innerText / boundingBox / evaluate /
 *   evaluateHandle / $$ / click / fill / setInputFiles / screenshot
 *   context.pages / newPage / on('page'|'close'|'download') / off / addInitScript / request
 *
 * 两个 Electron 特有坑已经在这里消化掉：
 *   · Input.insertText 在 guest 里不生效（guest 拿不到键盘焦点），改用页面内
 *     execCommand('insertText') / 原生 value setter；
 *   · blob: 链接的下载不触发 will-download，靠页面内锚点钩子 + 轮询兜底。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const TRIPO_HOST_RE = /^https?:\/\/([^/]*\.)?tripo3d\.(com|ai)(\/|$)/i;
const API_HOST_RE = /^https?:\/\/([^/]*\.)?(tripo3d|holymolly)\.(com|ai)\//i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * WebSocket（RFC 6455 客户端，仅文本帧 + ping/pong/close）
 * ------------------------------------------------------------------ */
class Wire {
  constructor(url) {
    const u = new URL(url);
    this.host = u.hostname;
    this.port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
    this.path = (u.pathname || '/') + (u.search || '');
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.socket = null;
    this.onmessage = null;
    this.onclose = null;
    this.closed = false;
    this.open = false;
  }

  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const sock = net.connect({ host: this.host, port: this.port });
      this.socket = sock;
      let handshaken = false;
      const timer = setTimeout(() => {
        try { sock.destroy(); } catch (e) { /* ignore */ }
        reject(new Error('CDP 连接超时'));
      }, timeoutMs);
      sock.once('connect', () => {
        sock.write('GET ' + this.path + ' HTTP/1.1\r\n'
          + 'Host: ' + this.host + ':' + this.port + '\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Connection: Upgrade\r\n'
          + 'Sec-WebSocket-Key: ' + key + '\r\n'
          + 'Sec-WebSocket-Version: 13\r\n\r\n');
      });
      sock.on('data', chunk => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (!handshaken) {
          const idx = this.buf.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this.buf.slice(0, idx).toString('latin1');
          this.buf = this.buf.slice(idx + 4);
          if (!/^HTTP\/1\.1 101/i.test(head)) {
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) { /* ignore */ }
            reject(new Error('CDP 握手失败：' + (head.split('\r\n')[0] || '')));
            return;
          }
          handshaken = true;
          this.open = true;
          clearTimeout(timer);
          resolve();
        }
        this._drain();
      });
      sock.on('error', e => {
        clearTimeout(timer);
        if (!handshaken) reject(e);
        else this._close(e.message);
      });
      sock.on('close', () => this._close('socket closed'));
    });
  }

  send(text) {
    if (this.closed || !this.socket) throw new Error('内嵌页面连接已关闭');
    this._frame(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    try { this._frame(0x8, Buffer.alloc(0)); } catch (e) { /* ignore */ }
    try { this.socket.end(); } catch (e) { /* ignore */ }
  }

  _frame(op, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.alloc(6);
      head[1] = 0x80 | len;
    } else if (len < 65536) {
      head = Buffer.alloc(8);
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(14);
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    head[0] = 0x80 | op;
    mask.copy(head, head.length - 4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    this.socket.write(Buffer.concat([head, body]));
  }

  _drain() {
    if (!this.open) return;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > 256n * 1024n * 1024n) { this._close('帧过大'); return; }
        len = Number(big);
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.slice(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      this.buf = this.buf.slice(off + maskLen + len);

      if (op === 0x8) { this._close('server close'); return; }
      if (op === 0x9) { try { this._frame(0xA, payload); } catch (e) { /* ignore */ } continue; }
      if (op === 0xA) continue;

      if (op === 0x0) {
        this.frags.push(payload);
      } else {
        this.frags = [payload];
        this.fragOp = op;
      }
      if (fin) {
        const data = Buffer.concat(this.frags);
        this.frags = [];
        if ((this.fragOp || op) === 0x1 && this.onmessage) {
          try { this.onmessage(data.toString('utf8')); } catch (e) { /* ignore */ }
        }
      }
    }
  }

  _close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    if (this.onclose) {
      try { this.onclose(reason); } catch (e) { /* ignore */ }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 最小 CDP 客户端
 * ------------------------------------------------------------------ */
class Cdp {
  constructor(url) {
    this.wire = new Wire(url);
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.closeReason = '';
    this.wire.onmessage = text => this._onMessage(text);
    this.wire.onclose = reason => this._onClose(reason);
  }

  connect() { return this.wire.connect(); }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.off(method, fn);
  }

  off(method, fn) {
    const set = this.handlers.get(method);
    if (set) set.delete(fn);
  }

  send(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('内嵌页面已关闭'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 超时：' + method));
      }, Math.max(1000, Number(timeoutMs) || 20000));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.wire.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || ('CDP 错误：' + msg.error.code)));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      const set = this.handlers.get(msg.method);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try { fn(msg.params || {}); } catch (e) { /* ignore */ }
      }
    }
  }

  _onClose(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason || '';
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('内嵌页面已关闭'));
    }
    this.pending.clear();
    const set = this.handlers.get('__close');
    if (set) {
      for (const fn of Array.from(set)) {
        try { fn(this.closeReason); } catch (e) { /* ignore */ }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 页面内注入脚本：元素登记 + 输入 + 下载钩子
 * ------------------------------------------------------------------ */
function bootstrapSource() {
  return '(' + function () {
    if (window.__tripoEmbedShim) return;
    const S = window.__tripoEmbedShim = {
      next: 1,
      els: new Map(),
      ids: new Map(),
      downloads: []
    };
    S.add = function (el) {
      if (!el || typeof el !== 'object') return 0;
      let id = S.ids.get(el);
      if (id) return id;
      id = S.next++;
      S.els.set(id, el);
      S.ids.set(el, id);
      // 句柄只有操作期间才需要；超过上限按插入顺序淘汰最旧的一批，避免长会话内存膨胀。
      // 上限给得很宽：生成流程一次可能查上百个候选元素，淘汰太积极会让「先查后点」的句柄失效。
      if (S.els.size > 20000) {
        let n = 0;
        for (const key of S.els.keys()) {
          if (n++ >= 5000) break;
          const dead = S.els.get(key);
          S.els.delete(key);
          if (dead) S.ids.delete(dead);
        }
      }
      return id;
    };
    S.el = function (id) { return S.els.get(id) || null; };
    S.query = function (rootId, sel) {
      const root = rootId ? S.el(rootId) : document;
      if (!root || !root.querySelectorAll) return [];
      return Array.from(root.querySelectorAll(sel)).map(function (el) { return S.add(el); });
    };
    S.setNative = function (el, value) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    S.insertText = function (text) {
      const el = document.activeElement;
      if (!el) return false;
      if (el.isContentEditable) {
        try { el.focus(); } catch (e) { /* ignore */ }
        try { if (document.execCommand('insertText', false, text)) return true; } catch (e) { /* ignore */ }
        const sel = window.getSelection();
        if (sel && sel.rangeCount) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(document.createTextNode(text));
          range.collapse(false);
          return true;
        }
        el.textContent = (el.textContent || '') + text;
        return true;
      }
      if ('value' in el) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const next = String(el.value || '') + text;
        if (desc && desc.set) desc.set.call(el, next);
        else el.value = next;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    };
    S.visible = function (el) {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none';
    };
    S.rect = function (id, pageCoord) {
      const el = S.el(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const sx = pageCoord ? (window.scrollX || 0) : 0;
      const sy = pageCoord ? (window.scrollY || 0) : 0;
      return { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height };
    };
    S.scroll = function (id) {
      const el = S.el(id);
      if (!el) return false;
      try {
        if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(true);
        else el.scrollIntoView({ block: 'center', inline: 'center' });
        return true;
      } catch (e) { return false; }
    };

    /* blob: 下载钩子。真实 HTTP 下载由主进程 will-download 落盘；
       blob: 链接在 Electron 里既不触发 will-download 也不触发 Page.downloadWillBegin，
       所以只能在页面内把 href 记下来，之后由 Node 侧 fetch → base64 取回。 */
    const noteDownload = function (name, href) {
      if (!href || !/^blob:/i.test(href)) return;
      if (S.downloads.some(function (d) { return d.href === href; })) return;
      S.downloads.push({ name: String(name || 'download'), href: href, at: Date.now() });
      if (S.downloads.length > 8) S.downloads.shift();
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try { if (this.download) noteDownload(this.download, this.href); } catch (e) { /* ignore */ }
      return origClick.apply(this, arguments);
    };
    document.addEventListener('click', function (ev) {
      try {
        const a = ev.target && ev.target.closest ? ev.target.closest('a[download]') : null;
        if (a) noteDownload(a.download, a.href);
      } catch (e) { /* ignore */ }
    }, true);
  }.toString() + ')()';
}

/* ------------------------------------------------------------------ *
 * Evaluate 辅助
 * ------------------------------------------------------------------ */
function lit(v) {
  if (v === undefined) return 'undefined';
  try { return JSON.stringify(v); } catch (e) { return 'null'; }
}

function exceptionText(details) {
  if (!details) return '页面脚本执行失败';
  const ex = details.exception || {};
  const msg = ex.description || ex.value || details.text || '页面脚本执行失败';
  return String(msg).split('\n')[0];
}

async function rawEval(cdp, expr, timeoutMs) {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  }, timeoutMs);
  if (r.exceptionDetails) throw new Error(exceptionText(r.exceptionDetails));
  return r.result ? r.result.value : undefined;
}

/* ------------------------------------------------------------------ *
 * 元素句柄
 * ------------------------------------------------------------------ */
class EmbedHandle {
  constructor(page, id) {
    this.page = page;
    this._id = id;
  }

  _eval(body) {
    return rawEval(this.page._cdp, '(async () => { const __el = window.__tripoEmbedShim.el(' + this._id + '); if (!__el) return null; ' + body + ' })()', 30000);
  }

  async evaluate(fn, ...args) {
    const src = fn.toString();
    const argsSrc = args.length ? ', ' + args.map(lit).join(', ') : '';
    return rawEval(this.page._cdp, '(async () => { const __el = window.__tripoEmbedShim.el(' + this._id + '); '
      + 'if (!__el) throw new Error("元素已失效"); return await (' + src + ')(__el' + argsSrc + '); })()', 45000);
  }

  async evaluateHandle(fn, ...args) {
    const src = fn.toString();
    const argsSrc = args.length ? ', ' + args.map(lit).join(', ') : '';
    const id = await rawEval(this.page._cdp, '(async () => { const __el = window.__tripoEmbedShim.el(' + this._id + '); '
      + 'if (!__el) return 0; return window.__tripoEmbedShim.add(await (' + src + ')(__el' + argsSrc + ')); })()', 30000);
    return id ? new EmbedHandle(this.page, id) : null;
  }

  async $$(sel) {
    const ids = await rawEval(this.page._cdp, 'window.__tripoEmbedShim.query(' + this._id + ', ' + lit(String(sel)) + ')', 20000);
    return (ids || []).map(id => new EmbedHandle(this.page, id));
  }

  $(sel) {
    return this.$$(sel).then(list => list[0] || null);
  }

  getAttribute(name) {
    return this.evaluate((el, n) => el.getAttribute(n), String(name));
  }

  isVisible() {
    return this.evaluate(el => window.__tripoEmbedShim.visible(el)).catch(() => false);
  }

  innerText() {
    return this.evaluate(el => el.innerText || '').catch(() => '');
  }

  boundingBox() {
    return this._eval('const r = window.__tripoEmbedShim.rect(' + this._id + ', true); '
      + 'return (r && r.width > 0 && r.height > 0) ? r : null;').catch(() => null);
  }

  async click(opts = {}) {
    const visible = await this.isVisible().catch(() => false);
    if (!visible && !opts.force) throw new Error('元素不可见');
    await this._eval('window.__tripoEmbedShim.scroll(' + this._id + '); return true;').catch(() => {});
    const r = await this._eval('return window.__tripoEmbedShim.rect(' + this._id + ', false);').catch(() => null);
    if (!r || r.width <= 0 || r.height <= 0) {
      if (!opts.force) throw new Error('元素没有可点击区域');
      // force 且尺寸为 0：退化成页面内 click()，至少让 DOM 事件链跑起来
      await this.evaluate(el => { el.click(); return true; }).catch(() => {});
      return;
    }
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const cdp = this.page._cdp;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, 8000).catch(() => {});
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, 8000);
    await sleep(24);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, 8000);
  }

  fill(value) {
    return this.evaluate((el, v) => window.__tripoEmbedShim.setNative(el, v), String(value));
  }

  async setInputFiles(files) {
    const list = normalizeFiles(files);
    if (!list.length) throw new Error('没有可上传的文件');
    const r = await this.page._cdp.send('Runtime.evaluate', {
      expression: 'window.__tripoEmbedShim.el(' + this._id + ')',
      returnByValue: false
    }, 15000);
    const objectId = r.result && r.result.objectId;
    if (!objectId) throw new Error('上传控件已失效');
    await this.page._cdp.send('DOM.setFileInputFiles', { files: list, objectId }, 30000);
  }

  async screenshot(opts = {}) {
    const r = await this._eval('return window.__tripoEmbedShim.rect(' + this._id + ', true);').catch(() => null);
    if (!r || r.width <= 0 || r.height <= 0) throw new Error('元素没有可截取区域');
    const res = await this.page._cdp.send('Page.captureScreenshot', {
      format: opts.type === 'jpeg' ? 'jpeg' : 'png',
      captureBeyondViewport: true,
      clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }
    }, 30000);
    return Buffer.from(res.data || '', 'base64');
  }
}

function normalizeFiles(files) {
  const arr = Array.isArray(files) ? files : [files];
  return arr.filter(Boolean).map(f => {
    if (typeof f === 'string') return path.resolve(f);
    if (f && typeof f.path === 'string') return path.resolve(f.path);
    throw new Error('setInputFiles 只接受文件路径');
  });
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */
class EmbedPage {
  constructor(context, cdp, target) {
    this._ctx = context;
    this._cdp = cdp;
    this._target = target || {};
    this._url = String(this._target.url || '');
    this._title = String(this._target.title || '');
    this._closed = false;
    this.__rec = false;
    this.keyboard = {
      insertText: text => this._keyboardInsert(String(text)),
      press: key => this._keyboardPress(String(key))
    };
    this.mouse = {
      click: async (x, y) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }).catch(() => {});
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
      }
    };
    this._initEvents();
  }

  _initEvents() {
    const cdp = this._cdp;
    cdp.on('Page.frameNavigated', p => {
      const f = p && p.frame;
      if (f && !f.parentId && f.url && f.url !== 'about:blank') this._url = f.url;
    });
    cdp.on('Page.navigatedWithinDocument', p => {
      if (p && p.url) this._url = p.url;
    });
    cdp.on('__close', () => {
      this._closed = true;
      this._ctx._closed = true;
      this._ctx._emit('close', []);
    });
    this._urlTimer = setInterval(() => {
      if (this._closed) return;
      rawEval(cdp, 'location.href', 4000).then(u => { if (u) this._url = String(u); }).catch(() => {});
    }, 1200);
    if (this._urlTimer.unref) this._urlTimer.unref();
  }

  isClosed() { return this._closed || this._cdp.closed; }

  url() { return this._url || ''; }

  async title() {
    const t = await rawEval(this._cdp, 'document.title || ""', 8000).catch(() => '');
    this._title = String(t || this._title || '');
    return this._title;
  }

  evaluate(fn, ...args) {
    const src = fn.toString();
    const argsSrc = args.length ? args.map(lit).join(', ') : '';
    return rawEval(this._cdp, '(async () => await (' + src + ')(' + argsSrc + '))()', 45000);
  }

  async evaluateHandle(fn, ...args) {
    const src = fn.toString();
    const argsSrc = args.length ? ', ' + args.map(lit).join(', ') : '';
    const id = await rawEval(this._cdp, '(async () => window.__tripoEmbedShim.add(await (' + src + ')(' + argsSrc + ')))()', 30000);
    return id ? new EmbedHandle(this, id) : null;
  }

  async $$(sel) {
    const ids = await rawEval(this._cdp, 'window.__tripoEmbedShim.query(0, ' + lit(String(sel)) + ')', 20000);
    return (ids || []).map(id => new EmbedHandle(this, id));
  }

  $(sel) {
    return this.$$(sel).then(list => list[0] || null);
  }

  async goto(url, opts = {}) {
    await this._ensurePage();
    const done = this._waitEvent('Page.domContentEventFired', Number(opts.timeout) || 60000);
    const r = await this._cdp.send('Page.navigate', { url: String(url) }, 30000).catch(e => ({ __err: e.message }));
    if (r && r.__err) throw new Error(r.__err);
    if (r && r.errorText) throw new Error(r.errorText);
    this._url = String(url);
    await done.catch(() => {});
    return null;
  }

  async reload(opts = {}) {
    await this._ensurePage();
    const done = this._waitEvent('Page.domContentEventFired', Number(opts.timeout) || 60000);
    await this._cdp.send('Page.reload', { ignoreCache: false }, 30000);
    await done.catch(() => {});
    return null;
  }

  bringToFront() {
    return this._cdp.send('Page.bringToFront', {}, 5000).catch(() => {});
  }

  async screenshot(opts = {}) {
    const res = await this._cdp.send('Page.captureScreenshot', {
      format: opts.type === 'jpeg' ? 'jpeg' : 'png'
    }, 30000);
    return Buffer.from(res.data || '', 'base64');
  }

  waitForTimeout(ms) { return sleep(ms); }

  /* 只实现 tripo-web.js 用到的事件：filechooser */
  waitForEvent(name, opts = {}) {
    if (name !== 'filechooser') return Promise.reject(new Error('不支持的事件：' + name));
    const cdp = this._cdp;
    const timeout = Number(opts.timeout) || 30000;
    return new Promise(resolve => {
      let done = false;
      const finish = value => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cdp.off('Page.fileChooserOpened', onOpen);
        if (!value) cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
        resolve(value);
      };
      const onOpen = p => {
        finish({
          setFiles: async files => {
            const list = normalizeFiles(files);
            await cdp.send('DOM.setFileInputFiles', { files: list, backendNodeId: p.backendNodeId }, 30000);
            await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
          }
        });
      };
      const timer = setTimeout(() => finish(null), timeout);
      cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, 5000)
        .then(() => cdp.on('Page.fileChooserOpened', onOpen))
        .catch(() => finish(null));
    });
  }

  on(event, fn) {
    this._listeners = this._listeners || new Map();
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    this._wireEvent(event);
    return this;
  }

  off(event, fn) {
    const set = this._listeners && this._listeners.get(event);
    if (set) set.delete(fn);
  }

  _emitLocal(event, args) {
    const set = this._listeners && this._listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn.apply(null, args); } catch (e) { /* ignore */ }
    }
  }

  /* 网络事件只在页面登记过监听时才挂 CDP，避免把每个请求都搬进进程内存 */
  _wireEvent(event) {
    const cdp = this._cdp;
    this._wired = this._wired || new Set();
    if (this._wired.has(event)) return;
    this._wired.add(event);
    if (event === 'request') {
      cdp.send('Network.enable', { maxTotalBufferSize: 32 * 1024 * 1024 }, 10000).catch(() => {});
      cdp.on('Network.requestWillBeSent', p => {
        const req = p && p.request;
        if (!req || !API_HOST_RE.test(req.url || '')) return;
        this._emitLocal('request', [{
          method: () => req.method,
          url: () => req.url,
          postData: () => req.postData || ''
        }]);
      });
    } else if (event === 'response') {
      cdp.send('Network.enable', { maxTotalBufferSize: 32 * 1024 * 1024 }, 10000).catch(() => {});
      const meta = new Map();
      cdp.on('Network.responseReceived', p => {
        const r = p && p.response;
        if (!r || !API_HOST_RE.test(r.url || '')) return;
        meta.set(p.requestId, { url: r.url, status: r.status });
      });
      cdp.on('Network.loadingFinished', p => {
        const it = meta.get(p.requestId);
        if (!it) return;
        meta.delete(p.requestId);
        cdp.send('Network.getResponseBody', { requestId: p.requestId }, 8000)
          .then(r => {
            const text = r && r.body ? (r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body) : '';
            this._emitLocal('response', [{
              url: () => it.url,
              status: () => it.status,
              text: async () => text
            }]);
          })
          .catch(() => {});
      });
    }
  }

  async _keyboardInsert(text) {
    await rawEval(this._cdp, 'window.__tripoEmbedShim.insertText(' + lit(text) + ')', 20000);
  }

  async _keyboardPress(key) {
    if (/^(control|ctrl|cmd|meta)\s*\+\s*a$/i.test(key)) {
      await rawEval(this._cdp, '(() => { const el = document.activeElement; if (!el) return false; '
        + 'try { if (el.select) el.select(); document.execCommand("selectAll"); } catch (e) {} return true; })()', 10000);
      return;
    }
    if (/^escape$/i.test(key)) {
      // guest 通常拿不到真实键盘焦点，Input 事件可能落空；页面内补一份事件，两个都发
      await this._cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
      }, 5000).catch(() => {});
      await this._cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
      }, 5000).catch(() => {});
      await rawEval(this._cdp, '(() => { const t = document.activeElement || document.body; '
        + 'const e = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }); '
        + 'try { t.dispatchEvent(e); } catch (err) {} try { document.dispatchEvent(e); } catch (err) {} return true; })()', 8000).catch(() => {});
      return;
    }
    const vk = ({ Enter: 13, Tab: 9, Backspace: 8, Delete: 46 })[key] || 0;
    if (!vk) return;
    const code = key === 'Enter' ? 'Enter' : key;
    await this._cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, 5000).catch(() => {});
    await this._cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, 5000).catch(() => {});
  }

  _ensurePage() {
    return this._cdp.send('Page.enable', {}, 8000).catch(() => {});
  }

  _waitEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const off = this._cdp.on(method, () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        resolve();
      });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        off();
        reject(new Error('等待页面加载超时'));
      }, Math.max(3000, timeoutMs));
    });
  }
}

/* ------------------------------------------------------------------ *
 * 上下文（download / pages / request）
 * ------------------------------------------------------------------ */
class EmbedContext {
  constructor(page, outDir) {
    this._page = page;
    this._outDir = outDir;
    this._closed = false;
    this._listeners = new Map();
    this._poll = null;
    this._seen = new Set();
    this._blobSeen = new Set();
    this._busy = false;
    this.__embedded = true;
  }

  pages() { return this._page && !this._page.isClosed() ? [this._page] : []; }

  newPage() { return Promise.resolve(this._page); }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    if (event === 'download') this._startPoll();
    return this;
  }

  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) set.delete(fn);
  }

  addInitScript(fn) {
    return this._page._cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: '(' + fn.toString() + ')()'
    }, 8000).catch(() => {});
  }

  get request() {
    const req = {
      get: async (url, opts = {}) => {
        const timeout = Math.max(3000, Number(opts.timeout) || 30000);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
          const res = await fetch(url, { signal: ctrl.signal });
          const buf = Buffer.from(await res.arrayBuffer());
          return {
            ok: () => res.ok,
            status: () => res.status,
            headers: () => {
              const out = {};
              res.headers.forEach((v, k) => { out[k] = v; });
              return out;
            },
            body: async () => buf
          };
        } finally {
          clearTimeout(timer);
        }
      }
    };
    return req;
  }

  _emit(event, args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn.apply(null, args); } catch (e) { /* ignore */ }
    }
  }

  _startPoll() {
    if (this._poll) return;
    try { fs.mkdirSync(this._outDir, { recursive: true }); } catch (e) { /* ignore */ }
    this._seen = new Set(readdir(this._outDir));
    this._poll = setInterval(() => this._tick(), 800);
    if (this._poll.unref) this._poll.unref();
  }

  async _tick() {
    if (this._busy || this._closed) return;
    const hasDl = (this._listeners.get('download') || new Set()).size > 0;
    if (!hasDl) return;
    this._busy = true;
    try {
      // ① 主进程把真实 HTTP 下载落到 OUT_DIR（.incoming 中转后重命名），这里只认完整文件
      for (const name of readdir(this._outDir)) {
        if (this._seen.has(name)) continue;
        this._seen.add(name);
        const file = path.join(this._outDir, name);
        let st = null;
        try { st = fs.statSync(file); } catch (e) { continue; }
        if (!st.isFile() || st.size <= 0) continue;
        this._emitDownload(name, file);
      }
      // ② blob: 下载：页面钩子只记 href，这里取回内容再落盘
      const items = await this._page.evaluate(() => (window.__tripoEmbedShim && window.__tripoEmbedShim.downloads || []).slice())
        .catch(() => []);
      for (const it of items) {
        if (!it || !it.href || this._blobSeen.has(it.href)) continue;
        this._blobSeen.add(it.href);
        const dataUrl = await this._page.evaluate(async href => {
          const r = await fetch(href);
          const b = await r.blob();
          return await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = () => rej(new Error('读取失败'));
            fr.readAsDataURL(b);
          });
        }, it.href).catch(() => '');
        const decoded = decodeDataUrl(dataUrl);
        if (!decoded) continue;
        const safe = safeName(it.name).replace(/\.[a-z0-9]+$/i, '') || 'download';
        const name = 'embedded_' + stamp() + '_' + safe + decoded.ext;
        const file = path.join(this._outDir, name);
        try { fs.writeFileSync(file, decoded.buffer); } catch (e) { continue; }
        this._seen.add(name);
        this._emitDownload(name, file);
      }
    } finally {
      this._busy = false;
    }
  }

  _emitDownload(name, file) {
    const dl = {
      suggestedFilename: () => name,
      saveAs: async dest => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await fs.promises.copyFile(file, dest);
      }
    };
    this._emit('download', [dl]);
  }
}

function readdir(dir) {
  try { return fs.readdirSync(dir); } catch (e) { return []; }
}

function safeName(name) {
  return String(name || 'download').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'download';
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  const ct = m[1] || 'application/octet-stream';
  try {
    const buffer = m[2]
      ? Buffer.from(m[3], 'base64')
      : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    return { buffer, ext: extFromType(ct, '') };
  } catch (e) {
    return null;
  }
}

function extFromType(ct, url) {
  if (ct && ct.includes('jpeg')) return '.jpg';
  if (ct && ct.includes('webp')) return '.webp';
  if (ct && ct.includes('gif')) return '.gif';
  if (ct && ct.includes('png')) return '.png';
  if (ct && /gltf|model|octet-stream/i.test(ct)) {
    const m = /\.(glb|gltf|obj|fbx|stl|zip)(\?|$)/i.exec(url || '');
    return m ? '.' + m[1].toLowerCase() : '.glb';
  }
  if (ct && ct.includes('zip')) return '.zip';
  const m = /\.(png|jpe?g|webp|gif|glb|gltf|obj|fbx|stl|zip)(\?|$)/i.exec(url || '');
  return m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '.glb';
}

/* ------------------------------------------------------------------ *
 * 发现 guest / 建立连接
 * ------------------------------------------------------------------ */
async function listTargets(cdpBase, timeoutMs = 3000) {
  const base = String(cdpBase || '').replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + '/json/list', { signal: ctrl.signal });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function pickGuest(list) {
  const items = (list || []).filter(t => t && t.webSocketDebuggerUrl
    && String(t.type || '').toLowerCase() === 'webview'
    && TRIPO_HOST_RE.test(String(t.url || '')));
  if (!items.length) return null;
  // App 内嵌视图带 openagi_embed=1 标记；浏览器 App 里手动打开的 Tripo 页没有。
  // 优先标记，其次才退到任意 studio 页（标记可能被站点重定向丢掉）。
  const marked = items.find(t => /openagi_embed=1/i.test(String(t.url || '')));
  if (marked) return marked;
  const studio = items.find(t => /studio\.tripo3d\.(com|ai)\//i.test(String(t.url || '')));
  return studio || items[0];
}

async function findGuest(cdpBase, timeoutMs = 6000, intervalMs = 350) {
  const deadline = Date.now() + Math.max(500, timeoutMs);
  while (Date.now() < deadline) {
    // 单次 HTTP 探测不能吃满整个预算：/status 每轮只给 350ms，这里若固定等 2.5s 会拖住状态轮询
    const remain = Math.max(300, deadline - Date.now());
    const guest = pickGuest(await listTargets(cdpBase, Math.min(2500, remain)));
    if (guest) return guest;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return null;
}

/**
 * 连接 App 内嵌的 Tripo guest。
 * @param {{cdpBase:string, outDir:string, timeoutMs?:number}} opts
 * @returns {Promise<{context: EmbedContext, page: EmbedPage, target: object}|null>}
 */
async function connect(opts = {}) {
  const cdpBase = String(opts.cdpBase || '').replace(/\/+$/, '');
  if (!cdpBase) return null;
  const target = await findGuest(cdpBase, Math.max(800, Number(opts.timeoutMs) || 6000));
  if (!target) return null;

  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.connect();
  try {
    await cdp.send('Runtime.enable', {}, 8000);
    await cdp.send('Page.enable', {}, 8000);
    await cdp.send('DOM.enable', {}, 8000);
    // 新文档也装上钩子；当前文档单独补一份（webview 可能早就加载完了）
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bootstrapSource() }, 8000).catch(() => {});
    await rawEval(cdp, bootstrapSource(), 8000).catch(() => {});

    /* webview 刚创建时 /json/list 会先报出即将跳转的 URL，此时渲染进程还停在
       about:blank。等它真正 commit 再交出去，避免调用方对着空文档点按钮。 */
    for (let i = 0; i < 8; i++) {
      const href = await rawEval(cdp, 'location.href', 3000).catch(() => '');
      if (href && href !== 'about:blank') break;
      await sleep(250);
    }

    const page = new EmbedPage(null, cdp, target);
    const context = new EmbedContext(page, opts.outDir || path.join(__dirname, 'tripo_out'));
    page._ctx = context;
    return { context, page, target };
  } catch (e) {
    try { cdp.wire.close(); } catch (err) { /* ignore */ }
    throw e;
  }
}

module.exports = {
  connect,
  findGuest,
  listTargets,
  pickGuest,
  TRIPO_HOST_RE,
  _internals: { Wire, Cdp, bootstrapSource, decodeDataUrl, extFromType }
};
