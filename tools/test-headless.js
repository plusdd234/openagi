#!/usr/bin/env node
/* tools/test-headless.js —— 无头测试入口
 *
 * 目标：
 *   1. 默认无头运行，不打开可见浏览器；
 *   2. 每次运行一个唯一产物目录，截图/临时文件不再互相覆盖；
 *   3. 静态守卫 + 目标 App 探针一次跑完，返回可机器读取的退出码。
 *
 * 用法：
 *   node tools/test-headless.js                    # 只跑静态守卫
 *   node tools/test-headless.js browser            # 静态守卫 + 浏览器 App 探针
 *   node tools/test-headless.js chat code          # 多个目标
 *   node tools/test-headless.js --all              # 跑所有已登记的 App 探针
 *   node tools/test-headless.js tools/probe-x.js   # 直接指定探针文件
 *
 * 选项：
 *   --all              跑所有已登记探针
 *   --full             额外跑 app-registry / apps-all
 *   --registry         只额外跑 app-registry
 *   --skip-static      跳过静态守卫
 *   --shots            允许探针截图（默认关闭）
 *   --json             只输出最终 JSON 摘要
 *   --timeout <ms>     单个探针超时，默认 300000
 *   --headed           调试用，允许探针打开可见浏览器（默认无头）
 *
 * 产物：
 *   .workbuddy/runs/<yyyyMMdd-HHmmss>-<pid>/
 *     summary.json
 *     <probe-name>/result.json
 *     <probe-name>/*.png
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STAMP = (function () {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
})();

const ALIASES = {
  browser: 'tools/probe-browser.js',
  chat: 'tools/desk-chat.js',
  code: 'tools/test-code-run.js',
  desk: 'tools/desk-tabs.js',
  gallery: 'tools/probe-library-rename.js',
  library: 'tools/probe-library-rename.js',
  imglab: 'tools/probe-imglab.js',
  modeldesk: 'tools/probe-modeldesk.js',
  multiview: 'tools/probe-mv-app.js',
  models: 'tools/model-store.js'
};

const ALL = ['browser', 'imglab', 'modeldesk', 'multiview', 'gallery'];
const STATIC = [
  ['app-scan', 'tools/app-scan.js', '--check'],
  ['ns-guard', 'tools/ns-guard.js'],
  ['conf-guard', 'tools/conf-guard.js'],
  ['css-links', 'tools/css-links.js']
];

function parseArgs(argv) {
  const out = {
    targets: [], all: false, full: false, registry: false,
    skipStatic: false, shots: false, json: false, headed: false,
    timeout: 300000
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--full') { out.full = true; out.registry = true; }
    else if (a === '--registry') out.registry = true;
    else if (a === '--skip-static') out.skipStatic = true;
    else if (a === '--shots') out.shots = true;
    else if (a === '--json') out.json = true;
    else if (a === '--headed') out.headed = true;
    else if (a === '--timeout') out.timeout = Math.max(1000, Number(argv[++i]) || 300000);
    else if (a === '--help' || a === '-h') { out.help = true; }
    else if (a.charAt(0) === '-') throw new Error('未知参数：' + a);
    else out.targets.push(a);
  }
  return out;
}

function resolveTarget(t) {
  if (/\.(c|m)?js$/i.test(t)) {
    const p = path.resolve(ROOT, t);
    return fs.existsSync(p) ? { name: path.basename(t, path.extname(t)), file: p } : null;
  }
  const file = ALIASES[t] || ('tools/probe-' + t + '.js');
  const p = path.resolve(ROOT, file);
  return fs.existsSync(p) ? { name: t, file: p } : null;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function runOne(label, file, args, runDir, opts) {
  const started = Date.now();
  const env = Object.assign({}, process.env, {
    PROBE_RUN_DIR: runDir,
    PROBE_SHOTS: opts.shots ? '1' : '0',
    PROBE_HEADLESS: opts.headed ? '0' : '1'
  });
  const res = spawnSync(process.execPath, [file].concat(args || []), {
    cwd: ROOT,
    env: env,
    encoding: 'utf8',
    timeout: opts.timeout || 300000,
    maxBuffer: 32 * 1024 * 1024
  });
  const duration = Date.now() - started;
  const ok = res.status === 0 && !res.error;
  const record = {
    label: label,
    file: rel(file),
    ok: ok,
    exitCode: res.status,
    signal: res.signal || null,
    durationMs: duration,
    timedOut: !!(res.error && res.error.code === 'ETIMEDOUT'),
    error: res.error ? String(res.error.message || res.error) : null,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    runDir: runDir
  };
  ensureDir(runDir);
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }

  if (opts.help) {
    console.log('用法: node tools/test-headless.js [app|probe.js ...] [--all] [--full] [--skip-static] [--shots] [--json] [--timeout ms]');
    return;
  }

  const runRoot = ensureDir(path.join(ROOT, '.workbuddy', 'runs', STAMP + '-' + process.pid));
  const results = [];

  if (!opts.skipStatic) {
    STATIC.forEach(function (def) {
      const dir = path.join(runRoot, 'static-' + def[0]);
      const r = runOne(def[0], path.resolve(ROOT, def[1]), def.slice(2), dir, opts);
      results.push(r);
      if (!opts.json) {
        console.log('[' + (r.ok ? 'PASS' : 'FAIL') + '] static/' + r.label + '  ' + (r.durationMs / 1000).toFixed(1) + 's');
        if (!r.ok && r.stdout.trim()) console.log(r.stdout.trim().split('\n').slice(-30).join('\n'));
        if (!r.ok && r.stderr.trim()) console.error(r.stderr.trim().split('\n').slice(-30).join('\n'));
      }
    });
  }

  if (opts.registry) {
    ['app-registry', 'apps-all'].forEach(function (name) {
      const file = path.resolve(ROOT, 'tools', name + '.js');
      if (!fs.existsSync(file)) return;
      const r = runOne(name, file, [], path.join(runRoot, name), opts);
      results.push(r);
      if (!opts.json) console.log('[' + (r.ok ? 'PASS' : 'FAIL') + '] registry/' + name + '  ' + (r.durationMs / 1000).toFixed(1) + 's');
    });
  }

  let targets = opts.targets.slice();
  if (opts.all) targets = targets.concat(ALL);
  targets = Array.from(new Set(targets));

  targets.forEach(function (t) {
    const resolved = resolveTarget(t);
    if (!resolved) {
      results.push({
        label: t, file: null, ok: false, exitCode: null, signal: null,
        durationMs: 0, timedOut: false, error: '没有找到探针：' + t,
        stdout: '', stderr: '', runDir: null
      });
      if (!opts.json) console.log('[FAIL] probe/' + t + '  没有找到探针');
      return;
    }
    const dir = path.join(runRoot, 'probe-' + resolved.name);
    const r = runOne(resolved.name, resolved.file, [], dir, opts);
    results.push(r);
    if (!opts.json) {
      console.log('[' + (r.ok ? 'PASS' : 'FAIL') + '] probe/' + r.label + '  ' + (r.durationMs / 1000).toFixed(1) + 's');
      if (!r.ok && r.stdout.trim()) console.log(r.stdout.trim().split('\n').slice(-40).join('\n'));
      if (!r.ok && r.stderr.trim()) console.error(r.stderr.trim().split('\n').slice(-40).join('\n'));
    }
  });

  const failed = results.filter(function (r) { return !r.ok; });
  const summary = {
    ok: failed.length === 0,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    runRoot: runRoot,
    headless: !opts.headed,
    shots: opts.shots,
    total: results.length,
    failed: failed.length,
    results: results
  };
  fs.writeFileSync(path.join(runRoot, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log('');
    console.log('结果：' + (summary.ok ? 'PASS' : 'FAIL') +
      '  ' + (results.length - failed.length) + '/' + results.length +
      '  产物：' + rel(runRoot));
    if (failed.length) {
      failed.forEach(function (r) { console.log('  失败：' + r.label + '  ' + (r.error || ('exit ' + r.exitCode))); });
    }
  }

  process.exit(summary.ok ? 0 : 1);
}

main();
