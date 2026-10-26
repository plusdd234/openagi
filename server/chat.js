/* 交流社区服务（零依赖，SSE 长连接）
 *
 * 形态：一个大厅（类似一个大群）。客户端用 EventSource 订阅 /chat/events，
 * 发消息走 POST /chat/messages。为什么不用 WebSocket：SSE 是普通 HTTP，
 * 天然穿代理、天然自动重连，而我们只需要「服务端 → 客户端」推送，够用且更稳。
 *
 * 端点：
 *   GET  /chat/events?since=&cid=&name=    text/event-stream（先补历史，再推实时）
 *   POST /chat/messages {cid,name,text}    发消息
 *   GET  /chat/state                       {online,total,lastId}
 *   POST /chat/delete  {key,id}            管理员删除（key = CHAT_ADMIN_KEY）
 *   GET  /healthz
 *
 * 存储：server/data/chat.jsonl（追加写，启动时裁剪到最近 2000 条）。
 * 内容安全：长度 / 频率 / 关键词（config.json 的 chatBlockWords），删除用 tombstone 记录。
 *
 * 启动：node server/chat.js --port=8792
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = argv.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if(!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : 'true';
};

const PORT = Number(process.env.CHAT_PORT || arg('port', '8792')) || 8792;
const DATA_DIR = process.env.GATEWAY_DATA || arg('data', path.join(__dirname, 'data'));
const STORE_FILE = path.join(DATA_DIR, 'chat.jsonl');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ADMIN_KEY = process.env.CHAT_ADMIN_KEY || arg('admin', '');

const DEFAULTS = { chatBlockWords: [], chatRateMs: 1500, chatMaxLen: 500, chatKeep: 2000, chatNameMax: 16, chatHeartbeatMs: 45000 };
const CFG = (() => {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e){}
  return Object.assign({}, DEFAULTS, saved);
})();

/* ---------- 消息存储（JSONL + 内存镜像） ---------- */
let MSGS = [];              // [{ id, at, cid, name, text }]
const DELETED = new Set();  // tombstone
let seq = 0;

function loadMsgs(){
  let raw = '';
  try { raw = fs.readFileSync(STORE_FILE, 'utf8'); } catch(e){ raw = ''; }
  const rows = [];
  raw.split('\n').forEach(line => {
    if(!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch(e){ return; }
    if(o && o.deleted && o.id){ DELETED.add(String(o.id)); return; }
    if(o && o.id && o.text != null) rows.push({
      id: String(o.id),
      at: Number(o.at) || Date.now(),
      cid: String(o.cid || ''),
      name: String(o.name || '访客'),
      text: String(o.text)
    });
  });
  MSGS = rows.filter(m => !DELETED.has(m.id)).slice(-Number(CFG.chatKeep) || -2000);
  seq = MSGS.reduce((s, m) => Math.max(s, Number(String(m.id).split('-').pop()) || 0), 0);
  // 裁剪文件：只留最近 chatKeep 条，避免无限增长
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const keep = MSGS.slice(-Number(CFG.chatKeep));
    fs.writeFileSync(STORE_FILE, keep.map(m => JSON.stringify(m)).join('\n') + (keep.length ? '\n' : ''));
  } catch(e){}
}
function appendLine(obj){
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(STORE_FILE, JSON.stringify(obj) + '\n');
  } catch(e){ console.error('[chat] 写入失败：' + e.message); }
}

/* ---------- SSE 连接池 ---------- */
const CLIENTS = new Map();   // key -> { res, cid, name, at }

function sse(res, event, data){
  try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch(e){}
}
function broadcast(event, data, exceptKey){
  for(const [k, c] of CLIENTS){
    if(exceptKey && k === exceptKey) continue;
    try { sse(c.res, event, data); } catch(e){ CLIENTS.delete(k); }
  }
}
function onlineCount(){
  const now = Date.now();
  let n = 0;
  for(const [k, c] of CLIENTS){
    if(now - c.at > 90000){ CLIENTS.delete(k); continue; }
    n++;
  }
  return n;
}

/* ---------- 长轮询（无状态） ----------
 * 不依赖本进程内存里的连接表：每次请求带 since，直接从消息文件尾部读增量。
 * 好处是任意实例都能处理任意请求 —— 这就是横向扩容与负载均衡的前提。 */
const POLLERS = new Map();   // cid -> ts（仅用于"在线"估算）

function readSince(since){
  let buf = '';
  try {
    const fd = fs.openSync(STORE_FILE, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 256 * 1024);
    const b = Buffer.alloc(size - start);
    fs.readSync(fd, b, 0, b.length, start);
    fs.closeSync(fd);
    buf = b.toString('utf8');
  } catch(e){
    return since ? [] : MSGS.slice(-50);
  }
  const deleted = new Set();
  const rows = [];
  buf.split('\n').forEach(line => {
    if(!line.trim() || line[0] !== '{') return;      // 跳过被截断的头半行
    let o;
    try { o = JSON.parse(line); } catch(e){ return; }
    if(o && o.deleted && o.id){ deleted.add(String(o.id)); return; }
    if(o && o.id && o.text != null) rows.push({
      id: String(o.id), at: Number(o.at) || 0,
      cid: String(o.cid || ''), name: String(o.name || '访客'), text: String(o.text)
    });
  });
  const seen = new Set();
  const list = rows.filter(m => {
    if(deleted.has(m.id) || seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  if(!since) return list.slice(-50);
  const i = list.findIndex(m => m.id === since);
  return i >= 0 ? list.slice(i + 1) : list.slice(-50);
}

function pollActiveCount(){
  const now = Date.now();
  let n = 0;
  for(const [k, ts] of POLLERS){
    if(now - ts > 60000) POLLERS.delete(k); else n++;
  }
  return n;
}

/* ---------- 限流 ---------- */
const lastSend = new Map();   // cid -> ts
const dupGuard = new Map();   // cid -> {text, count, at}

/* ---------- HTTP ---------- */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,accept',
  'access-control-max-age': '600'
};
function json(res, status, obj){
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  }, CORS));
  res.end(body);
}
function readBody(req, limitKB){
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if(size > (limitKB || 64) * 1024){ reject(new Error('内容过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if(!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch(e){ reject(new Error('格式不正确')); }
    });
    req.on('error', reject);
  });
}
function cleanName(raw){
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (s || '访客').slice(0, Number(CFG.chatNameMax) || 16);
}
function cleanText(raw){
  return String(raw || '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}
function blocked(text){
  const words = Array.isArray(CFG.chatBlockWords) ? CFG.chatBlockWords : [];
  if(!words.length) return '';
  const low = text.toLowerCase();
  for(const w of words){
    const k = String(w || '').toLowerCase().trim();
    if(k && low.indexOf(k) >= 0) return k;
  }
  return '';
}
function nextId(){
  seq = (seq + 1) % 1000000;
  return Date.now().toString(36) + '-' + seq.toString(36);
}

const server = http.createServer(async (req, res) => {
  if(req.method === 'OPTIONS'){ res.writeHead(204, CORS); return res.end(); }
  let pathname = '/';
  let query = new URLSearchParams();
  try {
    const u = new URL(req.url, 'http://x');
    pathname = decodeURIComponent(u.pathname);
    query = u.searchParams;
  } catch(e){}

  try {
    if(pathname === '/healthz'){
      return json(res, 200, { ok: true, online: onlineCount(), messages: MSGS.length });
    }

    if(pathname === '/chat/state'){
      return json(res, 200, {
        ok: true,
        online: onlineCount() + pollActiveCount(),
        total: MSGS.length,
        lastId: MSGS.length ? MSGS[MSGS.length - 1].id : ''
      });
    }

    if(pathname === '/chat/events' && req.method === 'GET'){
      const cid = String(query.get('cid') || '').slice(0, 64);
      const name = cleanName(query.get('name'));
      const since = String(query.get('since') || '');
      res.writeHead(200, Object.assign({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no'
      }, CORS));
      res.write('retry: 3000\n\n');
      // 关掉应用层心跳时靠内核 keepalive 兜底（探测半开连接）
      try { req.socket.setKeepAlive(true, 30000); } catch(e){}

      // 先补历史：客户端带 since 就补它之后的，否则给最近 50 条
      let backlog = MSGS.slice(-50);
      if(since){
        const i = MSGS.findIndex(m => m.id === since);
        backlog = i >= 0 ? MSGS.slice(i + 1) : MSGS.slice(-50);
      }
      backlog.slice(-100).forEach(m => sse(res, 'message', m));

      const key = cid || crypto.randomBytes(6).toString('hex');
      CLIENTS.set(key, { res, cid: key, name, at: Date.now() });
      sse(res, 'hello', { cid: key, online: onlineCount(), lastId: MSGS.length ? MSGS[MSGS.length - 1].id : '' });
      broadcast('online', { online: onlineCount() });

      req.on('close', () => {
        CLIENTS.delete(key);
        broadcast('online', { online: onlineCount() });
      });
      return;
    }

    if(pathname === '/chat/poll' && req.method === 'GET'){
      const cid = String(query.get('cid') || '').slice(0, 64) || ('anon-' + crypto.randomBytes(4).toString('hex'));
      const since = String(query.get('since') || '');
      const wait = Math.min(30000, Math.max(0, Number(query.get('wait')) || 25000));
      POLLERS.set(cid, Date.now());

      const tryRespond = () => {
        const list = readSince(since);
        if(!list.length) return false;
        const online = onlineCount() + pollActiveCount();
        json(res, 200, { ok: true, messages: list, lastId: list[list.length - 1].id, online });
        return true;
      };
      if(tryRespond()) return;

      const deadline = Date.now() + wait;
      const timer = setInterval(() => {
        if(res.writableEnded){ clearInterval(timer); return; }
        if(tryRespond()){ clearInterval(timer); return; }
        if(Date.now() >= deadline){
          clearInterval(timer);
          json(res, 200, { ok: true, messages: [], lastId: since, online: onlineCount() + pollActiveCount() });
        }
      }, 400);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if(pathname === '/chat/messages' && req.method === 'POST'){
      const body = await readBody(req);
      const cid = String(body.cid || '').slice(0, 64) || ('anon-' + crypto.randomBytes(4).toString('hex'));
      const name = cleanName(body.name);
      const text = cleanText(body.text);
      if(!text) return json(res, 400, { error: '内容为空' });
      if(text.length > (Number(CFG.chatMaxLen) || 500)) return json(res, 400, { error: '太长了，最多 ' + CFG.chatMaxLen + ' 字' });

      const hit = blocked(text);
      if(hit) return json(res, 400, { error: '内容包含不允许的词，换个说法试试' });

      // 频率
      const now = Date.now();
      const last = lastSend.get(cid) || 0;
      if(now - last < (Number(CFG.chatRateMs) || 1500)) return json(res, 429, { error: '发太快了，喘口气再说' });
      // 连续复读（同一个人连续三次同一句）
      const dup = dupGuard.get(cid);
      if(dup && dup.text === text && dup.count >= 2 && now - dup.at < 20000){
        return json(res, 429, { error: '重复消息太多，换个话题吧' });
      }
      dupGuard.set(cid, { text, count: (dup && dup.text === text ? dup.count + 1 : 1), at: now });
      lastSend.set(cid, now);

      const msg = { id: nextId(), at: now, cid, name, text };
      MSGS.push(msg);
      if(MSGS.length > (Number(CFG.chatKeep) || 2000) * 2) MSGS = MSGS.slice(-Number(CFG.chatKeep));
      appendLine(msg);
      broadcast('message', msg);
      return json(res, 200, { ok: true, message: msg });
    }

    if(pathname === '/chat/delete' && req.method === 'POST'){
      if(!ADMIN_KEY) return json(res, 403, { error: '服务端没有配置管理密钥（CHAT_ADMIN_KEY）' });
      const body = await readBody(req);
      if(String(body.key || '') !== ADMIN_KEY) return json(res, 403, { error: '管理密钥不正确' });
      const id = String(body.id || '');
      const idx = MSGS.findIndex(m => m.id === id);
      if(idx < 0) return json(res, 404, { error: '消息不存在（可能已删除）' });
      MSGS.splice(idx, 1);
      DELETED.add(id);
      appendLine({ id, deleted: true });
      broadcast('delete', { id });
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: '接口不存在' });
  } catch(e){
    console.error('[chat] ' + ((e && e.stack) || e));
    if(!res.headersSent) json(res, 500, { error: '服务内部错误' });
  }
});

// 心跳与超时清理（chatHeartbeatMs=0 表示不打应用层心跳，只靠 TCP keepalive）
const HB = Number(CFG.chatHeartbeatMs);
if(HB > 0) setInterval(() => {
  for(const [k, c] of CLIENTS){
    if(Date.now() - c.at > 90000){ try { c.res.end(); } catch(e){} CLIENTS.delete(k); continue; }
    try { c.res.write(': ping\n\n'); c.at = Date.now(); }   // 写成功就算活着，别把在线的人清掉
    catch(e){ CLIENTS.delete(k); }
  }
}, HB).unref();

loadMsgs();
server.requestTimeout = 0;
server.listen(PORT, '0.0.0.0', () => {
  console.log('交流社区服务已启动：http://127.0.0.1:' + PORT);
  console.log('  历史消息：' + MSGS.length + ' 条 · 数据：' + STORE_FILE);
  console.log('  管理删除：' + (ADMIN_KEY ? '已启用（POST /chat/delete）' : '未配置 CHAT_ADMIN_KEY'));
  console.log('  屏蔽词：' + ((CFG.chatBlockWords || []).length || '未配置') + ' 个');
});
