'use strict';
/* 命令执行器：给编码 App 提供「跑一下测试/编译」的能力。
 *
 * 这是整个 App 里唯一能执行外部程序的模块，所以四条约束必须先说清楚：
 *
 * 1. **不用 shell。** 除 Windows 上的 .cmd/.bat 垫片（npm/yarn/pnpm 都是），
 *    一律 spawn(exe, argv, {shell:false})。走 shell 意味着模型写的一句话就能
 *    变成重定向、管道、串接 —— 那等于把整个系统交给它。
 *    也正因为不走 shell，`|` `&` `;` 这类字符在参数里毫无意义，
 *    一律提前拒绝并给出人话提示，而不是让命令静默地跑错。
 *
 * 2. **可执行文件白名单 + 只认 PATH。** 不按 cwd 搜（否则仓库里放个 node.cmd
 *    就能被执行），只用 PATH 里的绝对路径。
 *
 * 3. **cwd 锁在工作区内。** 与 code-workspace 用同一套校验（resolve + 前缀 +
 *    realpath 防 junction）。
 *
 * 4. **超时必杀，且杀进程树。** npm 会拉一串子进程，只 kill 父进程会留下一堆
 *    后台 node 进程继续吃 CPU —— 用户看到的却是「命令已结束」。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const MAX_OUT = 200 * 1024;         // 单次运行保留的输出上限
const MAX_CMD = 2000;
const T_MIN = 1000;
const T_DEF = 60 * 1000;
const T_MAX = 300 * 1000;

/* 允许直接调用的可执行文件。刻意短：需要跑 tsc / vitest 时用 npm script 或 npx，
 * 由包管理器决定具体版本 —— 这比在系统里到处找二进制可靠。
 * git 在列是因为「看这次改了什么」「看 diff」是常用动作。 */
const ALLOW = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
  'git',
  'python', 'python3', 'py'
]);

/* 会被 shell 解释、或让参数含义不确定的字符。
 * 提前拒绝比"跑了但结果不对"好 —— 后者模型会当成测试通过。
 *
 * ⚠ 判定必须区分「在引号里」还是「在引号外」，否则会误伤大量合法命令：
 *   `node -e "a(); b()"`、`()=>{}`、`for(let i=0;i<n;i++)` 里都有 ; < >，
 *   它们只是**程序自己的语法**，从来不是 shell 语法。第一版按整串匹配，
 *   结果这些命令全被以「不支持管道」拒掉 —— 报错信息还完全对不上原因。
 *
 * 引号外才拦：| & ; < > ^ ` 换行
 * 任何位置都拦：％（cmd 会展开 %VAR%，引号挡不住）、$(
 */
const SHELL_MEAN = {
  '|': '管道', '&': '串接或后台', ';': '串接', '<': '输入重定向',
  '>': '输出重定向', '^': '转义符', '`': '命令替换', '\n': '换行', '\r': '换行'
};

function findBad(s) {
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && q && (s[i + 1] === '"' || s[i + 1] === '\\')) { i++; continue; }
    if (ch === '"') { q = !q; continue; }
    if (ch === '%') return { ch: '%', why: '环境变量展开' };
    if (ch === '$' && s[i + 1] === '(') return { ch: '$(', why: '命令替换' };
    if (!q && SHELL_MEAN[ch]) return { ch: ch, why: SHELL_MEAN[ch] };
  }
  return null;
}

function lastSeg(p) { return String(p || '').split(path.sep).pop(); }

function stripExt(name) {
  return String(name || '').replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

/* ---- 命令行切分 ----
 * 只处理「空格分隔 + 双引号包住含空格的参数」这一种形态，够用且可预期。
 * 单引号在 Windows 上不是引号字符，所以不特殊处理（会在参数里原样保留）。 */
function tokenize(s) {
  const out = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && quoted && (s[i + 1] === '"' || s[i + 1] === '\\')) {
      cur += s[i + 1]; i++; has = true; continue;
    }
    if (ch === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch; has = true;
  }
  if (has) out.push(cur);
  return out;
}

/* ---- 在 PATH 里找可执行文件 ----
 * 注意：只在 PATH 目录里找，**不看 cwd**。 */
function whichIn(exe) {
  const exts = IS_WIN
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const dirs = String(process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  const names = [];
  if (IS_WIN) {
    const hasExt = /\.(exe|cmd|bat|com)$/i.test(exe);
    for (const e of exts) names.push(hasExt ? exe : exe + e.toLowerCase(), hasExt ? exe : exe + e.toUpperCase());
  } else {
    names.push(exe);
  }
  const seen = new Set();
  for (const d of dirs) {
    let dir;
    try { dir = path.resolve(d); } catch (e) { continue; }
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const n of names) {
      const full = path.join(dir, n);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        if (!IS_WIN && !(st.mode & 0o111)) continue;
        return full;
      } catch (e) { /* 不存在就继续 */ }
    }
  }
  return '';
}

/* ---- 输出解码 ----
 * Windows 上 cmd 自带命令和部分工具吐 GBK。按 UTF-8 严格解，失败再退回 GBK。
 * 只在「完整行」上做（调用方保证），否则多字节字符会被切在块边界上误判。 */
function decodeBuf(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return buf.toString('utf8'); }
  }
}

/* ---- 参数在 cmd.exe 下的重建 ----
 * 只给 .cmd/.bat 垫片用。因为前面已经禁掉了所有 shell 元字符，
 * 这里剩下要处理的只有空格和引号。 */
function quoteForCmd(a) {
  const s = String(a);
  if (s === '') return '""';
  return '"' + s.replace(/"/g, '""') + '"';
}

function createCodeRunner(opts) {
  const getRoot = (opts && opts.getRoot) || (() => '');
  const runs = new Map();
  let seq = 0;

  function resolveCwd(rel) {
    const root = String(getRoot() || '');
    if (!root) throw new Error('还没有选择工作区');
    const raw = String(rel == null ? '' : rel).trim();
    const abs = raw ? path.resolve(root, raw) : root;
    const rootReal = safeReal(root);
    const absReal = safeReal(abs);
    const inside = p => p === rootReal || p.startsWith(rootReal + path.sep);
    if (!inside(absReal)) throw new Error('cwd 越出工作区：' + raw);
    let st;
    try { st = fs.statSync(absReal); } catch (e) { throw new Error('cwd 不存在：' + (raw || '.')); }
    if (!st.isDirectory()) throw new Error('cwd 不是目录：' + raw);
    return absReal;
  }

  function safeReal(p) {
    try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); }
  }

  function killTree(child) {
    if (!child || child.killed || child.exitCode != null) return;
    try {
      if (IS_WIN) {
        // 必须 /T：npm 的孙子进程不跟着死，会一直占着端口和文件句柄
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        process.kill(-child.pid, 'SIGTERM'); // detached 起的，杀整个进程组
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {} }, 2500);
      }
    } catch (e) {
      try { child.kill(); } catch (e2) {}
    }
  }

  /* run：返回 Promise，resolve 时进程已结束（或被超时/取消干掉）。
   * onEvent 用于流式回传：{ type:'start'|'chunk'|'end', ... } */
  function run(req, onEvent) {
    const emit = typeof onEvent === 'function' ? onEvent : () => {};
    const reqObj = req || {};
    /* runId 优先用调用方给的：渲染层要拿它认领流式事件，
     * 自己生成就永远对不上（症状是卡片一直停在"运行中"，而命令其实跑完了）。 */
    const id = String(reqObj.runId || ('r' + (++seq)));
    const cmdline = String(reqObj.command == null ? '' : reqObj.command).trim();

    const fail = msg => ({ ok: false, id, command: cmdline, error: msg, code: null, ms: 0, out: '' });

    if (!cmdline) return Promise.resolve(fail('command 不能为空'));
    if (cmdline.length > MAX_CMD) return Promise.resolve(fail('命令太长'));
    const bad = findBad(cmdline);
    if (bad) {
      return Promise.resolve(fail(
        '不支持' + bad.why + '（' + bad.ch + '）—— 这里不经过 shell，一次只跑一条命令'));
    }

    const argv = tokenize(cmdline);
    if (!argv.length) return Promise.resolve(fail('命令为空'));

    const base = stripExt(lastSeg(argv[0]));
    if (!ALLOW.has(base)) {
      return Promise.resolve(fail(
        '不允许执行「' + argv[0] + '」。可用：' + Array.from(ALLOW).join(' ')));
    }

    let cwd;
    try { cwd = resolveCwd(reqObj.cwd); } catch (e) { return Promise.resolve(fail(e.message)); }

    const exe = whichIn(argv[0]);
    if (!exe) return Promise.resolve(fail('找不到「' + argv[0] + '」，它不在 PATH 里'));

    let timeout = Number(reqObj.timeout) * 1000 || 0;
    if (!timeout) timeout = T_DEF;
    timeout = Math.max(T_MIN, Math.min(T_MAX, timeout));

    const isShim = IS_WIN && /\.(cmd|bat)$/i.test(exe);
    const args = argv.slice(1);

    let spawnExe = exe;
    let spawnArgs = args;
    let verbatim = false;
    if (isShim) {
      /* npm/yarn/pnpm 在 Windows 上只有 .cmd 垫片，Node 不允许直接 spawn
       * （会 EINVAL）。只能借 cmd.exe 转一手。安全性靠上面禁掉元字符兜底。
       *
       * ⚠ 必须 windowsVerbatimArguments: cmd 的正确形态是
       *   `cmd /d /s /c ""C:\path\npm.cmd" "--version""`（外层那一对引号是 /s 的要求）。
       *   不加 verbatim 的话 Node 会再给这个参数包一层引号，变成
       *   `""C:\..."" --version""`，cmd 认不出来 —— 报「不是内部或外部命令」。 */
      const line = '"' + exe + '" ' + args.map(quoteForCmd).join(' ');
      spawnExe = process.env.ComSpec || 'cmd.exe';
      spawnArgs = ['/d', '/s', '/c', '"' + line + '"'];
      verbatim = true;
    }

    const t0 = Date.now();
    emit({ type: 'start', id, command: cmdline, cwd });

    return new Promise(resolve => {
      let child;
      try {
        child = spawn(spawnExe, spawnArgs, {
          cwd,
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: verbatim,
          detached: !IS_WIN,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            // 关掉颜色与交互提示：带 ANSI 转义和 "Do you want to..." 的输出喂给模型只会浪费 token
            NO_COLOR: '1',
            FORCE_COLOR: '0',
            CI: '1',
            TERM: 'dumb'
          }
        });
      } catch (e) {
        resolve({ ok: false, id, command: cmdline, cwd, error: e.message, code: null, ms: 0, out: '' });
        return;
      }

      const runState = { child, cancelled: false, timedOut: false, done: false };
      runs.set(id, runState);

      let out = '';
      let truncated = false;
      let pending = Buffer.alloc(0);
      let totalBytes = 0;

      const push = (text, stream) => {
        if (!text) return;
        totalBytes += Buffer.byteLength(text);
        if (out.length < MAX_OUT) {
          const room = MAX_OUT - out.length;
          out += text.length <= room ? text : text.slice(0, room);
          if (text.length > room) truncated = true;
        } else {
          truncated = true;
        }
        emit({ type: 'chunk', id, stream, text });
      };

      /* 攒到换行再解码：块边界可能把一个多字节字符劈开，
       * 直接按块解会解出乱码，而且会被误判成「不是 UTF-8」而去走 GBK。 */
      const drain = (buf, stream, flush) => {
        pending = Buffer.concat([pending, buf]);
        let cut = pending.lastIndexOf(0x0a);
        if (flush) cut = pending.length - 1;
        if (cut < 0) return;
        const seg = pending.subarray(0, cut + 1);
        pending = pending.subarray(cut + 1);
        push(decodeBuf(seg), stream);
      };

      if (child.stdout) child.stdout.on('data', b => drain(b, 'out', false));
      if (child.stderr) child.stderr.on('data', b => drain(b, 'err', false));

      const timer = setTimeout(() => {
        runState.timedOut = true;
        killTree(child);
      }, timeout);

      const finish = (code, signal, errMsg) => {
        if (runState.done) return;
        runState.done = true;
        clearTimeout(timer);
        runs.delete(id);
        if (pending.length) { push(decodeBuf(pending), 'out'); pending = Buffer.alloc(0); }
        const ms = Date.now() - t0;
        const result = {
          ok: errMsg ? false : (code === 0 && !runState.timedOut && !runState.cancelled),
          id,
          command: cmdline,
          cwd,
          code: code == null ? null : code,
          signal: signal || '',
          timedOut: runState.timedOut,
          cancelled: runState.cancelled,
          ms,
          out,
          truncated,
          totalBytes,
          error: errMsg || ''
        };
        emit({ type: 'end', id, result });
        resolve(result);
      };

      child.on('error', e => finish(null, '', e.message));
      child.on('close', (code, signal) => {
        /* 超时/取消时 close 会紧跟着来，这时用非零码误导模型，
         * 统一在结果里用 timedOut / cancelled 表达原因。 */
        finish(code, signal, '');
      });
    });
  }

  function cancel(id) {
    const st = runs.get(id);
    if (!st) return false;
    st.cancelled = true;
    killTree(st.child);
    return true;
  }

  function cancelAll() {
    for (const st of runs.values()) { st.cancelled = true; killTree(st.child); }
    runs.clear();
  }

  function status() {
    return { running: runs.size, allow: Array.from(ALLOW) };
  }

  return { run, cancel, cancelAll, status, _tokenize: tokenize, _whichIn: whichIn };
}

module.exports = { createCodeRunner, ALLOW, MAX_OUT, T_DEF, T_MAX, tokenize, whichIn };
