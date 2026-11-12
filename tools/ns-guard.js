#!/usr/bin/env node
/* 命名空间守卫 —— 给「多个 agent 并行写不同 App」用的。
 *
 * 为什么需要它：114 个脚本全部同步加载进同一个 window 作用域，1175 个顶层名字互相可见。
 * （数字会随文件增减漂移，跑一次就看得到当前值——别把它当固定值引用。）
 * 两个人在各自文件里都写 function openViewer(){}，git 合并**零冲突**（不同文件），
 * 运行时后加载的那个静默覆盖前面的 —— 不报错、不警告、只是行为变得莫名其妙。
 * 这是并行开发里唯一「版本控制不会告诉你」的错误，所以必须单独守。
 *
 * 用法：
 *   node tools/ns-guard.js            体检：报重名 / id 冲突 / 死文件
 *   node tools/ns-guard.js --baseline 重写基线快照（合并前在主干上跑一次）
 *   node tools/ns-guard.js --check    ？在基线之上新增了哪些名字（review 并行分支时用）
 *
 * 退出码：有硬错误 → 1（可以直接挂进 pre-commit 或体检链）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSDIR = path.join(ROOT, 'js');
const HTML = path.join(ROOT, 'index.html');
const BASE = path.join(__dirname, 'ns-baseline.json');

const argv = process.argv.slice(2);
const WRITE_BASE = argv.includes('--baseline');
const CHECK_NEW = argv.includes('--check');

/* ---------- 1. 从 index.html 读出真实的加载顺序 ---------- */
function readLoadOrder() {
  if (!fs.existsSync(HTML)) return { order: [], ids: [] };
  const html = fs.readFileSync(HTML, 'utf8');
  const order = [];
  const re = /<script\s+src="(js\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html))) order.push(m[1].replace(/^js\//, ''));

  /* 顺带收集所有 id：并行开发时两路各自加窗口，id 撞了会互相抢 getElementById */
  const ids = [];
  const idRe = /\bid="([^"]+)"/g;
  while ((m = idRe.exec(html))) ids.push(m[1]);
  return { order, ids };
}

/* ---------- 2. 剥注释（否则注释里写 "function xxx" 会被当成声明） ---------- */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(ln => ln.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n');
}

/* ---------- 3. 扒顶层声明 ----------
 * 只认行首零缩进的声明：这就是「挂在 window 上的名字」。
 * 缩进的一律是函数内部变量，不参与冲突。 */
function topLevelNames(file) {
  const raw = fs.readFileSync(path.join(JSDIR, file), 'utf8');
  const src = stripComments(raw);
  const out = [];
  src.split('\n').forEach((ln, i) => {
    const m = ln.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
      || ln.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/)
      || ln.match(/^class\s+([A-Za-z_$][\w$]*)/);
    if (m) out.push({ name: m[1], line: i + 1 });
  });
  return out;
}

/* ---------- 主流程 ---------- */
const { order, ids } = readLoadOrder();
const orderIdx = new Map(order.map((f, i) => [f, i]));

const files = fs.readdirSync(JSDIR).filter(f => f.endsWith('.js'));
const byName = new Map();
const perFile = new Map();
for (const f of files) {
  const names = topLevelNames(f);
  perFile.set(f, names);
  for (const { name, line } of names) {
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ file: f, line, loaded: orderIdx.has(f) });
  }
}

const errors = [];
const warns = [];

/* 3a. 跨文件重名 —— git 不会报的那个 */
const crossDup = [...byName].filter(([, v]) => new Set(v.map(x => x.file)).size > 1);
if (crossDup.length) {
  errors.push(['跨文件重名（后加载的静默覆盖，git 合并时不会提示）', crossDup.map(([name, v]) => {
    /* 排序口径：未加载的排最前（它们根本不会执行，不可能是「实际生效」那个），
       其余按 index.html 里的真实加载顺序。只有最后一个「已加载」的才是赢家。 */
    const sorted = v.slice().sort((a, b) => {
      const ia = orderIdx.has(a.file) ? orderIdx.get(a.file) : -1;
      const ib = orderIdx.has(b.file) ? orderIdx.get(b.file) : -1;
      return ia - ib;
    });
    const loaded = sorted.filter(x => x.loaded);
    const winner = loaded.length ? loaded[loaded.length - 1] : null;
    return name + '\n' + sorted.map(x => {
      const tag = x === winner ? '← 实际生效' : (x.loaded ? '（被覆盖）' : '（未加载，不参与）');
      return '      js/' + x.file + ':' + x.line + ' ' + tag;
    }).join('\n');
  })]);
}

/* 3b. 同一个文件里重复声明（一般是真的写重了） */
for (const [f, names] of perFile) {
  const seen = new Map();
  for (const n of names) {
    if (seen.has(n.name)) {
      errors.push(['同文件内重复声明 js/' + f, [n.name + ' (第 ' + seen.get(n.name) + ' 行与第 ' + n.line + ' 行)']]);
    } else seen.set(n.name, n.line);
  }
}

/* 3c. index.html 里重复的 id */
const idCount = new Map();
for (const id of ids) idCount.set(id, (idCount.get(id) || 0) + 1);
const idDup = [...idCount].filter(([, c]) => c > 1);

/* 3d. 没被 index.html 加载的脚本（死文件 / 忘了接线） */
const orphan = files.filter(f => !orderIdx.has(f)).sort();

/* ---------- 输出 ---------- */
console.log('=== 命名空间守卫 ===');
console.log('脚本目录: js/  ' + files.length + ' 个文件，index.html 加载 ' + order.length + ' 个');
console.log('顶层名字: ' + byName.size + ' 个（共享同一个 window 作用域）');
console.log('index.html 里的 id: ' + ids.length + ' 个（去重后 ' + idCount.size + ' 个）');

let exit = 0;

if (crossDup.length) {
  exit = 1;
  console.log('\n❌ 跨文件重名 ' + crossDup.length + ' 处');
  for (const [title, lines] of errors.filter(e => e[0].startsWith('跨文件'))) {
    console.log('  ' + title);
    for (const l of lines) console.log('   · ' + l);
  }
} else {
  console.log('\n✅ 跨文件重名 0 处');
}

const sameFile = errors.filter(e => e[0].startsWith('同文件'));
if (sameFile.length) {
  exit = 1;
  console.log('\n❌ 同文件重复声明 ' + sameFile.length + ' 处');
  for (const [title, lines] of sameFile) console.log('  ' + title + ': ' + lines.join(' , '));
} else {
  console.log('✅ 同文件重复声明 0 处');
}

if (idDup.length) {
  exit = 1;
  console.log('\n❌ index.html 重复 id ' + idDup.length + ' 处（getElementById 会摸到前面那个）');
  for (const [id, c] of idDup) console.log('   · #' + id + ' 出现 ' + c + ' 次');
} else {
  console.log('✅ index.html 重复 id 0 处');
}

if (orphan.length) {
  /* 不是错误：这些可能是按需注入的 */
  console.log('\n⚠ 未在 index.html 里加载的脚本 ' + orphan.length + ' 个（确认是按需注入，还是忘了接线）');
  console.log('   ' + orphan.join(' , '));
} else {
  console.log('✅ 所有脚本都已接线');
}

/* ---------- 基线比对：并行分支 review 时看「新增了什么名字」---------- */
const snapshot = { at: new Date().toISOString(), names: [...byName.keys()].sort(), ids: [...idCount.keys()].sort() };

if (WRITE_BASE) {
  fs.writeFileSync(BASE, JSON.stringify(snapshot, null, 1));
  console.log('\n已写入基线: tools/ns-baseline.json（' + snapshot.names.length + ' 个名字 / ' + snapshot.ids.length + ' 个 id）');
} else if (CHECK_NEW) {
  if (!fs.existsSync(BASE)) {
    console.log('\n⚠ 没有基线，先跑一次 node tools/ns-guard.js --baseline');
  } else {
    const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
    const baseSet = new Set(base.names);
    const added = snapshot.names.filter(n => !baseSet.has(n));
    const baseIdSet = new Set(base.ids);
    const addedIds = snapshot.ids.filter(i => !baseIdSet.has(i));
    console.log('\n=== 相对基线新增 ===');
    console.log('新名字 ' + added.length + ' 个' + (added.length ? ': ' + added.join(' , ') : ''));
    console.log('新 id ' + addedIds.length + ' 个' + (addedIds.length ? ': ' + addedIds.join(' , ') : ''));
    /* 新名字撞上了基线里已有的，就是并行分支撞车 */
    const clash = added.filter(n => baseSet.has(n));
    if (clash.length) { exit = 1; console.log('❌ 与基线撞名: ' + clash.join(' , ')); }
  }
}

console.log('\n' + (exit ? '存在硬错误' : '通过'));
process.exit(exit);
