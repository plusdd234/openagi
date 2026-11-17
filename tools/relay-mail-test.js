/* IMAP 收信 / SMTP 发信模块的自测（纯 Node，不联网）。
 *
 * 起本机假 IMAP 与假 SMTP 服务器，验证：
 *   IMAP：LOGIN / XOAUTH2 → SELECT → FETCH → LOGOUT、邮件解码、鉴权失败提示；
 *   SMTP：AUTH LOGIN / XOAUTH2 → MAIL/RCPT/DATA/QUIT、中文主题与正文编码。
 * 运行：node tools/relay-mail-test.js
 */
'use strict';

process.env.RELAY_MAIL_TEST = '1';

const net = require('net');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const assert = require('assert');
const { imapFetch } = require('../plugins/relay/mail');
const { smtpSend } = require('../plugins/relay/smtp');

const RAW = Buffer.from([
  'From: =?UTF-8?B?5L2g5aW9?= <no-reply@example.com>',
  'To: demo@outlook.com',
  'Subject: 登录验证码 123456',
  'Date: Tue, 17 Nov 2026 10:00:00 +0800',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Your code is 123456=2E'
].join('\r\n'), 'utf8');

/* 假 IMAP：同时支持 LOGIN 与 AUTHENTICATE XOAUTH2。 */
function startFake() {
  return new Promise(resolve => {
    const server = net.createServer(sock => {
      sock.write('* OK fake imap ready\r\n');
      let buf = '';
      let authPending = false;
      let rejectPending = false;
      sock.on('data', d => {
        buf += d.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (rejectPending) {
            /* XOAUTH2 失败后客户端会补一个空行，这时才给 NO。 */
            rejectPending = false;
            sock.write('A1 NO [AUTHENTICATE failed] Invalid token\r\n');
            continue;
          }
          if (authPending) {
            authPending = false;
            const decoded = Buffer.from(line.trim(), 'base64').toString('utf8');
            if (decoded === 'user=demo@outlook.com\x01auth=Bearer goodtoken\x01\x01') {
              sock.write('A1 OK AUTHENTICATE completed\r\n');
            } else {
              const chal = Buffer.from('{"status":"401","schemes":"Bearer"}', 'utf8').toString('base64');
              sock.write('+ ' + chal + '\r\n');
              rejectPending = true;
            }
            continue;
          }
          if (/^A1 AUTHENTICATE XOAUTH2/i.test(line)) {
            authPending = true;
            sock.write('+ \r\n');
          } else if (/^A1 LOGIN /i.test(line)) {
            if (/secret/.test(line)) sock.write('A1 OK LOGIN completed\r\n');
            else sock.write('A1 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n');
          } else if (/^A2 SELECT/i.test(line)) {
            sock.write('* 2 EXISTS\r\n* 0 RECENT\r\n* FLAGS (\\Seen)\r\n');
            sock.write('A2 OK [READ-WRITE] SELECT completed\r\n');
          } else if (/^A3 FETCH/i.test(line)) {
            sock.write('* 2 FETCH (UID 77 FLAGS (\\Seen) INTERNALDATE "17-Nov-2026 10:00:00 +0800" BODY[] {' +
              RAW.length + '}\r\n');
            sock.write(RAW);
            sock.write(')\r\nA3 OK FETCH completed\r\n');
          } else if (/^A4 LOGOUT/i.test(line)) {
            sock.write('* BYE\r\nA4 OK LOGOUT completed\r\n');
            sock.end();
          }
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* 假 SMTP：明文（测试模式允许 starttls:false），支持 AUTH LOGIN 与 XOAUTH2。 */
function startSmtp() {
  return new Promise(resolve => {
    let last = '';
    const server = net.createServer(sock => {
      sock.write('220 fake smtp ready\r\n');
      let buf = '';
      let mode = 'cmd';
      let authUser = '';
      const dataLines = [];
      const reply = t => sock.write(t + '\r\n');
      sock.on('data', d => {
        buf += d.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (mode === 'data') {
            if (line === '.') {
              mode = 'cmd';
              last = dataLines.join('\r\n');
              reply('250 2.0.0 queued');
            } else {
              dataLines.push(line.charAt(0) === '.' ? line.slice(1) : line);
            }
            continue;
          }
          if (mode === 'login-user') {
            authUser = Buffer.from(line, 'base64').toString('utf8');
            mode = 'login-pass';
            reply('334 UGFzc3dvcmQ6');
            continue;
          }
          if (mode === 'login-pass') {
            const pass = Buffer.from(line, 'base64').toString('utf8');
            mode = 'cmd';
            reply(authUser === 'demo@outlook.com' && pass === 'secret' ? '235 2.7.0 ok' : '535 5.7.8 bad');
            continue;
          }
          if (mode === 'xoauth-empty') {
            mode = 'cmd';
            reply('535 5.7.139 bad token');
            continue;
          }
          if (/^EHLO /i.test(line)) {
            sock.write('250-fake\r\n250-AUTH LOGIN XOAUTH2\r\n250 OK\r\n');
          } else if (/^AUTH LOGIN/i.test(line)) {
            mode = 'login-user';
            reply('334 VXNlcm5hbWU6');
          } else if (/^AUTH XOAUTH2 /i.test(line)) {
            const dec = Buffer.from(line.slice(13).trim(), 'base64').toString('utf8');
            if (dec.indexOf('auth=Bearer goodtoken') >= 0) reply('235 2.7.0 ok');
            else {
              reply('334 ' + Buffer.from('{"status":"401"}', 'utf8').toString('base64'));
              mode = 'xoauth-empty';
            }
          } else if (/^MAIL FROM:/i.test(line)) reply('250 2.1.0 ok');
          else if (/^RCPT TO:/i.test(line)) reply('250 2.1.5 ok');
          else if (/^DATA/i.test(line)) {
            mode = 'data';
            dataLines.length = 0;
            reply('354 go ahead');
          } else if (/^QUIT/i.test(line)) {
            reply('221 bye');
            sock.end();
          } else reply('250 ok');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      last: () => last
    }));
  });
}

function startTokenServer() {
  return new Promise(resolve => {
    let lastForm = '';
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        lastForm = body;
        const q = new URLSearchParams(body);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        const rt = q.get('refresh_token');
        if (rt === 'revoked') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'AADSTS70000: refresh token expired' }));
          return;
        }
        if (q.get('client_id') !== 'client-1' || (rt !== 'refresh-1' && rt !== 'refresh-bad')) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid_request' }));
          return;
        }
        res.end(JSON.stringify({
          access_token: rt === 'refresh-bad' ? 'badtoken' : 'goodtoken',
          token_type: 'Bearer',
          expires_in: 3600
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      lastForm: () => lastForm
    }));
  });
}

async function main() {
  const { server, port } = await startFake();
  const tok = await startTokenServer();
  const smtp = await startSmtp();
  const tokenUrl = 'http://127.0.0.1:' + tok.port + '/token';
  let failed = 0;
  let relay = null;
  try {
    const out = await imapFetch({
      host: '127.0.0.1', port: port, secure: false,
      user: 'demo@outlook.com', password: 'secret', limit: 5
    });
    assert.strictEqual(out.count, 2, '邮箱总数应为 2');
    assert.strictEqual(out.messages.length, 1, '应解析出 1 封邮件');
    const m = out.messages[0];
    assert.strictEqual(m.id, 'imap:77');
    assert.strictEqual(m.subject, '登录验证码 123456');
    assert.strictEqual(m.from.address, 'no-reply@example.com');
    assert.strictEqual(m.from.name, '你好');
    assert.strictEqual(m.seen, true);
    assert.ok(/Your code is 123456\./.test(m.text), '正文应解码 quoted-printable');
    console.log('PASS  IMAP 收取与解码');

    const bad = await imapFetch({
      host: '127.0.0.1', port: port, secure: false,
      user: 'demo@outlook.com', password: 'wrong', limit: 5
    }).then(() => null, e => e);
    assert.ok(bad && /登录失败/.test(bad.message), '鉴权失败应给出中文提示');
    console.log('PASS  鉴权失败提示');

    /* OAuth2：假令牌端点换 access_token，再用 XOAUTH2 登录。 */
    const oauth = await imapFetch({
      host: '127.0.0.1', port: port, secure: false,
      user: 'demo@outlook.com', clientId: 'client-1', refreshToken: 'refresh-1',
      tokenUrl: tokenUrl, limit: 5
    });
    assert.strictEqual(oauth.count, 2, 'OAuth2 收信应读到邮箱总数');
    assert.strictEqual(oauth.messages[0].subject, '登录验证码 123456');
    console.log('PASS  OAuth2（XOAUTH2）收取');

    const revoked = await imapFetch({
      host: '127.0.0.1', port: port, secure: false,
      user: 'demo@outlook.com', clientId: 'client-1', refreshToken: 'revoked',
      tokenUrl: tokenUrl, limit: 5
    }).then(() => null, e => e);
    assert.ok(revoked && /授权已失效/.test(revoked.message), 'refresh_token 失效应给出中文提示');
    console.log('PASS  OAuth2 刷新令牌失效提示');

    const rejected = await imapFetch({
      host: '127.0.0.1', port: port, secure: false,
      user: 'demo@outlook.com', clientId: 'client-1', refreshToken: 'refresh-bad',
      tokenUrl: tokenUrl, limit: 5
    }).then(() => null, e => e);
    assert.ok(rejected && /OAuth2 登录被拒/.test(rejected.message), 'XOAUTH2 被拒应给出中文提示');
    console.log('PASS  XOAUTH2 被拒提示');

    /* SMTP：口令发信，检查主题编码与正文内容。 */
    const send1 = await smtpSend({
      host: '127.0.0.1', port: smtp.port, starttls: false,
      user: 'demo@outlook.com', password: 'secret',
      to: 'friend@example.com', subject: '测试主题', body: '你好，这是一封测试邮件。'
    });
    assert.strictEqual(send1.ok, true);
    const rawMsg = smtp.last();
    assert.ok(/^From: <demo@outlook\.com>$/m.test(rawMsg), '应写入 From');
    assert.ok(/^To: <friend@example\.com>$/m.test(rawMsg), '应写入 To');
    assert.ok(/^Subject: =\?UTF-8\?B\?/.test(rawMsg.replace(/\r\n/g, '\n').split('\n').filter(l => /^Subject:/.test(l))[0] || ''),
      '主题应按 RFC 2047 编码');
    assert.ok(rawMsg.indexOf(Buffer.from('你好，这是一封测试邮件。', 'utf8').toString('base64').slice(0, 16)) >= 0,
      '正文应按 base64 传输');
    console.log('PASS  SMTP 口令发信');

    /* SMTP：OAuth2 发信走 AUTH XOAUTH2。 */
    const send2 = await smtpSend({
      host: '127.0.0.1', port: smtp.port, starttls: false,
      user: 'demo@outlook.com', clientId: 'client-1', refreshToken: 'refresh-1', tokenUrl: tokenUrl,
      to: 'friend@example.com', subject: 'OAuth', body: 'hello'
    });
    assert.strictEqual(send2.ok, true);
    assert.ok(decodeURIComponent(tok.lastForm()).indexOf('SMTP.Send') >= 0,
      '发信应申请 SMTP.Send 权限');
    console.log('PASS  SMTP OAuth2 发信');

    const smtpBad = await smtpSend({
      host: '127.0.0.1', port: smtp.port, starttls: false,
      user: 'demo@outlook.com', password: 'wrong',
      to: 'friend@example.com', subject: 'x', body: 'x'
    }).then(() => null, e => e);
    assert.ok(smtpBad && /发信认证失败/.test(smtpBad.message), '发信鉴权失败应给出中文提示');
    console.log('PASS  SMTP 鉴权失败提示');

    /* 中转路由：起一个真实的 relay 进程，用 HTTP 调 /mail/imap，
     * 确认请求体解析、错误码与返回结构都能被 App 直接消费。 */
    relay = await startRelay();
    const ok = await postJson(relay.port, '/mail/imap', {
      address: 'demo@outlook.com', password: 'secret',
      host: '127.0.0.1', port: port, secure: false, limit: 5
    });
    assert.strictEqual(ok.status, 200, '成功收取应返回 200');
    assert.ok(ok.json && ok.json.ok === true, '应返回 ok:true');
    assert.strictEqual(ok.json.count, 2);
    assert.strictEqual(ok.json.messages.length, 1);
    assert.strictEqual(ok.json.messages[0].subject, '登录验证码 123456');
    console.log('PASS  中转 /mail/imap 路由');

    const oauthRelay = await postJson(relay.port, '/mail/imap', {
      address: 'demo@outlook.com', clientId: 'client-1', refreshToken: 'refresh-1',
      host: '127.0.0.1', port: port, secure: false, limit: 5, tokenUrl: tokenUrl
    });
    assert.strictEqual(oauthRelay.status, 200, 'OAuth2 收取应返回 200');
    assert.ok(oauthRelay.json && oauthRelay.json.ok === true, '应返回 ok:true');
    assert.strictEqual(oauthRelay.json.messages[0].subject, '登录验证码 123456');
    console.log('PASS  中转透传 OAuth2 凭证');

    const smtpRelay = await postJson(relay.port, '/mail/smtp', {
      address: 'demo@outlook.com', password: 'secret', starttls: false,
      host: '127.0.0.1', port: smtp.port,
      to: 'friend@example.com', subject: '经中转发信', body: 'relay smtp'
    });
    assert.strictEqual(smtpRelay.status, 200, 'SMTP 发信应返回 200');
    assert.ok(smtpRelay.json && smtpRelay.json.ok === true, '应返回 ok:true');
    console.log('PASS  中转 /mail/smtp 路由');

    const deny = await postJson(relay.port, '/mail/imap', {
      address: 'demo@outlook.com', password: 'secret',
      host: 'evil.example.com', port: 993, secure: true
    });
    assert.strictEqual(deny.status, 502, '非白名单主机应被拒绝');
    assert.ok(deny.json && /允许列表/.test(String(deny.json.error)), '应说明主机不在允许列表');
    console.log('PASS  中转拒绝非白名单主机');

    const badPass = await postJson(relay.port, '/mail/imap', {
      address: 'demo@outlook.com', password: 'wrong',
      host: '127.0.0.1', port: port, secure: false
    });
    assert.strictEqual(badPass.status, 502);
    assert.ok(/登录失败/.test(String(badPass.json && badPass.json.error)), '口令错误应返回登录失败');
    console.log('PASS  中转转发鉴权错误');
  } catch (e) {
    failed = 1;
    console.error('FAIL  ' + (e && e.message ? e.message : e));
  } finally {
    server.close();
    tok.server.close();
    smtp.server.close();
    if (relay && relay.child) relay.child.kill();
    try { fs.unlinkSync(STORE_FILE); } catch (e) { /* 没有就算了 */ }
  }
  process.exit(failed);
}

const STORE_FILE = path.join(os.tmpdir(), 'relay-mail-test-' + process.pid + '.json');

function startRelay() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'plugins', 'relay', 'relay.js')], {
      env: Object.assign({}, process.env, {
        PORT: '0', HOST: '127.0.0.1',
        RELAY_STORE_FILE: STORE_FILE,
        RELAY_MAIL_TEST: '1', RELAY_NO_PROXY: '1'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      reject(new Error('relay 启动超时：' + out));
    }, 12000);
    const onData = d => {
      out += d.toString();
      const mm = /running: http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (mm && !done) {
        done = true;
        clearTimeout(timer);
        resolve({ child, port: Number(mm[1]) });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('relay 提前退出 ' + code + '：' + out));
    });
  });
}

function postJson(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, res => {
      let txt = '';
      res.on('data', c => { txt += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(txt); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json: json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

main();
