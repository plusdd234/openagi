/* 编码工作区回归测试（沙箱 / 读写 / 乐观锁）
 *
 * 为什么单独测这一块：工作区是应用里唯一能**改用户磁盘上别人的文件**的能力，
 * 沙箱判错一次就是不可逆的。界面出错可以重开，路径逃逸不行。
 *
 * 跑法：node tools/test-code-ws.js
 * 约定（与 TESTS.md 一致）：失败必须 process.exit(1)，否则 CI 会把红的看成绿的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCodeWorkspace } = require('../electron/code-workspace');

let pass = 0, fail = 0;
function ok(cond, name, extra){
  if(cond){ pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function throws(fn, name, matcher){
  try { await fn(); fail++; console.log('  ❌ ' + name + ' — 没有抛错'); }
  catch(e){
    const msg = e && e.message ? e.message : String(e);
    if(matcher && !matcher.test(msg)){ fail++; console.log('  ❌ ' + name + ' — 抛错文案不对：' + msg); return; }
    pass++; console.log('  ✅ ' + name + '（' + msg + '）');
  }
}

function tmpdir(tag){
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ogws-' + tag + '-'));
}

(async function main(){
  const base = tmpdir('base');
  const outside = tmpdir('outside');
  const wsRoot = path.join(base, 'workspace');
  fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'README.md'), '# hello\n世界\n', 'utf8');
  fs.writeFileSync(path.join(wsRoot, 'src', 'a.js'), 'const a = 1;\n// needle 在这里\n', 'utf8');
  fs.writeFileSync(path.join(base, 'SECRET.txt'), '不该被读到', 'utf8');
  fs.writeFileSync(path.join(outside, 'SECRET2.txt'), '更不该被读到', 'utf8');
  // 二进制：带 NUL，应该被判为非文本
  fs.writeFileSync(path.join(wsRoot, 'bin.dat'), Buffer.from([1, 2, 0, 4, 5]));

  const stateFile = path.join(tmpdir('state'), 'code-workspace.json');
  const ws = createCodeWorkspace(stateFile);

  console.log('\n=== 1. 工作区选择 ===');
  ok(ws.info().ready === false, '初始状态是未选择');
  const info = ws.setRoot(wsRoot);
  ok(info.ready === true && info.name === 'workspace', 'setRoot 返回就绪与目录名');
  ok(fs.existsSync(stateFile), '状态文件已落盘（下次启动不必重选）');
  const ws2 = createCodeWorkspace(stateFile);
  ok(ws2.info().ready === true, '新实例能恢复上次的工作区');
  ok(ws.clear().ready === false, 'clear 只断指针');
  ok(fs.existsSync(wsRoot), 'clear 之后磁盘目录还在（绝不碰用户文件）');
  ws.setRoot(wsRoot);

  console.log('\n=== 2. 列目录 ===');
  const l = await ws.list('');
  const names = l.entries.map(e => e.name);
  ok(names.indexOf('README.md') >= 0 && names.indexOf('src') >= 0, '根目录列出文件与子目录');
  ok(l.entries[0].dir === true, '目录排在文件前面');
  ok(l.entries.every(e => typeof e.size === 'number'), '每个条目都带元信息');
  const l2 = await ws.list('src');
  ok(l2.entries.length === 1 && l2.entries[0].name === 'a.js', '子目录按需列出（不递归）');

  console.log('\n=== 3. 读文件 ===');
  const r = await ws.read('README.md');
  ok(r.text.indexOf('世界') >= 0, '按 UTF-8 读出中文');
  ok(/^[0-9a-f]{40}$/.test(r.sha), '返回 sha1 指纹');
  ok(r.eol === '\n', '识别换行风格');
  await throws(() => ws.read('nope.txt'), '不存在的文件报错', /不存在/);
  await throws(() => ws.read('bin.dat'), '二进制文件拒绝编辑', /二进制/);
  await throws(() => ws.read('src'), '目录不能当文件读', /文件夹/);

  console.log('\n=== 4. 沙箱：路径逃逸全部拒绝 ===');
  await throws(() => ws.read('../SECRET.txt'), '上级目录逃逸', /越出/);
  await throws(() => ws.read('src/../../SECRET.txt'), '归一化后逃逸', /越出/);
  await throws(() => ws.read(path.join(base, 'SECRET.txt')), '绝对路径', /相对/);
  await throws(() => ws.read('C:\\Windows\\win.ini'), '盘符绝对路径', /相对|越出/);
  await throws(() => ws.write('../evil.txt', 'x'), '写入也不能逃逸', /越出/);
  ok(!fs.existsSync(path.join(base, 'evil.txt')), '逃逸写入没有真的落盘');

  // 目录联接（junction）：Windows 上**不需要管理员权限**，npm 的 bin 链接、
  // pnpm 的 store 都靠它，所以这是比 symlink 更现实的逃逸场景。
  // 纯文件的 symlink 在普通权限下常常建成断链（existsSync 直接 false），测不出东西。
  let linked = false;
  try {
    fs.symlinkSync(outside, path.join(wsRoot, 'outdir'), 'junction');
    linked = fs.existsSync(path.join(wsRoot, 'outdir'));
  } catch(e){ /* 没有权限就跳过 */ }
  if(linked){
    await throws(() => ws.read('outdir/SECRET2.txt'), 'junction 指向工作区外被拒绝', /软链接|越出/);
    await throws(() => ws.write('outdir/evil2.txt', 'x'), '经 junction 写入也被拒绝', /软链接|越出/);
    ok(!fs.existsSync(path.join(outside, 'evil2.txt')), '经 junction 的写入没有落盘');
  } else {
    console.log('  ⚠ 跳过 junction 用例（当前系统不允许建目录联接）');
  }

  console.log('\n=== 5. 写文件与乐观锁 ===');
  const w1 = await ws.write('new.txt', '第一版\n');
  ok(w1.created === true, '新文件写入成功');
  const back = await ws.read('new.txt');
  ok(back.text === '第一版\n', '读回来的内容一致');

  await throws(
    () => ws.write('new.txt', '不该写进去', { expectSha: 'deadbeef' }),
    '哈希不匹配时拒绝覆盖（外部改动保护）',
    /已被外部改动/
  );
  ok((await ws.read('new.txt')).text === '第一版\n', '被拒绝的写入没有污染文件');

  await throws(
    () => ws.write('new.txt', '没带校验', {}),
    '覆盖已有文件必须带校验或 force',
    /校验/
  );

  const w2 = await ws.write('new.txt', '第二版\n', { expectSha: back.sha });
  ok(w2.created === false, '带正确哈希时正常覆盖');
  ok((await ws.read('new.txt')).text === '第二版\n', '覆盖后内容正确');

  const w3 = await ws.write('src/deep/nested/b.js', 'export const b = 2;\n');
  ok(w3.created === true && fs.existsSync(path.join(wsRoot, 'src', 'deep', 'nested', 'b.js')), '自动创建多级目录');

  // 原子写：不应该留下临时文件
  const leftovers = fs.readdirSync(wsRoot).filter(n => n.indexOf('.ogtmp') >= 0);
  ok(leftovers.length === 0, '原子写没有残留临时文件');

  console.log('\n=== 6. 搜索 ===');
  const s1 = await ws.search('needle');
  ok(s1.hits.length === 1, '命中一处');
  ok(s1.hits[0].rel === 'src/a.js' && s1.hits[0].line === 2, '给出行号与相对路径');
  const s2 = await ws.search('世界');
  ok(s2.hits.length === 1 && s2.hits[0].rel === 'README.md', '搜索支持中文');
  const s3 = await ws.search('不该被读到');
  ok(s3.hits.length === 0, '搜索不会越出工作区');
  ok((await ws.search('')).hits.length === 0, '空关键词不扫盘');

  console.log('\n=== 7. 重名与边界 ===');
  await throws(() => ws.write('src', 'x', { force: true }), '不能把目录当文件写', /EISDIR|目录|EPERM/i);

  console.log('\n=== 8. 项目结构（给模型看的） ===');
  {
    const t = await ws.tree('', { maxDepth: 3 });
    ok(typeof t.text === 'string' && t.text.length > 0, 'tree 返回文本');
    ok(/src\//.test(t.text), '目录以 / 结尾', t.text.split('\n').slice(0, 4).join(' | '));
    ok(/a\.js/.test(t.text), '列出文件');
    ok(!/node_modules\/[a-z]/.test(t.text), 'node_modules 不进去展开');

    // 深度限制
    fs.mkdirSync(path.join(wsRoot, 'd1/d2/d3/d4'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'd1/d2/d3/d4/deep.js'), 'x');
    const t1 = await ws.tree('', { maxDepth: 1 });
    ok(!/deep\.js/.test(t1.text), 'maxDepth=1 时深层文件不出现');
    ok(/d1\//.test(t1.text), '但第一层目录出现');
    const t4 = await ws.tree('', { maxDepth: 6 });
    ok(/deep\.js/.test(t4.text), 'maxDepth=6 时深层文件出现');

    // 数量截断
    for(let i = 0; i < 80; i++) fs.writeFileSync(path.join(wsRoot, 'bulk' + i + '.txt'), 'x');
    const tc = await ws.tree('', { maxEntries: 50 });
    ok(tc.truncated === true, '超过 maxEntries 时标记 truncated');
    ok(/截断/.test(tc.text), '并且文本里明确说了截断', tc.text.slice(-60));

    // 子目录入口
    const sub = await ws.tree('src', { maxDepth: 2 });
    ok(/a\.js/.test(sub.text) && !/README\.md/.test(sub.text), '指定子目录时不列出别处文件');

    // 沙箱对 tree 同样生效
    await throws(() => ws.tree('../../'), 'tree 也拦越界路径', /越出/);

    // 清理这组造的垃圾，避免影响后面的断言
    for(let i = 0; i < 80; i++) fs.rmSync(path.join(wsRoot, 'bulk' + i + '.txt'), { force: true });
    fs.rmSync(path.join(wsRoot, 'd1'), { recursive: true, force: true });
  }

  console.log('\n=== 12. putBinary：二进制落盘 ===');
  {
    // 1×1 PNG 的真实 base64，够用来验字节一致性
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const pngPath = path.join(wsRoot, 'img', 'dot.png');

    const w1 = await ws.putBinary('img/dot.png', PNG, {});
    ok(fs.existsSync(pngPath), '写进磁盘了');
    ok(w1.created === true, 'created 标记正确');
    ok(w1.size === Buffer.from(PNG, 'base64').length, '报告的大小等于解码后字节数', String(w1.size));
    ok(fs.readFileSync(pngPath).equals(Buffer.from(PNG, 'base64')), '磁盘字节和原内容完全一致');
    ok(/^[0-9a-f]{40}$/.test(w1.sha), '返回 sha1 指纹');

    // data: 前缀要剥掉而不是报错（模型给 base64 时经常带）
    const w2 = await ws.putBinary('img/with-prefix.png', 'data:image/png;base64,' + PNG, {});
    ok(w2.size === w1.size, 'data: 前缀被剥掉，不会写成一坨文本');

    // 已存在：默认不许覆盖
    await throws(() => ws.putBinary('img/dot.png', PNG, {}), '目标已存在时拒绝覆盖', /已存在/);
    const w3 = await ws.putBinary('img/dot.png', PNG, { force:true });
    ok(w3.created === false, 'force 覆盖时 created=false');

    // 乐观锁
    await throws(() => ws.putBinary('img/dot.png', PNG, { force:true, expectSha:'0'.repeat(40) }),
      'expectSha 不匹配时拒绝写入', /外部改动/);

    // 输入校验
    await throws(() => ws.putBinary('img/empty.png', '', {}), '空内容报错', /为空/);
    await throws(() => ws.putBinary('img/bad.png', '这不是base64!!', {}), '非法 base64 报错', /base64/);

    // 沙箱：二进制不比文本更宽松
    await throws(() => ws.putBinary('../../escape.png', PNG, {}), '二进制同样拦越界路径', /越出/);
    await throws(() => ws.putBinary(path.join(base, 'abs.png'), PNG, {}), '绝对路径同样被拒', /绝对|相对/);

    // 自动建目录
    const w4 = await ws.putBinary('a/b/c/deep.png', PNG, {});
    ok(fs.existsSync(path.join(wsRoot, 'a', 'b', 'c', 'deep.png')) && w4.created, '深层路径自动建目录');

    // 两条路确实分开：putBinary 写进去的东西，read() 不认
    await throws(() => ws.read('img/dot.png'), 'read() 拒绝读二进制（证明两条路是分开的）', /二进制/);

    // exists：给渲染层判断「新建还是覆盖」用
    const e1 = await ws.exists('img/dot.png');
    ok(e1.exists === true && e1.size === w1.size, 'exists 能报出大小');
    const e2 = await ws.exists('img/none.png');
    ok(e2.exists === false, '不存在的文件 exists=false');
    // 这里的关键是**不抛错**：渲染层拿它做判断，抛错会变成一个没人处理的 rejection
    const e3 = await ws.exists('../../escape.png');
    ok(e3.exists === false, '越界路径 exists 返回 false 而不是抛错');

    // 文件名基本卫生
    await throws(() => ws.putBinary('img/.hidden', PNG, {}), '点开头的文件名被拒', /点开头/);
  }

  // 清理（含工作区根，本组造的文件都在里面）
  try { fs.rmSync(base, { recursive: true, force: true }); } catch(e){}
  try { fs.rmSync(outside, { recursive: true, force: true }); } catch(e){}

  console.log('\n----------------------------------------');
  console.log(fail === 0 ? '✅ 全部通过 · ' + pass + ' 项' : '❌ ' + fail + ' 项失败 / ' + pass + ' 项通过');
  if(fail > 0) process.exit(1);
})().catch(e => {
  console.error('测试自身崩了：', e);
  process.exit(1);
});
