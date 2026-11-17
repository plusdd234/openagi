/* 纯逻辑单测：js/paint-stroke.js（不起浏览器）
 * 用法：node tools/md-stroke.js   → 全通过 exit 0，否则 exit 1
 *
 * 为什么要有它：笔迹形状以前只写在 md-paint.move() 里，只能靠开浏览器画一笔判断对错。
 * 间距 / 跨接缝 / 采样上限 / 脏块并集都是纯数学，出错时表现为「笔迹断开」「绕整张图一圈」
 * 「上传量突然变大」，肉眼很难定位。这里把它们钉成数字。
 */
const S = require('../js/paint-stroke.js');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra === undefined ? '' : ' · ' + extra));
  if (!ok) fails++;
};
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-9 : eps);

/* ---- 半径与间距：小贴图按短边等比缩放 ---- */
check(S.radius(42, 2048, 2048, 2048) === 21, '半径：2048² 上 size=42 → 21px', S.radius(42, 2048, 2048, 2048));
check(near(S.radius(42, 1024, 1024, 2048), 10.5), '半径：1024² 上等比缩到一半', S.radius(42, 1024, 1024, 2048));
check(S.radius(1, 2048, 2048, 2048) === 1.5, '半径：再小也不低于 1.5px', S.radius(1, 2048, 2048, 2048));
check(near(S.step(100, 2048, 2048, 2048), 22), '间距：size=100 → 22px', S.step(100, 2048, 2048, 2048));
check(S.step(1, 2048, 2048, 2048) === 1.5, '间距：下限 1.5px', S.step(1, 2048, 2048, 2048));

/* ---- 跨 UV 接缝：走最短方向，不能绕整张贴图 ---- */
const seamU = S.span(0.98, 0.5, 0.02, 0.5);
check(near(seamU.du, 0.04, 1e-9) && near(seamU.dv, 0), '接缝：u 0.98→0.02 取 +0.04', JSON.stringify(seamU));
const seamV = S.span(0.5, 0.01, 0.5, 0.99);
check(near(seamV.dv, -0.02, 1e-9), '接缝：v 0.01→0.99 取 -0.02', JSON.stringify(seamV));
const plain = S.span(0.2, 0.3, 0.25, 0.4);
check(near(plain.du, 0.05) && near(plain.dv, 0.1), '不跨接缝时保持原差值', JSON.stringify(plain));

/* ---- 跨接缝断笔：屏幕没动、UV 跳很远 → 不许连成一条长线 ---- */
check(S.seamJump(3, 0.35) === true, '断笔：屏幕 3px、UV 跳 35% → 判跨接缝', '');
check(S.seamJump(200, 0.3) === true, '断笔：一帧跨过 1/4 图集，与拖拽速度无关', '');
check(S.seamJump(44, 0.08) === true, '断笔：屏幕 44px 内 UV 跳 8% 仍断', '');
check(S.seamJump(29.9, 0.0701) === true, '断笔：阈值内侧仍触发', '');
check(S.seamJump(60, 0.2) === false, '断笔：屏幕走 60px 属连续拖拽，不误伤', '');
check(S.seamJump(2, 0.01) === false, '断笔：慢速正常拖拽不误判', '');
check(S.seamJump(0, 0) === false, '断笔：原地不动不触发', '');

/* ---- 采样数：距离 / 间距，至少 1 个，最多 400 ---- */
const s1 = S.samples(0, 0, 0.1, 0, 2048, 2048, 42, 2048);
/* dist = 0.1×2048 = 204.8px；step = 42×0.22 = 9.24 → ceil = 23 */
check(s1.n === 23, '采样：204.8px / 9.24px → 23 个图章', s1.n);
check(near(s1.du, 0.1) && near(s1.dv, 0), '采样：方向量不变', JSON.stringify(s1));
const s0 = S.samples(0.5, 0.5, 0.5, 0.5, 2048, 2048, 42, 2048);
check(s0.n === 1, '采样：原地不动也要补 1 个（最细的抖动不能丢）', s0.n);
const far = S.samples(0, 0, 0.5, 0.5, 2048, 2048, 4, 2048);
check(far.n === S.MAX_SAMPLES, '采样：一次跨半张图也封顶 400', far.n);
const seam = S.samples(0.99, 0.5, 0.01, 0.5, 2048, 2048, 42, 2048);
/* 接缝方向 dist = 0.02×2048 = 40.96 → 5 个。绕远路会是 2048×0.98 ≈ 2007px → 封顶 400 */
check(seam.n === 5, '采样：接缝段只补 5 个（没有绕整张图）', seam.n);

/* ---- 脏块：包围盒 / 并集 / 夹取 ---- */
const b = S.bboxOf(100, 100, 10, 2);
check(b.x === 88 && b.y === 88 && b.w === 24 && b.h === 24, '脏块：图章包围盒含 padding', JSON.stringify(b));
const u = S.unionBox({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 5, h: 5 });
check(u.x === 0 && u.y === 0 && u.w === 25 && u.h === 10, '脏块：并集覆盖两次落点', JSON.stringify(u));
check(S.unionBox(null, null) === null, '脏块：全空还是 null', '');
const c = S.clampBox({ x: -10, y: 2030, w: 40, h: 40 }, 2048, 2048);
check(c.x === 0 && c.y === 2030 && c.w === 30 && c.h === 18, '脏块：越界夹进画布', JSON.stringify(c));
check(S.clampBox({ x: 3000, y: 0, w: 10, h: 10 }, 2048, 2048) === null, '脏块：完全在外 → null', '');

console.log(fails ? `\n${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
