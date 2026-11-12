/*
 * md-index —— 建模 App 的结构地图（按需生成，不进源码）
 *
 * 为什么是工具而不是写死在注释里的索引：
 *   7097 行 / 296 个函数，谁也记不住第几行。但把行号抄进注释，改两次代码就全错，
 *   错的地图比没有地图更坏（会照着去改错地方）。所以每次现算。
 *
 * 用法：
 *   node tools/md-index.js            结构总览：分节 / 行范围 / 函数数与行数
 *   node tools/md-index.js --big 25   最长的 25 个函数（拆分的候选目标）
 *   node tools/md-index.js --find save 按名字找函数（含分节与行号）
 *   node tools/md-index.js --orphan   没归入任何分节的函数（真正的「找不到」区）
 *   node tools/md-index.js --cost     每块抽成工厂要传多少 ctx（越少越该先抽）
 *
 * ⚠ 它只读不写。要改结构请照 MODELDESK.md 的「工厂模块」约定：
 *   这个文件是单 IIFE 闭包，296 个函数共享 st / $ / THREE，
 *   **按行切开文件不成立**（切开就是新闭包，状态全断）。
 *   能抽出去的只有 `global.MDXxx.create(ctx)` 那种工厂。
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'js', 'model-desk.js');
const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);

const argv = process.argv.slice(2);
const flag = k => argv.indexOf('--' + k) >= 0;
const val = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

/* 分节横幅有两种写法：
 *   /* ---------------- 选择（S1 拾取 + 高亮） ----------------
 *   /* ============================================================
 * 模块边界单独记（var X = global.MDXxx.create({...})），因为它意味着「这块已经不在这里了」 */
const sections = [];
const modules = [];
const funcs = [];

lines.forEach((l, i) => {
  const n = i + 1;
  let m;
  if ((m = l.match(/^\s*\/\*\s*-{3,}\s*(.+?)\s*-{3,}\s*$/))) {
    sections.push({ line: n, title: m[1] });
  } else if (/^\s*\/\*\s*={10,}/.test(l)) {
    /* ===== 横幅下面那行是正文说明，不一定是个短标题：砍到第一个句号/破折号，太长就标未命名 */
    const nxt = (lines[i + 1] || '').replace(/^\s*\*?\s*/, '').trim();
    const t = nxt.split('。')[0].split('——')[0].trim();
    sections.push({ line: n, title: (t && t.length <= 34) ? t : '（未命名，见源码）' });
  } else if ((m = l.match(/^  var ([A-Z][A-Z0-9_]*)\s*=\s*(?:global\.(\w+)\s*\?\s*)?global\.(\w+)\.create\(/))) {
    modules.push({ line: n, name: m[1], from: m[2] || m[3] });
  } else if ((m = l.match(/^  function ([A-Za-z_$][\w$]*)\s*\(/))) {
    funcs.push({ line: n, name: m[1], idx: i });
  }
});

funcs.forEach((f, k) => {
  f.n = (k + 1 < funcs.length ? funcs[k + 1].idx : lines.length) - f.idx;
  const before = sections.filter(s => s.line < f.line);
  f.section = before.length ? before[before.length - 1].title : '（无分节）';
});

const total = lines.length;
const pad = (s, w) => String(s).padEnd(w);

if (flag('find')) {
  const q = String(val('find', '')).toLowerCase();
  const hit = funcs.filter(f => f.name.toLowerCase().includes(q));
  if (!hit.length) { console.log('没找到名字含 "' + q + '" 的函数'); process.exit(1); }
  console.log('找到 ' + hit.length + ' 个：\n');
  hit.forEach(f => console.log('  L' + String(f.line).padStart(5) + '  ' + pad(f.name, 28) + f.n + ' 行 · ' + f.section));
  process.exit(0);
}

if (flag('orphan')) {
  const orph = funcs.filter(f => f.section === '（无分节）');
  console.log('没归入任何分节的函数：' + orph.length + ' 个 / ' + orph.reduce((s, f) => s + f.n, 0) + ' 行\n');
  orph.forEach(f => console.log('  L' + String(f.line).padStart(5) + '  ' + pad(f.name, 28) + f.n + ' 行'));
  process.exit(0);
}

/* --cost：算「把这一块抽成全局工厂，ctx 里得传几项」
 *
 * 判据不是「这块多少行」，而是「这块伸出去抓了多少个别人家的东西」。
 * 伸出去的每一样都要写进 create(ctx) 的 ctx，也是以后出 bug 要跨文件追的路径。
 * 只统计**本文件顶层声明过**的名字，所以 Math / document / THREE 这类外部全局不会混进来。
 * 噪声：函数形参与顶层同名时会被算成依赖（少数），所以看排序不看绝对值。
 */
if (flag('cost')) {
  const noStr = t => t
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const whole = noStr(lines.join('\n'));
  const idents = t => (t.match(/[A-Za-z_$][\w$]*/g) || []);
  const KEY = new Set(('function var let const if else for while return new typeof instanceof in of try catch '
    + 'finally throw switch case break continue this null undefined true false void delete do use strict').split(' '));

  /* 顶层声明：行首两个空格的 var / function（本文件全部如此），外加 global.Xxx = 导出面 */
  const top = new Set();
  lines.forEach(l => {
    let m;
    if ((m = l.match(/^  (?:var|let|const) ([A-Za-z_$][\w$]*)/))) top.add(m[1]);
    else if ((m = l.match(/^  function ([A-Za-z_$][\w$]*)/))) top.add(m[1]);
    else if ((m = l.match(/^  global\.([A-Za-z_$][\w$]*)\s*=/))) top.add(m[1]);
  });

  const bounds = sections.map(s => s.line).concat([total + 1]);
  const rows = [];
  sections.forEach((s, k) => {
    const from = s.line, to = bounds[k + 1] - 1;
    const body = noStr(lines.slice(from - 1, to).join('\n'));
    const used = new Set(idents(body).filter(x => !KEY.has(x) && top.has(x)));
    /* 这一块自己定义的名字不算依赖 */
    const own = new Set();
    (body.match(/^  (?:var|let|const|function) ([A-Za-z_$][\w$]*)/gm) || [])
      .forEach(d => own.add(d.replace(/^  (?:var|let|const|function) /, '')));
    const out = [...used].filter(x => !own.has(x));
    /* 反向：别处有多少块在用它的名字（抽走后要不要留门面） */
    const fans = sections.filter((_, j) => j !== k).filter((_, j) => {
      const jj = j >= k ? j + 1 : j;
      if (jj >= bounds.length - 1) return false;
      const other = noStr(lines.slice(sections[jj].line - 1, bounds[jj + 1] - 1).join('\n'));
      return [...own].some(nm => new RegExp('\\b' + nm + '\\b').test(other));
    }).length;
    rows.push({ title: s.title, from, to, line: to - from + 1, fn: funcs.filter(f => f.line >= from && f.line < bounds[k + 1]).length, deps: out.length, fans, names: out });
  });

  console.log('抽成工厂的成本（ctx 项数 = 这块伸出去抓了多少顶层名字）\n');
  console.log('  ' + pad('行数', 7) + pad('函数', 6) + pad('ctx', 6) + pad('被用', 6) + '分节');
  rows.forEach(r => console.log('  ' + pad(r.line, 7) + pad(r.fn, 6) + pad(r.deps, 6) + pad(r.fans, 6) + r.title));
  console.log('\n按 ctx 从小到大（前 6 名就是最该先抽的）：');
  [...rows].sort((a, b) => a.deps - b.deps || b.line - a.line).slice(0, 6)
    .forEach(r => console.log('  ctx=' + pad(r.deps, 4) + pad(r.line + ' 行', 8) + r.title));
  const pick = val('cost', '');
  const one = rows.find(r => r.title.includes(pick));
  if (one) console.log('\n「' + one.title + '」要传：' + one.names.join(', '));
  process.exit(0);
}

if (flag('big')) {
  const top = Number(val('big', 20)) || 20;
  console.log('最长的 ' + top + ' 个函数（拆分候选：越长越可能是「做完才想清边界」的地方）\n');
  [...funcs].sort((a, b) => b.n - a.n).slice(0, top)
    .forEach(f => console.log('  L' + String(f.line).padStart(5) + '  ' + pad(f.n + ' 行', 8) + pad(f.name, 30) + f.section));
  process.exit(0);
}

/* 默认：总览 */
console.log('js/model-desk.js  ' + total + ' 行 / ' + funcs.length + ' 个函数 / ' +
  sections.length + ' 个分节 / ' + modules.length + ' 个外部模块\n');
console.log('  ' + pad('行范围', 16) + pad('行数', 7) + pad('函数', 6) + pad('函数行数', 10) + '分节');
const bounds = sections.map(s => s.line).concat([total + 1]);
sections.forEach((s, k) => {
  const from = s.line, to = bounds[k + 1] - 1;
  const inSec = funcs.filter(f => f.line >= from && f.line < bounds[k + 1]);
  console.log('  ' + pad(from + '-' + to, 16) + pad(to - from + 1, 7) + pad(inSec.length, 6) +
    pad(inSec.reduce((a, f) => a + f.n, 0), 10) + s.title);
});
/* 第一处横幅之前的内容（文件头注释 + 全部常量表）单独算一行 */
const headEnd = sections.length ? sections[0].line - 1 : total;
const headFuncs = funcs.filter(f => f.line <= headEnd);
console.log('  ' + pad('1-' + headEnd, 16) + pad(headEnd, 7) + pad(headFuncs.length, 6) +
  pad(headFuncs.reduce((a, f) => a + f.n, 0), 10) + '（文件头 + 常量表）');

if (modules.length) {
  console.log('\n已拆出去的外部模块（本文件只留门面）：');
  modules.forEach(m => console.log('  L' + String(m.line).padStart(5) + '  ' + pad(m.name, 10) + '← global.' + m.from));
}
const orph = funcs.filter(f => f.section === '（无分节）');
if (orph.length) console.log('\n⚠ 有 ' + orph.length + ' 个函数没归入任何分节（--orphan 看清单）');
