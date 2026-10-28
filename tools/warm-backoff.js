/* 预热失败时的退避行为（不依赖真实 Ollama，桩可控）。
 *
 * 背景：预热失败（比如引擎刚好在重启）如果一直重试，
 * 每一次重试都可能是一次冷加载 = 一次黑窗口。
 * 所以必须有退避：连续失败 N 次就放弃这一轮。
 *
 * 跑法：node tools/warm-backoff.js
 */
'use strict';
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(c, m, x){ if(c){ pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m + (x?'  → '+x:'')); } }

async function run(failTimes, label, maxExpect){
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message || e)));
  await page.addInitScript((failTimes) => {
    const calls = { warm: 0 };
    window.__calls = calls;
    window.openagiDesktop = {
      enginesStatus: async () => ({ ollama: 'already', comfy: 'idle', run: true, done: true }),
      enginesConfig: async () => ({ ollama: true, comfy: true, warm: true }),
      enginesSetConfig: async () => ({}),
      enginesAutoStart: async () => ({}),
      enginesWarm: async () => {
        calls.warm++;
        // 前 failTimes 次失败，之后成功
        if(calls.warm <= failTimes) return { ok: false, message: '引擎重启中' };
        return { ok: true, model: 'qwen2.5:3b' };
      },
      enginesKeepalive: async () => ({ model: '', running: false }),
      enginesKeepalivePing: async () => ({ ok: true }),
      onEngineStatus: () => {}
    };
  }, failTimes);

  const url = 'file:///' + ROOT.replace(/\\/g, '/') + '/index.html?nostore=1';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  await page.evaluate(() => {
    const s = document.querySelector('#deskAiModel');
    if(!s) return;
    const o = document.createElement('option');
    o.value = 'oll:qwen2.5:3b'; o.textContent = 'qwen2.5:3b';
    s.appendChild(o);
    s.value = o.value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // 退避是 5 秒一次，最多 3 次失败就放弃 → 观察 20 秒足够
  await page.waitForTimeout(20000);
  const n = await page.evaluate(() => window.__calls.warm);
  const errs = errors.length;
  await browser.close();
  console.log('  ' + label + ': 预热调用 ' + n + ' 次（期望 ≤ ' + maxExpect + '），页面异常 ' + errs);
  return { n, errs };
}

async function main(){
  console.log('== 预热失败退避 ==');

  /* 一直失败 → 应该在 WARM_MAX_FAILS(3) 次后停手，而不是无限重试 */
  let r = await run(999, '一直失败', 4);
  check(r.n <= 4, '一直失败时预热次数有上限（不无限重试）', '实际 ' + r.n);
  check(r.errs === 0, '失败不抛页面异常', String(r.errs));

  /* 失败 1 次后成功 → 应该很快成功并停下 */
  r = await run(1, '失败1次后成功', 3);
  check(r.n >= 2, '失败后会重试', '实际 ' + r.n);
  check(r.n <= 4, '成功后停手（不继续重试）', '实际 ' + r.n);

  console.log('\n通过 ' + pass + ' / 失败 ' + fail);
  if(fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
