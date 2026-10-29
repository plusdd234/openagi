/* 体检：样式表拆分后的「挂载完整性」
 * 用法：node tools/css-links.js
 *
 * 为什么需要它：样式拆成 12 份之后，最容易犯的错不是写错规则，而是
 *   ① 新增 css/xx.css 忘了在 index.html 里挂 → 本地看不到效果，以为规则没生效
 *   ② 挂的顺序被调换 → 08-theme 跑到 01-base 前面，整站变回深色
 *   ③ 删了文件但 link 还在 → 每次加载 404（控制台红字，容易被忽略）
 * 这三件事截图都发现不了（缺一份可能只是某个角落变丑），只能靠清单比对。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

/* 参与「按序挂载」的那 12 份：编号即顺序，必须有 */
const ORDERED = /^(\d\d)-.+\.css$/;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const linked = [...html.matchAll(/<link[^>]+href="css\/([^"]+\.css)"/g)].map(m => m[1]);
const onDisk = fs.readdirSync(path.join(ROOT, 'css')).filter(f => f.endsWith('.css'));

console.log('\n=== 1. link 指向的文件都存在 ===');
const ghosts = linked.filter(f => !fs.existsSync(path.join(ROOT, 'css', f)));
check(ghosts.length === 0, 'index.html 引用的样式都在磁盘上',
  ghosts.length ? '缺：' + ghosts.join(',') : linked.length + ' 个 link 全部命中');

console.log('\n=== 2. 磁盘上的文件都被引用 ===');
const orphans = onDisk.filter(f => !linked.includes(f));
check(orphans.length === 0, '没有「写了但没挂」的样式表',
  orphans.length ? '孤岛：' + orphans.join(',') : '无孤岛');

console.log('\n=== 3. 编号文件按序挂载 ===');
const orderedLinked = linked.filter(f => ORDERED.test(f));
const orderedDisk = onDisk.filter(f => ORDERED.test(f)).sort();
check(orderedLinked.length === orderedDisk.length,
  '12 份编号样式全部挂上', orderedLinked.length + ' / ' + orderedDisk.length);
check(JSON.stringify(orderedLinked) === JSON.stringify(orderedDisk),
  '挂载顺序 = 编号顺序',
  JSON.stringify(orderedLinked) === JSON.stringify(orderedDisk) ? 'ok' : '实际：' + orderedLinked.join(','));
/* 乱序（比如有人手动把 08 拖到前面）不改变集合，但会毁掉层叠——单独断言 */
const sorted = [...orderedLinked].sort();
check(JSON.stringify(orderedLinked) === JSON.stringify(sorted),
  '没有被打乱顺序', orderedLinked.join(' → '));

console.log('\n=== 4. 每份都有来源注释 ===');
const noHdr = orderedDisk.filter(f => {
  const head = fs.readFileSync(path.join(ROOT, 'css', f), 'utf8').slice(0, 200);
  return head.indexOf('app.css 拆分') < 0;
});
check(noHdr.length === 0, '编号样式头部都带拆分说明',
  noHdr.length ? '缺注释：' + noHdr.join(',') : 'ok');

console.log('\n=== 5. 旧的 app.css 不得复活 ===');
check(!fs.existsSync(path.join(ROOT, 'css', 'app.css')),
  'css/app.css 已删除（避免两份样式表并存）');
check(html.indexOf('href="css/app.css"') < 0,
  'index.html 不再 <link> app.css（注释里提到名字不算）');

console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
process.exit(fails ? 1 : 0);
