/* code-diff.js 单元测试（纯 node，不启 Electron）
 *
 * 这两件事的错法都很贵：替换错位置写坏文件，diff 算错让人误判 AI 改了什么。
 * 所以这里压得比界面测试狠 —— 尤其是 CRLF 和「匹配到多处」这两类，
 * 在界面上根本看不出来（表现都是「AI 说改了但文件没变」）。
 *
 * 跑法：node tools/test-code-diff.js
 */
'use strict';

const path = require('path');
const D = require(path.join(__dirname, '..', 'js', 'code-diff.js'));

let pass = 0, fail = 0;
const fails = [];

function ok(cond, name, extra){
  if(cond){ pass++; return true; }
  fail++;
  fails.push(name + (extra ? '  → ' + extra : ''));
  return false;
}
function eq(actual, expect, name){
  return ok(actual === expect, name, 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expect));
}

console.log('=== 1. applyEdit 基本行为 ===');
{
  const src = 'a\nb\nc\n';
  const r = D.applyEdit(src, 'b', 'B2');
  ok(r.ok, '唯一匹配能成功');
  eq(r.text, 'a\nB2\nc\n', '替换结果正确');
  eq(r.hits, 1, 'hits=1');
}

{
  const src = 'a\nb\nc\n';
  const r = D.applyEdit(src, 'b', '');
  ok(r.ok && r.text === 'a\n\nc\n', '替换成空串 = 删掉这段（保留一个空行）', JSON.stringify(r.text));
}

{
  const src = 'x = 1';
  const r = D.applyEdit(src, 'x = 1', 'y = 2');
  ok(r.ok && r.text === 'y = 2', '整文件替换');
}

console.log('=== 2. 行尾归一化（Windows 上最容易踩） ===');
{
  // 文件是 CRLF，模型给的 old/new 是 LF
  const src = 'line1\r\nline2\r\nline3\r\n';
  const r = D.applyEdit(src, 'line2', 'LINE_TWO');
  ok(r.ok, 'CRLF 文件 + LF 的 old 能匹配上');
  eq(r.text, 'line1\r\nLINE_TWO\r\nline3\r\n', '写回仍然是 CRLF');
  ok(r.text.indexOf('\n\n') < 0 && !/[^\r]\n/.test(r.text), '没有混进裸 LF');
}
{
  const src = 'line1\r\nline2\r\nline3\r\n';
  const r = D.applyEdit(src, 'line1\nline2', 'A\nB');
  ok(r.ok, '跨行 old（LF）在 CRLF 文件里也能匹配');
  eq(r.text, 'A\r\nB\r\nline3\r\n', '跨行替换后仍是 CRLF');
}
{
  const src = 'a\nb\nc\n';
  const r = D.applyEdit(src, 'a\r\nb', 'A\nB');
  ok(r.ok, 'LF 文件 + CRLF 的 old 也能匹配（反向容错）');
  eq(r.text, 'A\nB\nc\n', 'LF 文件写回仍是 LF');
}

console.log('=== 3. 必须拒绝的情况 ===');
{
  const src = 'if (x) {\n  return 1;\n}\nif (x) {\n  return 1;\n}\n';
  const r = D.applyEdit(src, 'if (x) {\n  return 1;\n}', 'if (x) { return 2; }');
  ok(!r.ok, '匹配到多处时必须拒绝，不能只改第一处');
  eq(r.hits, 2, 'hits 报出 2 处');
  ok(/匹配到 2 处/.test(r.error) && /写长一点/.test(r.error), '错误信息说清了下一步怎么做');
}
{
  const r = D.applyEdit('abc', '', 'x');
  ok(!r.ok, 'old 为空要拒绝');
  ok(/fs_new/.test(r.error), '并建议改用 fs_new');
}
{
  const r = D.applyEdit('abc', 'zzz', 'x');
  ok(!r.ok, '找不到就拒绝');
  eq(r.hits, 0, 'hits=0');
}

console.log('=== 4. 找不到时给的线索要有用 ===');
{
  // 第一行存在、后续行不存在 → 应该提示"第一行能找到"
  const src = 'function foo() {\n  return 1;\n}\n';
  const r = D.applyEdit(src, 'function foo() {\n  return 999;\n}', 'x');
  ok(!r.ok, '整段匹配失败');
  ok(/第一行在文件里能找到/.test(r.error), '提示"第一行能找到，中间对不上"', r.error);
  ok(/第 1 行/.test(r.error), '带上了行号');
}
{
  // 第一行就不存在 → 应该提示"根本没这个文件内容"
  const src = 'function foo() {\n  return 1;\n}\n';
  const r = D.applyEdit(src, 'function bar() {\n  return 1;\n}', 'x');
  ok(/根本找不到/.test(r.error) && /先 ws_read/.test(r.error), '提示"第一行都找不到，先读文件"', r.error);
}

console.log('=== 5. 行号前缀容错（模型复制 ws_read 输出的高频错误） ===');
{
  const src = 'const a = 1;\nconst b = 2;\n';
  // 模型把 "   1| " 前缀也复制进来了
  const r = D.applyEdit(src, '   2| const b = 2;', 'const b = 3;');
  ok(r.ok, '带行号前缀的 old 能容错匹配');
  eq(r.text, 'const a = 1;\nconst b = 3;\n', '替换结果正确');
  ok(/行号前缀/.test(r.warning), '回了 warning，不静默');
}
{
  // 内容里本来就有的 "12| "（比如 Markdown 表格）不能被误剥
  const src = '| 12| col |\n| 13| col |\n';
  const r = D.applyEdit(src, '| 12| col |', '| 12| COL |');
  ok(r.ok, '正常匹配时不剥行号，不误伤内容里的 "12| "');
  eq(r.text, '| 12| COL |\n| 13| col |\n', '只改了目标那一行');
}
{
  const src = 'a\nb\nc\n';
  const r = D.applyEdit(src, '  9| nope', 'x');
  ok(!r.ok, '剥了行号仍然找不到 → 还是拒绝（容错不等于放行）');
}

console.log('=== 6. new 里含换行 / 缩进 ===');
{
  const src = 'function f() {\n  return 1;\n}\n';
  const r = D.applyEdit(src, '  return 1;', '  if (x) {\n    return 1;\n  }\n  return 0;');
  ok(r.ok, '多行新内容能写入');
  eq(r.text, 'function f() {\n  if (x) {\n    return 1;\n  }\n  return 0;\n}\n', '缩进原样保留');
}

console.log('=== 7. diffLines 计数与形状 ===');
{
  const a = 'a\nb\nc\n';
  const b = 'a\nB\nc\n';
  const d = D.diffLines(a, b);
  eq(d.added, 1, 'added=1');
  eq(d.removed, 1, 'removed=1');
  const types = d.rows.map(r => r.type).join(',');
  /* 注意末尾两个 same：'a\nb\nc\n' split 后是 4 个元素（最后一个空串），
   * 尾部空行也算一行 —— 这是对的，不是 bug。 */
  eq(types, 'same,del,add,same,same', 'diff 行序：same/del/add/same/same', types);
}
{
  const d = D.diffLines('', 'a\nb\n');
  ok(d.added >= 2, '空 → 两行：added ≥ 2', String(d.added));
  eq(d.removed, 0, '空 → 两行：removed=0');
}
{
  const d = D.diffLines('a\nb\n', '');
  eq(d.added, 0, '两行 → 空：added=0');
  ok(d.removed >= 2, '两行 → 空：removed ≥ 2', String(d.removed));
}
{
  // 纯追加：前面完全一样
  const a = Array.from({length: 50}, (_, i) => 'line' + i).join('\n') + '\n';
  const b = a + 'new line\n';
  const d = D.diffLines(a, b);
  eq(d.added, 1, '纯追加 added=1');
  eq(d.removed, 0, '纯追加 removed=0');
}

console.log('=== 8. 上下文折叠（改一行不该拖出整个文件） ===');
{
  const lines = Array.from({length: 200}, (_, i) => 'row' + i);
  const a = lines.join('\n') + '\n';
  const changed = lines.slice();
  changed[100] = 'CHANGED';
  const b = changed.join('\n') + '\n';   // 必须拼成字符串：diffLines 收的是文本，不是行数组
  const d = D.diffLines(a, b);
  const hasGap = d.rows.some(r => r.type === 'gap');
  ok(hasGap, '中间未改动的大段被折叠成 gap');
  ok(d.rows.length < 30, '输出行数被压到 30 行以内', String(d.rows.length));
  eq(d.added, 1, 'added=1');
  eq(d.removed, 1, 'removed=1');
  const gap = d.rows.find(r => r.type === 'gap');
  ok(gap && /行未改动/.test(gap.text), 'gap 文案说明省略了多少行', gap && gap.text);
}
{
  // context=0 时，改动点之外一行都不留
  const lines = Array.from({length: 20}, (_, i) => 'r' + i);
  const a = lines.join('\n') + '\n';
  const c = lines.slice(); c[10] = 'X';
  const d = D.diffLines(a, c.join('\n') + '\n', { context: 0 });
  const same = d.rows.filter(r => r.type === 'same').length;
  ok(same <= 2, 'context=0 时 same 行不超过 2', String(same));
}

console.log('=== 9. 大文件不炸内存（退化路径） ===');
{
  // 5000 行完全不同的内容 → n*m 超预算，应走整块替换
  const a = Array.from({length: 5000}, (_, i) => 'old' + i).join('\n');
  const b = Array.from({length: 5000}, (_, i) => 'new' + i).join('\n');
  const t0 = Date.now();
  const d = D.diffLines(a, b);
  const ms = Date.now() - t0;
  eq(d.added, 5000, '整块替换 added=5000');
  eq(d.removed, 5000, '整块替换 removed=5000');
  ok(ms < 2000, '大文件 diff 在 2 秒内完成', ms + 'ms');
}

console.log('=== 10. diffText（喂给模型/日志用的文本版） ===');
{
  const r = D.diffText('a\nb\n', 'a\nB\n');
  ok(/^ a\n-b\n\+B$/m.test(r.text) || (r.text.indexOf('-b') >= 0 && r.text.indexOf('+B') >= 0), '带 -/+ 前缀', JSON.stringify(r.text));
  eq(r.added, 1, 'diffText.added 与 diffLines 一致');
}

console.log('=== 11. stripLineNumbers 只在该剥的时候剥 ===');
{
  eq(D.stripLineNumbers('  12| code'), 'code', '标准行号前缀被剥掉');
  eq(D.stripLineNumbers('1| a\n22| b'), 'a\nb', '多行都剥');
  eq(D.stripLineNumbers('plain'), 'plain', '无前缀不动');
}

console.log('');
if(fail){
  console.log('❌ 失败 ' + fail + ' 项 / 共 ' + (pass + fail) + ' 项');
  for(const f of fails) console.log('   × ' + f);
  process.exit(1);
}
console.log('✅ 全部通过（' + pass + ' 项）');
