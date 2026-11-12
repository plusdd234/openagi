#!/usr/bin/env node
/* tools/wt.js —— 一个 AI 一个 worktree（并行开发的「进程层」）
 *
 * 为什么还需要这一层：`apps/<id>/` 已经把**文件层面**的冲突降到 0 了，但两个人改
 * 同一个目录时，改的其实是**同一份文件**——不是分支。真正并行要各写各的工作区。
 *
 * 用法：
 *   node tools/wt.js new <appId>     建 worktree + 分支，并打印「贴给那个 AI 的任务卡」
 *   node tools/wt.js list            列出所有 worktree 及各自改了什么、有没有越界
 *   node tools/wt.js status <appId>  只看这一个：改了哪些文件、在不在自己的地盘里
 *   node tools/wt.js merge <appId>   合回主仓（自动重算 manifest + 跑守卫，失败就回滚）
 *   node tools/wt.js rm <appId>      拆掉 worktree（先摘 node_modules 链接，绝不递归删）
 *
 * 环境变量：
 *   OPENAGI_WT_ROOT   worktree 放哪儿（默认 <仓库的上级目录>/openagi-wt，即仓库外面）
 *   OPENAGI_BASE      基线分支（默认 main）
 *
 * 四条设计原则（都踩过或差点踩到）：
 *  ① **worktree 放在仓库外面**。放里面会让 `grep -r` / 文件树 / electron 打包白名单
 *     全部看见两份代码，而且 `.worktrees/` 忘加 .gitignore 就进库了。
 *  ② **node_modules 用 junction 共享**，不重复 npm install（electron 一个就 200MB+）。
 *     junction 在 Windows 上不需要管理员权限（`fs.symlinkSync(..., 'junction')`）。
 *     ⚠ 拆 worktree 前**必须先摘链接**：直接删目录时 rmdir 会顺着链接把真正的
 *     node_modules 一起端掉——这是这个脚本里唯一有破坏性的地方。
 *  ③ **合并时 manifest 必然冲突**（每个分支都重算过 `apps/manifest.js`）。
 *     它本来就是生成物，所以冲突只用「挑一边 + 重新生成」解决，绝不让人手工解。
 *  ④ **vendor/ 被 .gitignore 挡着**，worktree 里天然没有 → 建的时候要把「主仓有、这边缺」的补过去，
 *     否则打开就是一片 ERR_FILE_NOT_FOUND（图标丢、模型加载器 undefined）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const WT_ROOT = process.env.OPENAGI_WT_ROOT || path.join(path.dirname(REPO), 'openagi-wt');
const BASE_BRANCH = process.env.OPENAGI_BASE || 'main';
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/* ---------------- 基础 ---------------- */
function git(args, opts) {
  const r = spawnSync('git', args, { cwd: (opts && opts.cwd) || REPO, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), code: r.status };
}
function must(args, opts) {
  const r = git(args, opts);
  if (!r.ok) throw new Error('git ' + args.join(' ') + ' 失败：' + (r.err || r.out));
  return r.out;
}
function runNode(file, args) {
  const r = spawnSync(process.execPath, [path.join(REPO, file)].concat(args || []), {
    cwd: REPO, encoding: 'utf8'
  });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim(), code: r.status };
}
const branchOf = id => 'app/' + id;
const pathOf = id => path.join(WT_ROOT, id);

function die(msg, code) {
  console.error('\n❌ ' + msg + '\n');
  process.exit(code == null ? 1 : code);
}
function needId(id) {
  if (!id) die('缺少 appId。例：node tools/wt.js new myapp');
  if (!ID_RE.test(id)) die('appId 不合法：' + id + '（只允许小写字母开头、字母数字和 - 组成，如 my-app）');
}
function branchExists(ref) {
  return git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + ref]).ok;
}

/* 越界判定：只有这两个地方允许动 */
function classify(id, files) {
  const own = 'apps/' + id + '/';
  const ok = [], gen = [], out = [];
  files.forEach(f => {
    if (f.indexOf(own) === 0) ok.push(f);
    else if (f === 'apps/manifest.js') gen.push(f);
    else out.push(f);
  });
  return { ok, gen, out };
}

/* node_modules 是 junction（Windows 上 lstat 会报 isSymbolicLink） */
function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (e) { return false; }
}
/* ⚠ 只摘链接，不碰目标。目录型链接用 rmdir 才是「删链接本身」，unlink 会 EPERM */
function unlinkJunction(p) {
  if (!isLink(p)) return false;
  try { fs.unlinkSync(p); return true; } catch (e) {}
  try { fs.rmdirSync(p); return true; } catch (e) {}
  return false;
}
function linkNodeModules(dest) {
  const src = path.join(REPO, 'node_modules');
  if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
  try { fs.symlinkSync(src, dest, 'junction'); return true; } catch (e) { return false; }
}

/* ---------------- 被忽略、但运行时必须有的静态资源 ----------------
 * `.gitignore` 里 `vendor/*` 只放行了 GLTFExporter.js，而 index.html 还引了
 * three.min.js / 三个 Loader / fflate / 模型商店的羊驼头。
 * worktree 是「从提交里长出来的」，这些文件**根本不存在** → 打开就是一片
 * ERR_FILE_NOT_FOUND（图标丢失、模型加载器 undefined）。
 * 不去改 .gitignore（那些是几百 KB 的第三方二进制，本来就不该进仓库），
 * 而是在建 worktree 时把**主仓有、这边缺**的文件补过去。 */
const IGNORED_ASSETS = ['vendor'];

function syncIgnoredAssets(wtPath) {
  let copied = 0;
  const walk = (rel) => {
    const srcDir = path.join(REPO, rel);
    if (!fs.existsSync(srcDir)) return;
    fs.readdirSync(srcDir, { withFileTypes: true }).forEach(d => {
      const childRel = path.join(rel, d.name);
      if (d.isDirectory()) { walk(childRel); return; }
      const dst = path.join(wtPath, childRel);
      if (fs.existsSync(dst)) return;            /* 已跟踪的（GLTFExporter.js）不覆盖 */
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(REPO, childRel), dst);
      copied++;
    });
  };
  IGNORED_ASSETS.forEach(walk);
  return copied;
}

/* ---------------- new ---------------- */
function cmdNew(id, flags) {
  needId(id);
  const br = branchOf(id);
  const wt = pathOf(id);

  if (fs.existsSync(wt)) {
    if (flags.attach) {
      console.log('· 目录已存在，按「挂到一个已存在的 worktree」处理：' + wt);
    } else {
      die('目录已存在：' + wt + '\n   要看现状：node tools/wt.js list\n   要重建：node tools/wt.js rm ' + id);
    }
  }
  /* 这个 App 已经有人在主仓里改了？那说明还没走并行流程，先提醒（不阻断） */
  const dirtyOwn = git(['status', '--porcelain', '--', 'apps/' + id]).out;
  if (dirtyOwn) console.log('⚠ 主仓里 apps/' + id + '/ 还有未提交改动，新 worktree 里看不到它们。\n');

  const base = flags.base || BASE_BRANCH;
  if (!branchExists(base) && !git(['rev-parse', '--verify', '--quiet', base]).ok) {
    die('基线不存在：' + base);
  }

  fs.mkdirSync(WT_ROOT, { recursive: true });

  let created = false;
  if (branchExists(br)) {
    console.log('· 分支 ' + br + ' 已存在，把现有分支挂到这个目录（保留之前的工作）');
    must(['worktree', 'add', wt, br]);
  } else {
    must(['worktree', 'add', '-b', br, wt, base]);
    created = true;
  }

  const linked = linkNodeModules(path.join(wt, 'node_modules'));
  const assets = syncIgnoredAssets(wt);
  if (flags.withStore && fs.existsSync(path.join(REPO, 'openagi-store.json'))) {
    fs.copyFileSync(path.join(REPO, 'openagi-store.json'), path.join(wt, 'openagi-store.json'));
    console.log('· 已复制 openagi-store.json（含密钥，只在本机，永不提交）');
  }

  console.log('\n✅ worktree 就绪' + (created ? '（新分支）' : ''));
  console.log('   目录  ' + wt);
  console.log('   分支  ' + br + '  ← 从 ' + base + ' 长出来');
  console.log('   依赖  ' + (linked ? 'node_modules 已 junction 到主仓（不重复 install）' : '⚠ 没能建 junction，需要自己 npm install'));
  console.log('   资源  ' + (assets ? '补了 ' + assets + ' 个被 .gitignore 挡住但运行时必需的文件（vendor/）' : 'vendor/ 已齐'));
  console.log('\n   ⚠ 别在主仓和 worktree 里同时跑 `npm run dev`：Electron 有单实例锁，后起的会静默退出。');

  console.log('\n' + '-'.repeat(72));
  console.log('把下面这段整段贴给那个 AI（它不知道主仓在干嘛，必须自包含）：\n');
  console.log(promptCard(id, wt, br));
  console.log('-'.repeat(72));

  console.log('\n收工后（在**主仓**执行）：node tools/wt.js merge ' + id);
}

function promptCard(id, wt, br) {
  return [
    '你正在一个独立的 git worktree 里工作，路径：',
    '  ' + wt,
    '分支 ' + br + '，与主仓互不影响。**所有命令都在这个目录里执行，不要去别的地方。**',
    '',
    '你的任务：开发 / 改造 App `' + id + '`。',
    '',
    '硬性边界（越界会在合并时被拦下）：',
    '  ✅ 只改 apps/' + id + '/ 下的文件（app.js / app.css / body.js …）',
    '  ✅ apps/manifest.js 允许变，但**只能**由 `node tools/app-scan.js` 生成，不许手写',
    '  ❌ index.html / js/ / css/ / electron/ / tools/ 一律不要动',
    '     （万一确实必须动，先停下来说明理由，由人在主仓统一改）',
    '',
    '做法：',
    '  1) 没有目录就 `cp -r apps/hello apps/' + id + '`，有就接着改',
    '  2) 遵 apps/README.md 的六条禁令：IIFE 包住、mount() 幂等、',
    '     不写 #<winId>{width/height}、不叠一层 padding、不覆盖 .os-win 等公共类、',
    '     不碰 window.openagiDesktop 与 localStorage 里的 Key',
    '  3) `node tools/app-scan.js` 生成清单（不跑就不显示在桌面上）',
    '  4) `node tools/app-registry.js` 自检（36 条，含幂等）',
    '  5) `node tools/apps-all.js` 更狠：把全部 App 逐个打开，确认没把别人搞坏',
    '',
    '做完就停，不要自己合分支、不要 push。由人在主仓跑 `node tools/wt.js merge ' + id + '`。'
  ].join('\n');
}

/* ---------------- list / status ---------------- */
function readWorktrees() {
  const out = must(['worktree', 'list', '--porcelain']);
  return out.split('\n\n').filter(Boolean).map(block => {
    const rec = {};
    block.split('\n').forEach(ln => {
      const i = ln.indexOf(' ');
      if (i < 0) { rec[ln] = true; return; }
      rec[ln.slice(0, i)] = ln.slice(i + 1);
    });
    rec.branch = (rec.branch || '').replace(/^refs\/heads\//, '');
    return rec;
  });
}

/* 分支相对基线改了什么。用 merge-base 而不是直接 diff base：分支可能落后于基线 */
function diffOf(br, base) {
  const mb = git(['merge-base', base || BASE_BRANCH, br]);
  if (!mb.ok) return { files: [], mb: '' };
  const r = git(['diff', '--name-only', mb.out + '...' + br]);
  return { files: r.ok ? r.out.split('\n').filter(Boolean) : [], mb: mb.out };
}

function cmdList() {
  const wts = readWorktrees();
  console.log('\n=== worktree (' + wts.length + ') ===');
  wts.forEach(w => {
    const appBranch = /^app\//.test(w.branch || '');
    const id = appBranch ? w.branch.slice(4) : '';
    console.log('\n· ' + w.worktree);
    console.log('  分支 ' + (w.branch || '(detached)') + (w.bare ? '  [bare]' : ''));
    if (id) {
      const d = diffOf(w.branch);
      const c = classify(id, d.files);
      console.log('  改动 ' + d.files.length + ' 个文件' +
        (c.out.length ? '  ⚠ 越界 ' + c.out.length + ' 个：' + c.out.slice(0, 4).join(', ') : '  ✅ 全在 apps/' + id + '/'));
    }
  });
  console.log('\n主仓改动：' + (git(['status', '--porcelain']).out ? '有未提交文件' : '干净'));
  console.log('node_modules 共享：' + (fs.existsSync(path.join(REPO, 'node_modules')) ? '是（junction）' : '主仓没有 node_modules'));
}

function cmdStatus(id, flags) {
  needId(id);
  const br = branchOf(id);
  if (!branchExists(br)) die('没有这个分支：' + br);
  const d = diffOf(br, flags.base);
  const c = classify(id, d.files);
  console.log('\n=== ' + br + ' ===');
  console.log('目录 ' + pathOf(id) + (fs.existsSync(pathOf(id)) ? '' : '  （worktree 已拆除，只剩分支）'));
  console.log('基线提交 ' + (d.mb || '?'));
  console.log('\n自己的地盘 ' + c.ok.length + ' 个：');
  c.ok.forEach(f => console.log('  ✅ ' + f));
  if (c.gen.length) console.log('\n生成物（允许变，合并时会重算）：' + c.gen.join(', '));
  if (c.out.length) {
    console.log('\n⚠ 越界 ' + c.out.length + ' 个（合并会被拦下，除��加 --allow-shared）：');
    c.out.forEach(f => console.log('  ❌ ' + f));
  }
  console.log('\n提交：');
  git(['log', '--oneline', (d.mb || BASE_BRANCH) + '..' + br]).out.split('\n').filter(Boolean)
    .forEach(l => console.log('  ' + l));
  return c.out.length;
}

/* ---------------- merge ---------------- */
function cmdMerge(id, flags) {
  needId(id);
  const br = branchOf(id);
  if (!branchExists(br)) die('没有这个分支：' + br);

  const cur = must(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (/^app\//.test(cur)) die('你正在 ' + cur + ' 里，合并必须回主仓执行（cd ' + REPO + '）');

  const dirty = git(['status', '--porcelain']).out;
  if (dirty) {
    die('主仓有未提交改动，先提交或 stash 再合并：\n' + dirty.split('\n').slice(0, 8).join('\n'));
  }

  const d = diffOf(br);
  const c = classify(id, d.files);
  if (!d.files.length) die(br + ' 相对基线没有任何改动，没什么可合的');
  if (c.out.length && !flags.allowShared) {
    console.error('\n❌ 这个分支动了别人的文件，拒绝合并：');
    c.out.forEach(f => console.error('   ' + f));
    console.error('\n   这些改动本该由人在主仓统一提交。确实要合就加 --allow-shared，但请逐条看过。\n');
    process.exit(1);
  }
  if (c.out.length) console.log('⚠ --allow-shared：将一并合入 ' + c.out.length + ' 个共享文件：' + c.out.join(', ') + '\n');

  console.log('· 合并 ' + br + ' → ' + cur + '（' + c.ok.length + ' 个 App 文件 + manifest）');
  const m = git(['merge', '--no-ff', '--no-commit', br]);
  if (!m.ok) {
    /* 唯一能自动解的冲突：apps/manifest.js（每边都重算过，内容天然不同） */
    const conflicted = git(['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
    const onlyManifest = conflicted.length > 0 && conflicted.every(f => f === 'apps/manifest.js');
    if (!onlyManifest) {
      git(['merge', '--abort']);
      die('合并冲突，已回滚：\n' + conflicted.map(f => '   ' + f).join('\n') +
        '\n\n   这些文件两边都改了，需要人看着合。');
    }
    console.log('· apps/manifest.js 冲突（正常，两边都生成过）→ 取一边，稍后重算');
    git(['checkout', '--ours', '--', 'apps/manifest.js']);
    must(['add', '--', 'apps/manifest.js']);
  }
  if (!git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).ok) {
    console.log('· 没有实际需要合入的提交（Already up to date）');
    return;
  }

  /* manifest 是生成物：不管解的哪一边，合完都按磁盘上的 apps/ 重算一次 */
  console.log('· 重算 apps/manifest.js');
  const scan = runNode('tools/app-scan.js');
  if (!scan.ok) {
    git(['merge', '--abort']);
    die('重算清单失败，已回滚：\n' + scan.out);
  }
  if (git(['status', '--porcelain', '--', 'apps/manifest.js']).out) must(['add', '--', 'apps/manifest.js']);

  /* 门禁：全部是纯 node、秒级，故意不跑 app-registry/apps-all（要开浏览器，留给人） */
  if (!flags.noGate) {
    console.log('· 门禁');
    const gates = [
      ['tools/app-scan.js', ['--check'], '清单同步'],
      ['tools/ns-guard.js', [], '命名空间'],
      ['tools/css-links.js', [], '样式挂载'],
    ];
    for (const [f, a, name] of gates) {
      const r = runNode(f, a);
      if (!r.ok) {
        git(['merge', '--abort']);
        die(name + ' 守卫没过，已回滚（主仓回到合并前）：\n' + r.out.split('\n').slice(-14).join('\n'));
      }
      console.log('   ✅ ' + name);
    }
  }

  const subj = git(['log', '--format=%s', d.mb + '..' + br]).out.split('\n').filter(Boolean);
  const msg = ['merge(apps): 并入 ' + br, '', '来自 worktree ' + pathOf(id), '']
    .concat(subj.map(s => '- ' + s)).join('\n');
  const cm = git(['commit', '-q', '-m', msg]);
  if (!cm.ok) {
    git(['merge', '--abort']);
    die('提交失败，已回滚：' + (cm.err || cm.out));
  }

  console.log('\n✅ 已合入 ' + id + '（' + git(['rev-parse', '--short', 'HEAD']).out + '）');
  console.log('   建议接着跑（要浏览器）：node tools/app-registry.js && node tools/apps-all.js');
  console.log('   拆掉工作区：node tools/wt.js rm ' + id);
}

/* ---------------- rm ---------------- */
function cmdRm(id, flags) {
  needId(id);
  const br = branchOf(id);
  const wt = pathOf(id);

  if (fs.existsSync(wt)) {
    /* ⚠ 顺序不能反：先把 junction 摘掉再让 git 删目录 */
    const nm = path.join(wt, 'node_modules');
    if (isLink(nm)) {
      console.log('· 摘掉 node_modules 链接（' + (unlinkJunction(nm) ? 'ok' : '⚠ 失败，先手动删掉再重试') + '）');
      if (isLink(nm)) die('链接还在，拒绝继续：git 删目录时可能顺着它把主仓 node_modules 一起删掉。');
    }
    const rmArgs = ['worktree', 'remove', wt];
    const r = git(rmArgs);
    if (!r.ok) {
      if (!flags.force && !flags.dropBranch) {
        die('worktree 删不掉（有未提交改动或未跟踪文件）：\n' + (r.err || r.out) +
          '\n   确认要丢就加 --force');
      }
      must(['worktree', 'remove', '--force', wt]);
    }
    console.log('✅ 已拆除 ' + wt);
  } else {
    console.log('· worktree 目录本来就不在：' + wt);
  }

  if (!branchExists(br)) { console.log('· 分支 ' + br + ' 已不存在'); return; }
  const d = git(['branch', '-d', br]);
  if (d.ok) {
    console.log('✅ 已删除分支 ' + br);
  } else if (flags.dropBranch) {
    must(['branch', '-D', br]);
    console.log('✅ 已强制删除未合并分支 ' + br + '（改动丢弃）');
  } else {
    console.log('· 分支 ' + br + ' 还没合并，保留着（合：node tools/wt.js merge ' + id + '；丢弃：加 --drop-branch）');
  }
  git(['worktree', 'prune']);
}

/* ---------------- 入口 ---------------- */
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const pos = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--base') { flags.base = argv[++i]; continue; }      /* 带值 */
  if (a.slice(0, 2) === '--') { flags[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true; continue; }
  pos.push(a);
}
/* 想丢分支就等于同意强拆，别让人写两个开关 */
if (flags.dropBranch) flags.force = true;

try {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const hdr = fs.readFileSync(__filename, 'utf8').split('*/')[0]
      .replace(/^#![^\n]*\n/, '')
      .replace(/^\/\* ?/, '')
      .split('\n').map(l => l.replace(/^ ?\* ?/, '')).join('\n').trim();
    console.log(hdr);
    process.exit(0);
  }
  if (cmd === 'new') cmdNew(pos[0], flags);
  else if (cmd === 'list') cmdList();
  else if (cmd === 'status') process.exit(cmdStatus(pos[0], flags) ? 1 : 0);
  else if (cmd === 'merge') cmdMerge(pos[0], flags);
  else if (cmd === 'rm') cmdRm(pos[0], flags);
  else die('未知命令：' + cmd + '（可用：new / list / status / merge / rm）');
} catch (e) {
  die(e && e.message ? e.message : String(e));
}
