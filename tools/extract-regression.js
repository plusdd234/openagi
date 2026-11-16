/* 正文抽取回归夹具测试
 *
 * 夹具：tools/fixtures/extract/*.html —— 来自不同站型的真实页面（抓取时与 App 一样
 * 走本地中转、按 UTF-8 解码），只用于回归比对，不作为打包依赖。
 *
 * 为什么切片运行：extractPage 定义在 apps/aisearch/app.js 的 IIFE 闭包里，
 * 浏览器里拿不到，所以这里按函数名把 decodeEnt / clip / 正文抽取段取出来，
 * 在 vm 里用同一份源码执行 —— 改 App 代码就是在测改后的代码，不存在第二份实现。
 *
 * 断言（全部来自夹具事实，不靠人眼）：
 *   ① 锚点文本必须还在（防止抽错块 / 被截断）；
 *   ② 字符数不能比基线少 25%，也不能多 35%（少了丢正文，多了噪声回流）；
 *   ③ 噪声行数不能超过基线。
 *
 * 用法：
 *   node tools/extract-regression.js            # 只校验
 *   node tools/extract-regression.js --report   # 打印每页抽取结果
 *   node tools/extract-regression.js --update   # 重建基线
 *   node tools/extract-regression.js --app <file>  # 指定别的 app.js（A/B 验证用）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HERE = __dirname;
const FIX = path.join(HERE, 'fixtures', 'extract');
const BASE = path.join(FIX, 'baseline.json');
const args = process.argv.slice(2);
const flag = (n) => args.indexOf(n) >= 0;
const appArg = args.indexOf('--app');

function sliceFn(src, name) {
  const head = '\n  function ' + name + '(';
  const i = src.indexOf(head);
  if (i < 0) throw new Error('找不到函数 ' + name);
  let depth = 0, j = i + head.length - 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error('函数未闭合 ' + name);
}

function build(appFile) {
  const src = fs.readFileSync(appFile, 'utf8');
  const cap = /var MAX_PAGE_TEXT\s*=\s*(\d+)/.exec(src);
  if (!cap) throw new Error('找不到 MAX_PAGE_TEXT');
  const start = src.indexOf('/* ---------------- 正文抽取');
  const end = src.indexOf('/* 从正文页里抽出可追踪的线索链接');
  if (start < 0 || end < 0) throw new Error('找不到正文抽取段');
  const code = [
    '(function(){',
    'var MAX_PAGE_TEXT = ' + cap[1] + ';',
    sliceFn(src, 'decodeEnt'),
    sliceFn(src, 'clip'),
    src.slice(start, end),
    'return { extractPage: extractPage };',
    '})()'
  ].join('\n');
  return vm.runInNewContext(code, { String: String, RegExp: RegExp, URL: URL }, { timeout: 20000 });
}

/* 噪声：短行 + 站点通用话术 / GitHub 仓库页外壳。只做「不能变多」的回归断言。 */
const NOISE = /^(首页|导航|登录|注册|版权|联系我们|广告|分享到|相关推荐|热门推荐|相关阅读|推荐阅读|上一篇|下一篇|返回顶部|扫码|关注我们|订阅|打开APP|下载APP|Branches|Tags|Folders and files|Latest commit|Name\b|Last commit|Sign in|Log in|Share|Subscribe|Advertisement|Skip to content|Toggle navigation|Cookie)/i;

function plain(html) {
  return String(html || '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/* 段落覆盖率：页面里所有 ≥80 字的 <p>，有多少能在输出里找到开头 24 字。
   比字数更能说明「正文有没有被抽出来」——抽错块时字数可能不变，覆盖率会掉。 */
function coverage(html, text) {
  const paras = [];
  String(html).replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (m, inner) => {
    const t = plain(inner);
    if (t.length >= 80) paras.push(t);
    return m;
  });
  const total = paras.reduce((a, t) => a + t.length, 0);
  if (!total) return null;
  let hit = 0;
  paras.forEach(t => { if (text.indexOf(t.slice(0, 24)) >= 0) hit += t.length; });
  return Math.round(hit / total * 100);
}

function metrics(api, html) {
  const r = api.extractPage(html);
  const lines = String(r.text || '').split('\n');
  const noise = lines.filter(l => l.length < 60 && NOISE.test(l)).length;
  return {
    title: r.title,
    text: r.text || '',
    chars: (r.text || '').length,
    noise,
    cov: coverage(html, r.text || ''),
    lines
  };
}

const api = build(appArg >= 0 ? path.resolve(args[appArg + 1]) : path.join(HERE, '..', 'apps', 'aisearch', 'app.js'));
const files = fs.readdirSync(FIX).filter(f => /\.html$/i.test(f)).sort();
if (!files.length) { console.log('没有夹具'); process.exit(1); }

const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : {};
const next = {};
const fails = [];

files.forEach(f => {
  const html = fs.readFileSync(path.join(FIX, f), 'utf8');
  const m = metrics(api, html);
  const key = f.replace(/\.html$/i, '');
  const b = base[key];
  next[key] = { url: (b && b.url) || '', chars: m.chars, noise: m.noise, cov: m.cov, anchor: (b && b.anchor) || '' };

  if (flag('--report') || flag('--update')) {
    console.log('\n[' + key + '] chars=' + m.chars + ' noise=' + m.noise + ' cov=' + m.cov + ' title=' + m.title);
    m.lines.slice(0, 4).forEach(l => console.log('   | ' + l.slice(0, 110)));
  }
  if (flag('--update')) return;

  if (!b) { fails.push(key + ': 基线里没有这一页（先跑 --update）'); return; }
  if (b.anchor && m.text.indexOf(b.anchor) < 0) fails.push(key + ': 锚点丢失「' + b.anchor + '」');
  if (m.chars < b.chars * 0.75) fails.push(key + ': 正文字数 ' + b.chars + ' → ' + m.chars + '（少了 25% 以上）');
  if (m.chars > b.chars * 1.35) fails.push(key + ': 正文字数 ' + b.chars + ' → ' + m.chars + '（多了 35% 以上，疑似噪声回流）');
  if (m.noise > b.noise) fails.push(key + ': 噪声行 ' + b.noise + ' → ' + m.noise);
  if (typeof b.cov === 'number' && typeof m.cov === 'number' && m.cov < b.cov - 5) {
    fails.push(key + ': 段落覆盖率 ' + b.cov + '% → ' + m.cov + '%');
  }
});

if (flag('--update')) {
  /* 更新基线时保留人工维护的锚点与来源地址 */
  Object.keys(next).forEach(k => {
    if (base[k]) { next[k].anchor = base[k].anchor || next[k].anchor; next[k].url = base[k].url || next[k].url; }
  });
  fs.writeFileSync(BASE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log('\n基线已写入 ' + path.relative(process.cwd(), BASE));
  process.exit(0);
}

if (fails.length) {
  console.log('\n✗ 失败 ' + fails.length + ' 项');
  fails.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('\n✓ 全部通过（' + files.length + ' 个夹具）');
