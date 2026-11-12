/*
 * conf-guard —— 守住「配置读取只有一个入口」
 *
 * 为什么需要它：
 *   配置的真源是设置页那排隐藏 input（#llmKey / #imgModel …）。在收敛之前，
 *   有 8 个文件各自 `$('llmKey').value.trim()`，并且把「imgBaseUrl 为空就回落
 *   llmBaseUrl」这条规则各写了一遍 —— 其中一处漏了去尾斜杠，拼出 /v1//images。
 *   这类重复不会让任何测试变红：它能跑，只是规则开始分叉。等到某天要改回落逻辑，
 *   你得同时改 8 个地方，漏一个就只在一个路径上出问题，极难复现。
 *
 * 判据（只看「读」，写是允许的）：
 *   行内出现 `$('llmKey')` / `getElementById('llmKey')`，且同一行有 `.value`
 *   但它不是赋值（`.value = x`）→ 违规。
 *   `if($('x')) $('x').value = y` 这种写法是回填，放过。
 *   `const field = $('x')` 只是拿元素引用（后一行再赋值），也放过。
 *
 * 白名单只有 js/config.js —— 它自己就是那层封装。
 *   要读配置请用 confGet(id) / confLlm() / confImg()；要拿「这次该用哪套凭据」用 llmConn()。
 *
 * 用法：node tools/conf-guard.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALLOW = new Set(['js/config.js']);

const IDS = ['llmKey', 'llmBaseUrl', 'llmModel', 'imgKey', 'imgBaseUrl', 'imgModel', 'imgEndpoint', 'imgSize', 'tripoKey', 'tripoVersion', 'respPath', 'tripoWebUrl'];

let pass = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')); }
  else { fails.push(name + (detail ? '  ← ' + detail : '')); console.log('  ❌ ' + name + (detail ? '  ' + detail : '')); }
}

function walk(d, out) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = [];
walk(path.join(ROOT, 'js'), files);
if (fs.existsSync(path.join(ROOT, 'apps'))) walk(path.join(ROOT, 'apps'), files);

console.log('=== 配置读取入口守卫 ===\n');

const violations = [];
let scanned = 0;

for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (rel === 'apps/manifest.js') continue;      // 生成物
  if (ALLOW.has(rel)) continue;
  scanned++;
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    /* 注释里提到这些写法是正常的（比如解释「以前这里是直读」）——跳过注释行，
       否则守卫会去咬自己的说明文字。 */
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const id of IDS) {
      const q = "'" + id + "'";
      const hasRef = line.includes("$(" + q + ")") || line.includes("getElementById(" + q + ")");
      if (!hasRef) continue;
      // 赋值 → 放过（回填/迁移是允许的写操作）
      if (/\.value\s*=[^=]/.test(line) || /\.checked\s*=/.test(line)) continue;
      // 同行有 .value 但不是赋值 → 纯读，违规
      if (/\.value\b/.test(line)) {
        violations.push({ rel, line: i + 1, text: line.trim().slice(0, 100) });
        break;
      }
      // 只有 $('x') 而无 .value：拿元素引用（可能是跨行赋值），放过
    }
  });
}

ok(violations.length === 0,
  '没有文件绕过 confGet/confLlm/confImg 直读配置',
  violations.length ? violations.length + ' 处' : scanned + ' 个文件已扫');

if (violations.length) {
  console.log('');
  for (const v of violations) console.log('    ' + v.rel + ':' + v.line + '  ' + v.text);
  console.log('\n  → 改成 confGet(\'<id>\')，或 confLlm()/confImg() 拿整套（含回落规则）');
}

/* 反向对照：确认扫描器本身能抓到违规。
 * 没有这条，一个「正则写错所以永远 0 违规」的守卫会安静地骗人。 */
const probeLine = "  const k = $('llmKey').value.trim();";
let caught = false;
for (const id of IDS) {
  const line = "  const k = $('" + id + "').value.trim();";
  const hasRef = line.includes("$('" + id + "')");
  if (hasRef && /\.value\b/.test(line) && !/\.value\s*=[^=]/.test(line)) caught = true;
}
ok(caught, '扫描器对直读样本能判违规（防止守卫本身失效）');

/* 反向对照 2：赋值样本必须放过 */
const assignLine = "  if($('llmKey')) $('llmKey').value = v.key;";
const assignOk = !!(/\.value\s*=[^=]/.test(assignLine));
ok(assignOk, '扫描器不会把赋值误判为直读');

/* ================= ② busy 归属守卫 =================
 * 对话/生图的「正在跑」标志以前是裸全局 `let busy`，5 处赋值散在 3 个文件。
 * 现在只有 chatBusyEnter / chatBusyLeave / chatBusyReset / isChatBusy 四个入口。
 * 判据：**文件自己声明了 busy（模块内私有）就跳过它**；没声明的文件出现裸 busy
 *       读写一律违规 —— 那种写法就是在改别人的状态。
 * 跳过注释与字符串：setDot('busy', …) / classList.add('busy') 是文案和样式名，不是这个标志。
 */
function stripNoise(line) {
  const t = line.trim();
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return '';
  /* 先把字符串字面量换成空串，再砍行尾注释 —— 顺序不能反：
     先砍 `//` 会把 `'https://…'` 从中间劈开，后面的字符串剥离就错位了。 */
  return line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "''").replace(/\/\/.*$/, '');
}
/* 「自己声明了 busy」的三种形态：局部变量、函数形参、箭头函数形参。
   命中就整份文件跳过 —— 它改的是自己的私有名字，不是全局那个标志。
   （代价：这种文件若在别处又去写全局 busy 就查不出来。权衡后接受：
   真正的风险是「新文件悄悄接管一个它没声明过的全局」，而不是有人同时用两种。） */
const BUSY_OWN = [
  /^\s*(?:let|var|const)\s+busy\s*=/,
  /function\s*[\w$]*\s*\([^)]*\bbusy\b/,
  /\([^)]*\bbusy\b[^)]*\)\s*=>/
];
const BUSY_USE = /(^|[^.\w$])busy\b(?!\s*:)/;

const busyViolations = [];
let busyScanned = 0;
for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (rel === 'apps/manifest.js') continue;
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  if (lines.some(l => BUSY_OWN.some(re => re.test(l)))) continue;   // 自己的私有标志，不管
  busyScanned++;
  lines.forEach((line, i) => {
    const code = stripNoise(line);
    if (!code || !BUSY_USE.test(code)) return;
    busyViolations.push({ rel, line: i + 1, text: line.trim().slice(0, 100) });
  });
}
ok(busyViolations.length === 0,
  '没有文件直接读写别人的 busy 标志',
  busyViolations.length ? busyViolations.length + ' 处' : busyScanned + ' 个文件已扫');
if (busyViolations.length) {
  console.log('');
  for (const v of busyViolations) console.log('    ' + v.rel + ':' + v.line + '  ' + v.text);
  console.log('\n  → 读用 isChatBusy()，进出锁用 chatBusyEnter() / chatBusyLeave(ticket)，');
  console.log('     用户叫停用 chatBusyReset()（js/desk-chat-core.js）');
}

/* 反向对照 3：裸赋值必须被抓到，属性赋值不能被误抓 */
ok(BUSY_USE.test(stripNoise("  busy = true;")), '扫描器能抓到裸 busy 赋值');
ok(!BUSY_USE.test(stripNoise("  cfState.busy = '启动中';")), '扫描器不会把 xxx.busy 当成全局标志');
ok(!BUSY_USE.test(stripNoise("  setDot('busy', '生成中…');")), "扫描器不会把 setDot('busy') 当违规");

console.log('\n结果：' + pass + ' / ' + (pass + fails.length) + ' 通过');
if (fails.length) { fails.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
