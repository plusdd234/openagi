#!/usr/bin/env node
/* 扫描 apps/<id>/app.js，生成 apps/manifest.js。
 *
 * 为什么需要「生成」而不是「手写清单」：多个 AI 并行写不同 App 时，
 * 清单是唯一还会被所有人碰的文件。把它变成生成物，就没人需要碰它了 ——
 * 每个 AI 只写自己的 apps/<id>/ 目录，跑一次本脚本即可。（这是并行的最后一公里。）
 *
 * 为什么用「内联」而不是 document.write 插入 <script src>：
 *   file:// 下 fetch 一个 .html/.js 回来会被 CORS 拦（实测 Failed to fetch），
 *   而 document.write 插脚本又容易被浏览器的干预机制挡、且顺序依赖解析时机。
 *   内联是唯一在 file:// 与 app:// 下都确定可行的形式。
 *   代价是行号偏移 —— 所以每块前面都写了来源文件，出错时按注释找回去。
 *
 * 用法：node tools/app-scan.js [--check]
 *   --check  只校验不同步写盘（和现有 manifest 不一致时退出码 1，可挂进体检）
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APPS = path.join(ROOT, 'apps');
const OUT = path.join(APPS, 'manifest.js');
const CHECK = process.argv.includes('--check');

if (!fs.existsSync(APPS)) {
  console.error('没有 apps/ 目录');
  process.exit(1);
}

/* 只认 apps/<id>/app.js，apps/manifest.js 自己不算 App */
const dirs = fs.readdirSync(APPS, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .filter(name => fs.existsSync(path.join(APPS, name, 'app.js')))
  .sort();

const problems = [];
const parts = [];
const ids = [];

for (const name of dirs) {
  const file = path.join(APPS, name, 'app.js');
  const src = fs.readFileSync(file, 'utf8');

  /* 一个 app.js 可以注册多个 App（图库 / 模型库共用一个 #libWin 就是这样），
     所以校验的是「目录名是其中一个 id」，不是「目录名等于唯一 id」。 */
  const allIds = [...src.matchAll(/\bid\s*:\s*['"]([^'"]+)['"]/g)].map(x => x[1]);
  if (!allIds.length) {
    problems.push('apps/' + name + '/app.js 里没找到 id');
  } else {
    for (const id of allIds) ids.push(id);
    if (allIds.indexOf(name) < 0) {
      problems.push('目录名 ' + name + ' 不在它注册的 id 里（' + allIds.join(' , ') + '）—— 主入口应当与目录同名');
    }
  }

  /* 必须整体包 IIFE：否则 App 的顶层名字会进那个共享 window 作用域。
     判据要**先剥注释再取第一行** —— app.js 开头通常是一大段说明注释，
     直接拿 /^\s*\(function/ 匹配整份文件会误报（这个误报踩过一次）。 */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|[^:\\])\/\/.*$/, '$1'))
    .join('\n')
    .trim();
  if (!/^\(function\s*\(/.test(code)) {
    problems.push('apps/' + name + '/app.js 没有整体包 IIFE（会和别的 App 撞名）');
  }

  parts.push('/* ---- apps/' + name + '/app.js ---- */\n' + src.trim() + '\n');

  /* 少数 App 的窗口 DOM 要跟独立页共用（多视图就是这样），那份 DOM 放在同目录的 body.js 里。
     它必须在 app.js **之前**内联 —— app.js 里 `body: window.MV_BODY` 是立即求值的。 */
  const bodyFile = path.join(APPS, name, 'body.js');
  if (fs.existsSync(bodyFile)) {
    const bsrc = fs.readFileSync(bodyFile, 'utf8');
    /* 插到刚 push 的 app.js 之前 */
    parts.splice(parts.length - 1, 0, '/* ---- apps/' + name + '/body.js ---- */\n' + bsrc.trim() + '\n');
  }
}

/* id 重复会在注册时被拒（registerApp 会 warn），但那时用户已经看到半个界面了，这里先拦 */
const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
if (dup.length) problems.push('id 重复: ' + [...new Set(dup)].join(' , '));

const banner =
'/* ============================================================\n' +
' * 自动生成，别手改 —— node tools/app-scan.js\n' +
' * App 清单：' + (dirs.length ? dirs.join(' , ') : '（空）') + '\n' +
' *\n' +
' * 加一个 App = 建 apps/<id>/app.js（参考 apps/hello）+ 跑一次 app-scan。\n' +
' * index.html 与 desk-shell.js 都不用碰，所以多路 AI 并行时不会互相踩。\n' +
' * ============================================================ */\n';

const body = parts.length ? parts.join('\n') : '/* 还没有 App */\n';
const next = banner + body;

if (problems.length) {
  console.error('❌ apps/ 有问题，未写盘：');
  for (const p of problems) console.error('   · ' + p);
  process.exit(1);
}

const prev = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';

if (CHECK) {
  if (prev !== next) {
    console.error('❌ apps/manifest.js 与 apps/ 不一致，跑一次 node tools/app-scan.js');
    process.exit(1);
  }
  console.log('✅ apps/manifest.js 已是最新（' + dirs.length + ' 个 App：' + (dirs.join(' , ') || '空') + '）');
  process.exit(0);
}

if (prev === next) {
  console.log('✅ 无变化（' + dirs.length + ' 个 App：' + (dirs.join(' , ') || '空') + '）');
  process.exit(0);
}

fs.writeFileSync(OUT, next);
console.log('✅ 已生成 apps/manifest.js —— ' + dirs.length + ' 个 App：' + (dirs.join(' , ') || '空'));
