/* 邮箱台凭证检查工具（CLI）。
 *
 * 读取本机中转的存储快照，列出「手动登记」邮箱的凭证完整性与可收发状态。
 * 默认只做静态检查；加 --live 才真的连 IMAP 验证（需要网络，且会用掉一次登录）。
 *
 * 用法：
 *   node tools/mail-cred-check.js                 # 静态检查，连本机 8787 读 store.js
 *   node tools/mail-cred-check.js --live          # 逐个用凭证登录 IMAP 验证
 *   node tools/mail-cred-check.js --json          # 机器可读输出
 *   node tools/mail-cred-check.js --store <file>  # 指定 openagi-store.json
 *
 * 安全：口令与 refresh_token 只在本进程内存里使用，输出一律打码。
 */
'use strict';

const fs = require('fs');
const http = require('http');
const { imapFetch } = require('../plugins/relay/mail');

const IMAP_PRESETS = [
  [/@(outlook|hotmail|live|msn)\.com$/i, 'outlook.office365.com'],
  [/@foxmail\.com$/i, 'imap.qq.com'],
  [/@qq\.com$/i, 'imap.qq.com'],
  [/@gmail\.com$/i, 'imap.gmail.com'],
  [/@163\.com$/i, 'imap.163.com'],
  [/@126\.com$/i, 'imap.126.com'],
  [/@sina\.com$/i, 'imap.sina.com'],
  [/@yahoo\.com$/i, 'imap.mail.yahoo.com'],
  [/@(icloud|me)\.com$/i, 'imap.mail.me.com']
];

const SMTP_HOSTS = new Set([
  'smtp.office365.com', 'smtp-mail.outlook.com', 'smtp.gmail.com', 'smtp.qq.com',
  'smtp.163.com', 'smtp.126.com', 'smtp.sina.com', 'smtp.mail.yahoo.com', 'smtp.mail.me.com'
]);

const SMTP_FOR_IMAP = {
  'outlook.office365.com': 'smtp.office365.com',
  'imap.qq.com': 'smtp.qq.com',
  'imap.gmail.com': 'smtp.gmail.com',
  'imap.163.com': 'smtp.163.com',
  'imap.126.com': 'smtp.126.com',
  'imap.sina.com': 'smtp.sina.com',
  'imap.mail.yahoo.com': 'smtp.mail.yahoo.com',
  'imap.mail.me.com': 'smtp.mail.me.com'
};

function parseArgs(argv) {
  const out = { live: false, json: false, store: '', relay: 'http://127.0.0.1:8787' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') out.live = true;
    else if (a === '--json') out.json = true;
    else if (a === '--store') out.store = String(argv[++i] || '');
    else if (a === '--relay') out.relay = String(argv[++i] || out.relay);
  }
  return out;
}

function maskAddr(addr) {
  const s = String(addr || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  const name = s.slice(0, at);
  return (name.length <= 2 ? name.slice(0, 1) + '*' : name.slice(0, 2) + '***') + s.slice(at);
}

function imapHostOf(addr) {
  for (let i = 0; i < IMAP_PRESETS.length; i++) {
    if (IMAP_PRESETS[i][0].test(String(addr || ''))) return IMAP_PRESETS[i][1];
  }
  return '';
}

function fetchStore(base) {
  return new Promise((resolve, reject) => {
    const url = String(base || '').replace(/\/+$/, '') + '/store.js';
    const req = http.get(url, { timeout: 4000 }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        const i = text.indexOf('window.__OPENAGI_STORE=');
        if (i < 0) { reject(new Error('store.js 内容不认识')); return; }
        let raw = text.slice(i + 'window.__OPENAGI_STORE='.length).trim();
        if (raw.charAt(raw.length - 1) === ';') raw = raw.slice(0, -1);
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('store.js 不是合法 JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('读取本机中转超时')); });
    req.on('error', e => reject(new Error('读取本机中转失败：' + (e && e.message ? e.message : e))));
  });
}

function mailStateOf(store) {
  if (!store) return null;
  let v = store.hf_maildesk_v1;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (e) { return null; }
  }
  return v && typeof v === 'object' ? v : null;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  let store = null;
  if (opt.store) {
    try {
      store = JSON.parse(fs.readFileSync(opt.store, 'utf8'));
    } catch (e) {
      console.error('读取存储文件失败：' + (e && e.message ? e.message : e));
      process.exit(1);
    }
  } else {
    try {
      store = await fetchStore(opt.relay);
    } catch (e) {
      console.error((e && e.message) || e);
      console.error('提示：先启动桌面端 / 本地中转，或用 --store 指定 openagi-store.json');
      process.exit(1);
    }
  }

  const state = mailStateOf(store);
  if (!state) {
    console.log('没有找到邮箱台数据（hf_maildesk_v1）');
    process.exit(0);
  }
  const boxes = (Array.isArray(state.boxes) ? state.boxes : []).filter(b => {
    return b && b.provider === 'manual' && b.address;
  });

  const rows = [];
  let bad = 0;
  for (const b of boxes) {
    const hasPass = !!b.password;
    const oauth = !!(b.clientId && b.refreshToken);
    const imapHost = imapHostOf(b.address);
    const smtpHost = imapHost ? SMTP_FOR_IMAP[imapHost] : '';
    const row = {
      address: b.address,
      masked: maskAddr(b.address),
      credentials: hasPass && oauth ? '口令+OAuth2' : (oauth ? 'OAuth2' : (hasPass ? '口令' : '无')),
      imap: imapHost || '不支持',
      smtp: smtpHost && SMTP_HOSTS.has(smtpHost) ? smtpHost : '不支持',
      lastSync: b.lastSync ? new Date(Number(b.lastSync)).toISOString() : '',
      error: String(b.error || ''),
      live: ''
    };
    if (opt.live) {
      if (!imapHost) {
        row.live = '跳过：域名不在收信列表';
      } else if (!hasPass && !oauth) {
        row.live = '跳过：没有凭证';
        bad++;
      } else {
        try {
          const out = await imapFetch({
            host: imapHost, port: 993, secure: true, user: b.address, limit: 1,
            password: hasPass ? b.password : undefined,
            clientId: oauth ? b.clientId : undefined,
            refreshToken: oauth ? b.refreshToken : undefined
          });
          row.live = '登录成功，共 ' + out.count + ' 封';
        } catch (e) {
          row.live = '失败：' + ((e && e.message) || e);
          bad++;
        }
      }
    }
    rows.push(row);
  }

  if (opt.json) {
    console.log(JSON.stringify({ boxes: rows, failed: bad }, null, 2));
  } else {
    console.log('邮箱台手动邮箱凭证检查（' + (opt.live ? '在线验证' : '静态检查') + '）');
    console.log('共 ' + rows.length + ' 个手动邮箱');
    if (!rows.length) console.log('（没有手动登记的邮箱）');
    rows.forEach(function (r, i) {
      console.log((i + 1) + '. ' + r.masked +
        ' | 凭证 ' + r.credentials +
        ' | IMAP ' + r.imap +
        ' | SMTP ' + r.smtp +
        (r.lastSync ? ' | 上次收信 ' + r.lastSync : '') +
        (r.error ? ' | 最近错误：' + r.error : '') +
        (r.live ? ' | ' + r.live : ''));
    });
    if (opt.live) console.log(bad ? '有 ' + bad + ' 个邮箱验证失败' : '全部可用');
  }
  process.exit(bad ? 1 : 0);
}

main().catch(e => {
  console.error((e && e.message) || e);
  process.exit(1);
});
