/*
 * st-own —— 守住「`st` 的键必须有主」
 *
 * 为什么需要它：
 *   建模 App 的共享状态 `st` 一开始有 98 个一级键，其中 32 个是某个功能的私有临时状态
 *   被摊在一级，还有 8 个是运行时第一处赋值才挂上去的（定义块里没有）。
 *   这类结构不会让任何测试变红：多塞一个键永远能跑。代价要过很久才付 ——
 *   等到「改这个字段还有谁在读」只能靠全文件 grep 猜的那天。
 *   所以判据不是「键多不多」，是「**每个键有没有主**」。
 *   （现状 91 个：已迁出 `toolSession`、挤出三件套、ViewCube 三件套。见 --solo）
 *
 * 四条判据（前三条红，第四条只提醒）：
 *   ① 代码里出现的 `st.<键>` 必须在登记表里 —— 否则就是「谁都能塞」
 *   ② 一个键只能属于一个域 —— 两个域都认领，以后不知道该跟着谁走
 *   ③ 登记表必须与 `var st = {` 定义块强一致：
 *        · 定义块里的键 → 必须登记
 *        · 登记的键 → 必须在定义块里，除非标了 dynamic
 *      （所以「加键只改代码」和「删键只改表」都会当场红）
 *   ④ 登记了但全代码没出现 → 提醒（死登记会让表慢慢失去可信度）
 *
 * 为什么不查「A 域的文件读写了 B 域的键」：
 *   现在外壳本来就横跨所有域（它就是编排层），一上来就判越界会红一片而无从修。
 *   等子对象切出来之后，这条才有意义 —— 那时再加 `--strict`。
 *
 * 用法：node tools/st-own.js           守卫
 *       node tools/st-own.js --list    按域打印现状（含 dyn 标记）
 *       node tools/st-own.js --solo    按「谁在读它」分三档，指出下一个该搬谁
 */
const fs = require('fs');
const path = require('path');
const MAP = require('./st-own.map.js');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')); }
  else { fails.push(name + (detail ? '  ← ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  ' + detail : '')); }
}

/* ---------- 登记表自检：域 → 键 ---------- */
const keyToDomain = new Map();
const dups = [];
for (const [dom, d] of Object.entries(MAP.domains)) {
  for (const k of d.keys) {
    if (keyToDomain.has(k)) dups.push(k + '（' + keyToDomain.get(k) + ' 与 ' + dom + '）');
    else keyToDomain.set(k, dom);
  }
}
const dynSet = new Set(MAP.dynamic);

if (argv.includes('--list')) {
  console.log('st 域归属（共 ' + keyToDomain.size + ' 个键）\n');
  for (const [dom, d] of Object.entries(MAP.domains)) {
    console.log('[' + dom + '] ' + d.title + (d.hot ? '   ⚠ 增长热点' : ''));
    console.log('  ' + d.keys.map(k => k + (dynSet.has(k) ? '*' : '')).join('  '));
    console.log('');
  }
  console.log('（* = 定义块里没有，运行期才挂）');
  process.exit(0);
}

console.log('=== 建模 App 共享状态归属守卫 ===\n');

ok(dups.length === 0, '每个键只属于一个域', dups.length ? dups.join('; ') : keyToDomain.size + ' 个键');
ok(dynSet.size === MAP.dynamic.length, 'dynamic 列表无重复', dynSet.size + ' 个');

/* ---------- 读定义块，取深度 1 的键 ---------- */
const stateAbs = path.join(ROOT, MAP.stateFile);
const src = fs.readFileSync(stateAbs, 'utf8');
const at = src.indexOf('var st = {');
let declared = null;
if (at < 0) {
  ok(false, '找到 `var st = {` 定义块', MAP.stateFile);
} else {
  let depth = 0, end = at;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const blk = src.slice(at, end);
  const keys = [];
  let d = 0;
  for (let i = 0; i < blk.length; i++) {
    const c = blk[i];
    if (c === '{') { d++; continue; }
    if (c === '}') { d--; continue; }
    if (d !== 1) continue;
    const m = blk.slice(i).match(/^([A-Za-z_$][\w$]*)\s*:/);
    if (m) { keys.push(m[1]); i += m[0].length - 1; }
  }
  declared = new Set(keys);
  ok(declared.size > 0, '解析到定义块一级键', declared.size + ' 个');
}

/* ---------- ③ 登记表 ⇄ 定义块 强一致 ---------- */
if (declared) {
  const notRegistered = [...declared].filter(k => !keyToDomain.has(k));
  const notInBlock = [...keyToDomain.keys()].filter(k => !declared.has(k) && !dynSet.has(k));
  const dynButDeclared = [...dynSet].filter(k => declared.has(k));
  ok(notRegistered.length === 0,
    '定义块里的每个键都登记了',
    notRegistered.length ? notRegistered.join(', ') : declared.size + ' 个');
  ok(notInBlock.length === 0,
    '登记的每个键都能在定义块里找到（或标了 dynamic）',
    notInBlock.length ? notInBlock.join(', ') : 'ok');
  ok(dynButDeclared.length === 0,
    '标了 dynamic 的键确实不在定义块里',
    dynButDeclared.length ? dynButDeclared.join(', ') : 'ok');
}

/* ---------- ① 扫代码里出现的 st.<键> ----------
 * 去噪**只处理注释，不处理字符串**。这条是踩出来的：
 *   第一版写了个完整的字符状态机（注释 + 引号 + 转义），结果 `esc()` 里那行
 *   `/[&<>"']/g` 的正则字面量被当成「字符串开始」，状态从此错位，
 *   98 个键只扫出 32 个，而文件里实际有 1769 处 `st.xxx` ——
 *   一个「安静地少扫」的守卫比没有守卫更危险，因为它报绿。
 *   所以这里放弃「完美剥噪」，改成一个前提明确的近似：
 *     · 跨行块注释用状态机跟踪（必须，注释占本文件 1/4）
 *     · 行内 `//` 只在**引号成对**时才砍（引号数为奇数说明字符串跨行，保守地整行留下）
 *     · 字符串**不剥**：代价是字符串里的 `st.xxx` 会被算作访问。
 *       这个方向是安全的 —— 多报一个「未登记」人能一眼看出是文案；
 *       少报一个才是漏。
 */
const used = new Map();          // key → [{rel,line}]
const scanned = [];
const missingFiles = [];

function scanText(text, rel, sink) {
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  lines.forEach((raw, i) => {
    let s = raw;
    if (inBlock) {
      const c = s.indexOf('*/');
      if (c < 0) return;
      s = s.slice(c + 2);
      inBlock = false;
    }
    /* 行内块注释可能跨行：找到开、找不到闭就把后半截截掉并记状态 */
    for (;;) {
      const o = s.indexOf('/*');
      if (o < 0) break;
      const c = s.indexOf('*/', o + 2);
      if (c < 0) { s = s.slice(0, o); inBlock = true; break; }
      s = s.slice(0, o) + ' ' + s.slice(c + 2);
    }
    const t = s.trim();
    if (!t || t.startsWith('//') || t.startsWith('*')) return;
    const quotes = (s.match(/'/g) || []).length + (s.match(/"/g) || []).length;
    if (quotes % 2 === 0) s = s.replace(/\/\/.*$/, '');
    const re = /\bst\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(s))) {
      const k = m[1];
      if (!sink.has(k)) sink.set(k, []);
      sink.get(k).push({ rel, line: i + 1 });
    }
  });
}

for (const rel of MAP.files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { missingFiles.push(rel); continue; }
  scanned.push(rel);
  scanText(fs.readFileSync(abs, 'utf8'), rel, used);
}

ok(missingFiles.length === 0, '登记的文件都存在', missingFiles.length ? missingFiles.join(', ') : scanned.length + ' 个');

const unregistered = [...used.keys()].filter(k => !keyToDomain.has(k));
ok(unregistered.length === 0,
  '没有未登记的 st 键被读写',
  unregistered.length
    ? unregistered.map(k => k + '（' + used.get(k)[0].rel + ':' + used.get(k)[0].line + '）').join('; ')
    : used.size + ' 个键在用');

/* ---------- ④ 死登记（只提醒） ---------- */
const dead = [...keyToDomain.keys()].filter(k => !used.has(k));
if (dead.length) console.log('  ⚠ 登记了但代码里没出现：' + dead.join(', '));

/* ---------- ⑤ 按「谁来用」分三档 → 降级候选（只提醒，不判红） ----------
 * `st` 存在的唯一理由是「**给 7 个工厂模块共享**」。所以判据不是「键多不多」，
 * 而是**谁在读它**。按文件分布分成三档，可直接转成动作：
 *
 *   A 档：只在某个 `md-*` 模块里出现 → 模块自己就有闭包，改 `var` 即可，
 *          连 `st` 都不该碰。**最强，零争议。**
 *          （2026-11-13 的 cubeDrag / cubeHover / cubeClickTimer 就是 A 档）
 *   B 档：只在 model-desk.js 里出现 → 搬成 IIFE 内的 `var`，照 `EXGZ` 那样。
 *          （extrudeGizmo / extrudeDrag / extrudeHover 走的是这条）
 *   C 档：跨文件 → 真共享状态，留在 `st` 才对。
 *
 * 为什么不判红：A/B 档里有一类是**合理**的 —— `scene` / `camera` / `renderer` /
 * `stage` 这些视口根对象本来就只归外壳，但它们是「整个 App 的状态」，
 * 不是某个功能的临时态。所以只列清单，由人判断。
 *
 * 这条判据的价值在于：**它自己指出下一个该搬谁**，不用每次靠人想。
 */
const INSTANT = /(?:drag|hover|down|open|timer|token|loading|err|panel|before)$/i;
const tierA = [], tierB = [], tierC = [];
for (const [k, hits] of used) {
  const files = [...new Set(hits.map(h => h.rel))];
  const row = { key: k, files, n: hits.length, instant: INSTANT.test(k), dom: keyToDomain.get(k) || '?' };
  if (files.length > 1) tierC.push(row);
  else if (files[0] !== MAP.stateFile) tierA.push(row);
  else tierB.push(row);
}
const byN = (a, b) => b.n - a.n;
tierA.sort(byN); tierB.sort(byN); tierC.sort(byN);

/* A 档不筛命名特征：模块内私有就是私有，叫什么名字都不该在 st 上 */
const soloInstant = tierA.concat(tierB.filter(s => s.instant));

if (argv.includes('--solo')) {
  console.log('按「谁在读它」分三档（`st` 存在的唯一理由是给多个模块共享）\n');
  console.log('[A] 只在某个 md-* 模块里 → 改成模块内 var，连 st 都不该碰  ' + tierA.length + ' 个');
  tierA.forEach(s => console.log('    ' + s.key.padEnd(20) + String(s.n).padStart(4) + ' 处  ' + s.files[0] + '   [' + s.dom + ']'));
  console.log('\n[B] 只在 model-desk.js 里 → 搬成 IIFE 内 var（照 EXGZ）  ' + tierB.length + ' 个');
  console.log('    带 * 的是瞬时态命名（高置信，优先搬）：');
  tierB.forEach(s => console.log('    ' + s.key.padEnd(20) + String(s.n).padStart(4) + ' 处   '
    + (s.instant ? '*' : ' ') + '  [' + s.dom + ']'));
  console.log('\n[C] 跨文件 → 真共享状态，留 st  ' + tierC.length + ' 个');
  console.log('    ' + tierC.map(s => s.key + '(' + s.files.length + ')').join(' '));
  process.exit(0);
}

if (soloInstant.length) {
  const a = tierA.length, b = tierB.filter(s => s.instant).length;
  console.log('  ⚠ ' + soloInstant.length + ' 个键有明确的家可回（A 档 ' + a + ' 个 / B 档 ' + b + ' 个）：'
    + soloInstant.slice(0, 8).map(s => s.key).join(', ')
    + (soloInstant.length > 8 ? ' …' : '')
    + '\n     → `node tools/st-own.js --solo` 看三档完整清单');
}

/* ---------- 反向对照：确认扫描器真的会抓 ----------
 * 没有这条，一个「正则写错所以永远 0 违规」的守卫会安静地骗人。
 * 就为这个，第一版把 98 个键扫成 32 个时没人发现 —— 所以样本必须包含
 * 「一整段带引号、正则字面量与注释的代码」，验的是「真代码留得住、噪声去得掉」。
 * ⚠ 必须复用上面的 scanText，不能另写一遍正则 —— 否则验的不是同一个东西。 */
const probeSrc = [
  '/* st.inBlockComment',
  '   * st.stillInBlock',
  '   */',
  "  var s = 'st.inString';        // st.inLineComment",
  '  var re = /[&<>"\']/g;          // 正则字面量：上一版就是在这里错位的',
  '  if (st.__probeNeverRegistered) st.__probeNeverRegistered = 1;',
  '  st.host = st.canvas;'
].join('\n');
const probeSink = new Map();
scanText(probeSrc, '(probe)', probeSink);
const probeKeys = [...probeSink.keys()];
ok(probeKeys.includes('__probeNeverRegistered'),
  '扫描器对未登记样本能判违规（防止守卫本身失效）', probeKeys.join(',') || '（一个都没扫到！）');
ok(probeKeys.includes('host') && probeKeys.includes('canvas'),
  '扫描器不会误删真代码（引号 / 正则字面量 / 注释包围下仍取到 st.host / st.canvas）');
ok(!probeKeys.includes('inBlockComment') && !probeKeys.includes('stillInBlock')
  && !probeKeys.includes('inLineComment'),
  '跨行块注释与行尾注释里的 st.xxx 不会被算作访问',
  probeKeys.includes('inString') ? '（字符串内的仍被算作访问 —— 方向安全：多报不漏报）' : '');

/* ---------- 总数对照：与 md-index 报的数一致 ---------- */
ok(keyToDomain.size === (declared ? declared.size : 0) + dynSet.size,
  '登记表键数 = 定义块键数 + dynamic 数',
  keyToDomain.size + ' = ' + (declared ? declared.size : '?') + ' + ' + dynSet.size);

console.log('\n结果：' + pass + ' / ' + (pass + fails.length) + ' 通过');
if (fails.length) {
  fails.forEach(f => console.log('  ✗ ' + f));
  console.log('\n  → 新键请先登记到 tools/st-own.map.js 的某个域下。');
  console.log('     选不出域，说明这块状态还不该进 st（放模块私有）。');
  process.exit(1);
}
