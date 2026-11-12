'use strict';
/* code-runner 的单元测试：纯 node，不启动 Electron。
 *
 * 这个模块能执行外部程序，所以每一类「越界」都必须有显式用例，
 * 而不是靠"实现里看着写了检查"。测试覆盖四类：
 *   1. 白名单与 shell 元字符（拒绝的东西必须真的被拒绝）
 *   2. cwd 沙箱（逃逸一律拒）
 *   3. 进程语义（退出码 / 超时 / 取消 / 输出上限 / 编码）
 *   4. 不留孤儿进程（超时与取消后子进程必须真的死掉）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodeRunner, tokenize, MAX_OUT } = require('../electron/code-runner');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(a, b, name) {
  ok(a === b, name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ogrun-'));
const wsRoot = path.join(base, 'workspace');
fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ogrunout-'));

function mkRunner(root) {
  return createCodeRunner({ getRoot: () => root });
}

async function main() {
  console.log('=== 1. 命令行切分 ===');
  eq(JSON.stringify(tokenize('npm test')), '["npm","test"]', '空格分隔');
  eq(JSON.stringify(tokenize('git commit -m "fix: a b"')), '["git","commit","-m","fix: a b"]', '双引号保空格');
  eq(JSON.stringify(tokenize('  node   -e   "1"  ')), '["node","-e","1"]', '多余空格被折叠');
  eq(JSON.stringify(tokenize('node -e "say \\"hi\\""')), '["node","-e","say \\"hi\\""]', '引号内转义引号');
  eq(JSON.stringify(tokenize('')), '[]', '空串 → 空数组');

  console.log('\n=== 2. 白名单 ===');
  {
    const ws = mkRunner(wsRoot);
    for (const cmd of ['rm -rf /', 'powershell -c 1', 'curl http://x', 'sh -c ls', 'cmd /c dir']) {
      const r = await ws.run({ command: cmd });
      ok(!r.ok && /不允许执行/.test(r.error), '拒绝：' + cmd, JSON.stringify(r.error));
    }
    const r2 = await ws.run({ command: 'node --version' });
    ok(r2.ok, 'node 在白名单里能跑', r2.error);
  }

  console.log('\n=== 3. shell 元字符：引号外拒，引号内放行 ===');
  {
    const ws = mkRunner(wsRoot);
    /* 引号外 = 用户真的想用 shell 语法。这里不走 shell，必须明确拒绝，
     * 否则 `a && b` 会被当成「a 的三个参数」静默跑错。 */
    const hard = [
      ['node -e "1" | cat', '管道'],
      ['node -e "1" && node -e "2"', '串接'],
      ['node -e "1" ; node -e "2"', '分号'],
      ['node -e "1" > out.txt', '输出重定向'],
      ['node -e "1" < in.txt', '输入重定向'],
      ['node -e "$(whoami)"', '命令替换'],
      ['node -e "1"\nnode -e "2"', '换行'],
      ['node -e "%PATH%"', '环境变量展开（cmd 会解释，引号挡不住）']
    ];
    for (const [cmd, label] of hard) {
      const r = await ws.run({ command: cmd });
      ok(!r.ok && /不支持/.test(r.error || ''), '拒绝（' + label + '）', JSON.stringify(r.error || r.out));
    }

    /* 引号内是**程序自己的语法**，不是 shell 语法。
     * 这类命令必须放行，否则 node -e 基本没法用（箭头函数里全是 >）。 */
    const soft = [
      ['node -e "console.log([1,2].map(x => x*2).join(\',\'))"', '箭头函数 >'],
      ['node -e "let a=1; let b=2; console.log(a+b)"', '分号'],
      ['node -e "console.log(1|2)"', '按位或 |'],
      ['node -e "console.log(`hi`)"', '模板字符串反引号']
    ];
    for (const [cmd, label] of soft) {
      const r = await ws.run({ command: cmd });
      ok(r.ok, '放行（' + label + '）', JSON.stringify(r.error || r.out));
    }
  }

  console.log('\n=== 4. cwd 沙箱 ===');
  {
    const ws = mkRunner(wsRoot);
    fs.writeFileSync(path.join(outside, 'SECRET.txt'), 'x');
    const cases = [
      ['..', '相对上跳'],
      ['../', '相对上跳（带斜杠）'],
      ['src/../..', '绕一圈再上跳'],
      [outside, '绝对路径'],
      [path.join(outside, 'x'), '工作区外的绝对路径'],
      ['不存在的目录', 'cwd 不存在']
    ];
    for (const [cwd, label] of cases) {
      const r = await ws.run({ command: 'node --version', cwd: cwd });
      ok(!r.ok && /越出工作区|cwd 不存在|cwd 不是目录/.test(r.error || ''), '拒绝 cwd：' + label, JSON.stringify(r.error));
    }
    const r2 = await ws.run({ command: 'node -e "console.log(process.cwd())"', cwd: 'src' });
    ok(r2.ok, '子目录 cwd 允许', r2.error);
    ok(fs.realpathSync(r2.out.trim()) === fs.realpathSync(path.join(wsRoot, 'src')), '真的在 src 里执行', r2.out.trim());
  }

  console.log('\n=== 5. 无工作区时 ===');
  {
    const ws = mkRunner('');
    const r = await ws.run({ command: 'node --version' });
    ok(!r.ok && /还没有选择工作区/.test(r.error), '没选工作区就拒', JSON.stringify(r.error));
  }

  console.log('\n=== 6. 进程语义 ===');
  {
    const ws = mkRunner(wsRoot);
    const r1 = await ws.run({ command: 'node -e "console.log(42)"' });
    ok(r1.ok, '退出码 0 → ok', r1.error);
    eq(r1.code, 0, '退出码记录为 0');
    ok(r1.out.indexOf('42') >= 0, 'stdout 有内容', r1.out);
    ok(r1.ms >= 0 && r1.ms < 20000, '耗时合理（' + r1.ms + 'ms）');

    const r2 = await ws.run({ command: 'node -e "console.error(\'boom\'); process.exit(3)"' });
    ok(!r2.ok, '退出码非 0 → ok=false');
    eq(r2.code, 3, '退出码记录为 3');
    ok(r2.out.indexOf('boom') >= 0, 'stderr 也被收进 out（否则模型看不到报错）', r2.out);

    /* 流式：chunk 事件必须真的到达，而不是只在 end 里给全文 */
    const streams = [];
    const r3 = await ws.run({ command: 'node -e "console.log(\'a\'); console.log(\'b\')"' }, ev => streams.push(ev.type));
    ok(streams.indexOf('start') >= 0 && streams.indexOf('chunk') >= 0 && streams.indexOf('end') >= 0,
      '★ 有 start / chunk / end 三种事件', streams.join(','));
    ok(streams.indexOf('start') === 0 && streams[streams.length - 1] === 'end', '事件顺序正确', streams.join(','));
  }

  console.log('\n=== 7. 不发请求就没人等 stdin ===');
  {
    const ws = mkRunner(wsRoot);
    const t0 = Date.now();
    /* stdio[0] 必须是 ignore：否则读 stdin 的程序会一直挂着，直到超时 */
    const r = await ws.run({ command: 'node -e "process.stdin.on(\'data\',()=>{}); process.stdin.on(\'end\',()=>console.log(\'eof\'))"', timeout: 5 });
    ok(Date.now() - t0 < 5000, '读 stdin 的程序立刻拿到 EOF，不挂到超时（' + (Date.now() - t0) + 'ms）');
    ok(r.ok && /eof/.test(r.out), '收到了 eof', r.out);
  }

  console.log('\n=== 8. 超时必杀 ===');
  {
    const ws = mkRunner(wsRoot);
    const t0 = Date.now();
    const r = await ws.run({ command: 'node -e "setTimeout(()=>{},30000)"', timeout: 1 });
    const dt = Date.now() - t0;
    ok(r.timedOut === true, '★ 标记为 timedOut', JSON.stringify(r));
    ok(!r.ok, '超时算失败（不能当成功喂给模型）');
    ok(dt < 8000, '真的被提前杀掉了（' + dt + 'ms，不是等满 30s）');
  }

  console.log('\n=== 9. 取消 ===');
  {
    const ws = mkRunner(wsRoot);
    let id = '';
    const p = ws.run({ command: 'node -e "setTimeout(()=>{},30000)"', timeout: 60 }, ev => {
      if (ev.type === 'start') id = ev.id;
    });
    await new Promise(r => setTimeout(r, 600));
    ok(!!id, '拿到 runId');
    eq(ws.cancel(id), true, 'cancel 返回 true');
    const r = await p;
    ok(r.cancelled === true, '★ 结果标记 cancelled', JSON.stringify(r.code));
    ok(!r.ok, '取消算失败');
    eq(ws.cancel('不存在的 id'), false, '取消不存在的 id 返回 false');
  }

  console.log('\n=== 10. 输出上限 ===');
  {
    const ws = mkRunner(wsRoot);
    const r = await ws.run({ command: 'node -e "const s=\'x\'.repeat(1024); for(let i=0;i<400;i++) console.log(s)"', timeout: 30 });
    ok(r.out.length <= MAX_OUT + 1024, '输出被截到上限内（' + r.out.length + ' 字节）');
    ok(r.truncated === true, '★ 标记 truncated（不能假装输出完整）');
    ok(r.totalBytes > MAX_OUT, '总量统计仍然真实（' + r.totalBytes + '）');
  }

  console.log('\n=== 11. 编码：GBK 输出不能变乱码 ===');
  {
    const ws = mkRunner(wsRoot);
    /* "你好" 的 GBK 字节。Windows 上 cmd 自带命令常吐 GBK，
     * 按 UTF-8 硬解会得到一堆 U+FFFD，模型会以为输出坏了。 */
    const r = await ws.run({ command: 'node -e "process.stdout.write(Buffer.from([0xc4,0xe3,0xba,0xc3]))"' });
    ok(r.ok, 'GBK 程序正常结束');
    ok(r.out.indexOf('你好') >= 0, '★ GBK 被正确解码', JSON.stringify(r.out));
  }

  console.log('\n=== 12. 多字节字符不被块边界劈坏 ===');
  {
    const ws = mkRunner(wsRoot);
    const r = await ws.run({ command: 'node -e "for(let i=0;i<800;i++) console.log(\'中文行\'+i)"', timeout: 30 });
    ok(r.out.indexOf('\uFFFD') < 0, '★ 输出里没有替换字符（说明按行解码生效）');
    ok(r.out.split('\n').length > 700, '行数完整', String(r.out.split('\n').length));
  }

  console.log('\n=== 13. status ===');
  {
    const ws = mkRunner(wsRoot);
    const s = ws.status();
    ok(s.running === 0, '空闲时 running=0');
    const p = ws.run({ command: 'node -e "setTimeout(()=>{},3000)"', timeout: 20 });
    await new Promise(r => setTimeout(r, 400));
    ok(ws.status().running === 1, '跑起来后 running=1');
    ws.cancelAll();
    const r = await p;
    ok(r.cancelled, 'cancelAll 能停掉');
    ok(ws.status().running === 0, '停完回到 0');
  }

  console.log('\n=== 14. 超时后子孙进程真的死了（不留孤儿）===');
  {
    const ws = mkRunner(wsRoot);
    const beat = path.join(wsRoot, 'beat.txt');
    try { fs.unlinkSync(beat); } catch (e) {}
    /* 用文件心跳判断进程是否还活着。只看 promise 何时 resolve 是不够的 ——
     * 只 kill 父进程时 promise 也会立刻 resolve，但孙子进程还在后台跑。 */
    await ws.run({
      command: 'node -e "const fs=require(\'fs\'); setInterval(()=>fs.appendFileSync(\'beat.txt\',\'.\'),100)"',
      timeout: 1
    });
    await new Promise(r => setTimeout(r, 400));
    const size1 = fs.existsSync(beat) ? fs.statSync(beat).size : 0;
    await new Promise(r => setTimeout(r, 700));
    const size2 = fs.existsSync(beat) ? fs.statSync(beat).size : 0;
    ok(size1 > 0, '被杀之前确实在跑（产生了心跳）', String(size1));
    ok(size1 === size2, '★ 杀完之后心跳停止（' + size1 + ' → ' + size2 + '，说明进程树被清掉）');
  }

  console.log('\n=== 15. Windows .cmd 垫片（npm 只有 .cmd）===');
  {
    const ws = mkRunner(wsRoot);
    const r = await ws.run({ command: 'npm --version', timeout: 60 });
    if (/找不到/.test(r.error || '')) {
      console.log('  ⚠ 跳过：PATH 里没有 npm');
    } else {
      /* 这条最容易被忽略但最致命：npm/yarn/pnpm 在 Windows 上只有 .cmd，
       * Node 不允许直接 spawn（EINVAL），必须借 cmd.exe。这条不通，
       * "跑测试"这个核心场景就完全用不了。 */
      ok(r.ok, '★ npm 能通过 .cmd 垫片跑起来', JSON.stringify(r.error || r.out.slice(0, 200)));
      ok(/^\d+\.\d+/.test(r.out.trim()), 'npm --version 输出正常', JSON.stringify(r.out.slice(0, 60)));
    }
  }

  try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(outside, { recursive: true, force: true }); } catch (e) {}

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('测试崩了：', e); process.exit(1); });
