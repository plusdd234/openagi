#!/usr/bin/env node
/* tools/probe-run.js —— 无头探针的运行沙箱
 *
 * 解决的问题：多个 AI 同时跑不同 App 的探针时，截图、临时文件、结果文件
 * 不能写死成 tools/_x.png / tools/shots/x.png / tmp-shots/x.png，否则互相覆盖。
 *
 * 约定：
 *   - 每次运行一个唯一目录：.workbuddy/runs/<yyyyMMdd-HHmmss>-<pid>-<tool>/
 *   - 设置 PROBE_RUN_DIR 时用它作为本次运行目录（由 tools/test-headless.js 传入）
 *   - PROBE_SHOTS=0 关闭截图（无头回归默认关闭）
 *   - PROBE_SHOTS=1 强制允许截图
 *
 * 用法：
 *   const { createRun } = require('./probe-run');
 *   const run = createRun('probe-modeldesk');
 *   await run.shot(page, 'window');       // -> <run.dir>/window.png
 *   run.artifact('cube.obj');             // 临时文件路径
 *   run.finish(errors);                   // 写 result.json
 *
 * 注意：这个文件不是测试，不会自己执行。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function pad(n) { return String(n).padStart(2, '0'); }

function stamp(date) {
  const d = date || new Date();
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
    pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function safe(name) {
  return String(name || 'run')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'run';
}

function createRun(tool, opts) {
  opts = opts || {};
  const id = stamp() + '-' + process.pid + '-' + safe(tool);
  const dir = process.env.PROBE_RUN_DIR
    ? path.resolve(process.env.PROBE_RUN_DIR)
    : path.join(ROOT, '.workbuddy', 'runs', id);
  fs.mkdirSync(dir, { recursive: true });

  const startedAt = new Date().toISOString();
  const artifacts = [];
  const run = {
    id: id,
    dir: dir,
    startedAt: startedAt,
    shotsEnabled: process.env.PROBE_SHOTS !== '0',

    artifact: function (name) {
      const p = path.join(dir, safe(name));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      return p;
    },

    /* 截图：默认进唯一目录；PROBE_SHOTS=0 时跳过。 */
    shot: async function (target, name, options) {
      if (!run.shotsEnabled) return null;
      if (!target || typeof target.screenshot !== 'function') return null;
      const p = run.artifact(name || ('shot-' + (artifacts.length + 1) + '.png'));
      const o = Object.assign({}, options || {}, { path: p });
      await target.screenshot(o);
      artifacts.push(p);
      console.log('[shot] ' + path.relative(ROOT, p));
      return p;
    },

    writeJson: function (name, data) {
      const p = run.artifact(name || 'result.json');
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
      return p;
    },

    finish: function (errors, extra) {
      const list = (errors || []).map(function (e) {
        return typeof e === 'string' ? e : String((e && e.stack) || (e && e.message) || e);
      });
      const result = Object.assign({
        tool: tool,
        pid: process.pid,
        startedAt: startedAt,
        finishedAt: new Date().toISOString(),
        ok: list.length === 0,
        errors: list,
        artifacts: artifacts.slice()
      }, extra || {});
      run.writeJson('result.json', result);
      return result.ok;
    }
  };

  run.tmpDir = run.dir;
  return run;
}

/* 只需要一个唯一目录、不打算写 result.json 的场景 */
function runDir(tool) {
  return createRun(tool).dir;
}

/* 兼容没有设置 HOME/TEMP 的精简环境 */
function tmpRoot() {
  return process.env.PROBE_TMP_ROOT || os.tmpdir();
}

module.exports = { createRun, runDir, tmpRoot, ROOT };
