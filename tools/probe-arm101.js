/* 探针：101 机械臂控制台
 *
 * 验证这条链路真的能跑：桌面图标 → 三维视口 → 关节滑杆 → SCS 信号帧 → 演示 / 急停。
 * 默认无头；截图由 PROBE_SHOTS 控制，产物只进本次运行目录。
 *
 * 用法：node tools/probe-arm101.js
 *       node tools/test-headless.js arm101
 */
'use strict';

const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');
const { createRun } = require('./probe-run');

const ROOT = path.resolve(__dirname, '..');
const run = createRun('probe-arm101');
const fails = [];
const pageErrors = [];

function check(ok, name, extra) {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails.push(name + (extra ? ' · ' + extra : ''));
  return !!ok;
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => pageErrors.push(String((e && e.stack) || e)));

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  check(await page.evaluate(() => !!document.querySelector('.desk-app[data-app="arm101"]')),
    '桌面图标存在');

  await page.evaluate(() => window.openDeskApp('arm101'));
  await page.waitForTimeout(1800);

  const s1 = await page.evaluate(() => {
    const win = document.getElementById('arm101Win');
    const canvas = win && win.querySelector('canvas.arm101-canvas');
    const r = canvas ? canvas.getBoundingClientRect() : null;
    const stats = win ? [...win.querySelectorAll('.arm101-stat b')].map(b => b.textContent) : [];
    return {
      visible: win ? !win.classList.contains('hidden') : false,
      canvas: !!canvas,
      size: r ? [Math.round(r.width), Math.round(r.height)] : [0, 0],
      joints: win ? win.querySelectorAll('.arm101-joint').length : 0,
      logLines: win ? win.querySelectorAll('.arm101-log .arm101-line').length : 0,
      linked: win ? win.querySelector('.arm101-root').dataset.link : '',
      tip: stats.slice(0, 3),
      packets: stats[3] || ''
    };
  });

  check(s1.visible, '窗口打开并翻到前台');
  check(s1.canvas && s1.size[0] > 400 && s1.size[1] > 380, '三维画布铺开', s1.size.join(' × '));
  check(s1.joints === 6, '六个关节行齐全', String(s1.joints));
  check(s1.linked === 'on' && s1.logLines >= 2, '模拟串口自动连接并输出信号日志',
    'link=' + s1.linked + ' · lines=' + s1.logLines);
  check(s1.tip.every(v => /^-?\d+$/.test(v)), '末端位置读数来自运动学计算', s1.tip.join(' / '));

  await run.shot(page, 'window.png');

  /* 单关节：滑杆 → 目标角 → 一帧 WRITE + ACK */
  const before = await page.evaluate(() =>
    document.querySelectorAll('#arm101Win .arm101-line.is-tx').length);
  await page.evaluate(() => {
    const input = document.querySelector('#arm101Win .arm101-range');
    input.value = '65';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(700);
  const s2 = await page.evaluate(() => {
    const win = document.getElementById('arm101Win');
    return {
      val: win.querySelector('.arm101-jval span').textContent,
      tx: win.querySelectorAll('.arm101-line.is-tx').length,
      rx: win.querySelectorAll('.arm101-line.is-rx').length,
      frame: [...win.querySelectorAll('.arm101-line.is-tx .arm101-msg')].pop().textContent
    };
  });
  check(s2.val === '65', '滑杆值写回关节读数', s2.val);
  check(s2.tx === before + 1 && s2.rx >= 1, '下发一帧位置指令并收到 ACK',
    'tx=' + s2.tx + ' rx=' + s2.rx);
  check(/FF FF 01 05 03 2A/.test(s2.frame), 'SCS 帧头 / 指令 / 地址正确', s2.frame.slice(0, 40));

  /* 全量同步 */
  await page.evaluate(() => document.querySelector('#arm101Win [data-act="send"]').click());
  await page.waitForTimeout(500);
  const s3 = await page.evaluate(() => {
    const win = document.getElementById('arm101Win');
    return {
      sync: [...win.querySelectorAll('.arm101-line.is-tx .arm101-msg')].some(x => /SYNC_WRITE 6 servos/.test(x.textContent)),
      ack: [...win.querySelectorAll('.arm101-line.is-rx .arm101-msg')].some(x => /SYNC ACK 6\/6/.test(x.textContent))
    };
  });
  check(s3.sync && s3.ack, 'SYNC_WRITE 六轴 + 6/6 应答');

  /* 演示序列 */
  await page.evaluate(() => document.querySelector('#arm101Win [data-act="demo"]').click());
  await page.waitForTimeout(1900);
  const s4 = await page.evaluate(() => {
    const win = document.getElementById('arm101Win');
    return {
      btn: win.querySelector('[data-act="demo"]').textContent,
      demos: [...win.querySelectorAll('.arm101-line')].filter(x => /DEMO \d+\/\d\d/.test(x.textContent)).length
    };
  });
  check(s4.btn === '停止演示' && s4.demos >= 1, '演示序列运行并逐帧下发', s4.demos + ' 步');
  await run.shot(page, 'demo.png');
  await page.evaluate(() => document.querySelector('#arm101Win [data-act="demo"]').click());
  await page.waitForTimeout(200);
  check(await page.evaluate(() => document.querySelector('#arm101Win [data-act="demo"]').textContent) === '演示序列',
    '演示可停止');

  /* 夹爪抓取：六轴摆到抓取位 → 张开 → 闭合夹起工件 → 张开释放 */
  const setJoints = (vals) => page.evaluate((v) => {
    document.querySelectorAll('#arm101Win .arm101-range').forEach((el, i) => {
      el.value = String(v[i]);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }, vals);

  await setJoints([0, 0, 26, 55, 0, 85]);
  await page.waitForTimeout(1400);
  await setJoints([0, 0, 26, 55, 0, 10]);
  await page.waitForTimeout(900);
  check(await page.evaluate(() =>
    [...document.querySelectorAll('#arm101Win .arm101-msg')].some(x => /工件已夹持/.test(x.textContent))),
    '夹爪闭合后夹起工件');
  await run.shot(page, 'grab.png');

  await setJoints([0, 0, 20, 60, 0, 90]);
  await page.waitForTimeout(900);
  check(await page.evaluate(() =>
    [...document.querySelectorAll('#arm101Win .arm101-msg')].some(x => /工件落于工作台/.test(x.textContent))),
    '夹爪张开后释放工件');

  /* 急停 / 解除 */
  await page.evaluate(() => document.querySelector('#arm101Win [data-act="estop"]').click());
  await page.waitForTimeout(250);
  const s5 = await page.evaluate(() => {
    const win = document.getElementById('arm101Win');
    return {
      banner: !win.querySelector('.arm101-estop-banner').hidden,
      locked: [...win.querySelectorAll('.arm101-range')].every(x => x.disabled),
      estop: win.querySelector('.arm101-root').dataset.estop
    };
  });
  check(s5.banner && s5.locked && s5.estop === '1', '急停：横幅出现、滑杆锁定');
  await page.evaluate(() => document.querySelector('#arm101Win [data-act="estop"]').click());
  await page.waitForTimeout(250);
  const s6 = await page.evaluate(() => {
    const win = document.getElementById('arm101Win');
    return {
      banner: win.querySelector('.arm101-estop-banner').hidden,
      unlocked: [...win.querySelectorAll('.arm101-range')].every(x => !x.disabled)
    };
  });
  check(s6.banner && s6.unlocked, '解除急停后恢复控制', JSON.stringify(s6));

  /* 关闭再打开：mount 幂等，场景不重建 */
  await page.evaluate(() => document.querySelector('#btnArm101WinClose').click());
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.getElementById('arm101Win').classList.contains('hidden')),
    '关闭按钮把窗口收回桌面');
  await page.evaluate(() => window.openDeskApp('arm101'));
  await page.waitForTimeout(700);
  const s7 = await page.evaluate(() => {
    const win = document.getElementById('arm101Win');
    return {
      joints: win.querySelectorAll('.arm101-joint').length,
      canvas: win.querySelectorAll('canvas.arm101-canvas').length,
      visible: !win.classList.contains('hidden')
    };
  });
  check(s7.visible && s7.joints === 6 && s7.canvas === 1, '重新打开不重复建 DOM / 场景',
    'joints=' + s7.joints + ' canvas=' + s7.canvas);

  check(pageErrors.length === 0, '全程无 JS 报错', pageErrors[0] || '');

  await browser.close();
  const ok = run.finish(fails, { pageErrors: pageErrors });
  console.log(ok ? '\n✅ probe-arm101 通过' : '\n❌ probe-arm101 失败：' + fails.join(' / '));
  console.log('产物目录：' + run.dir);
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error(e);
  run.finish([e]);
  process.exit(1);
});
