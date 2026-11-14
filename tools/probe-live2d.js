/* 探针：数字人 App（apps/live2d）
 *
 * 覆盖的关键点：
 *   ① 桌面图标 → 窗口能打开，Cubism canvas 渲染出来；
 *   ② 皮套真的加载成功：pack / 运行时就位，模型参数可读，加载态与错误态都收起；
 *   ③ 模型真的在动：呼吸参数持续变化；鼠标移左/移右，头部角度方向相反；
 *   ④ 表情 / 动作：情绪按钮切换 exp3 表情，动作条播放 motion3 动作；
 *   ⑤ 口型：流式增量下发时 ParamMouthOpenY 会被抬起；
 *   ⑥ 对话走统一 llmStreamRequest：流式渲染、情绪标记剥离、亲密度与记录落盘；
 *   ⑦ 角色面板改名；清空对话回到欢迎引导；
 *   ⑧ 关窗再开 mount 幂等：canvas 节点与模型实例都不重建；
 *   ⑨ 窄窗口不产生横向溢出；全程无 pageerror / console error。
 *   ⑩ 2.0：朗读语速落盘与文案同步、试听 utterance / boundary 口型 / Esc 中止、
 *      长期记忆整理与注入、Markdown 导出、快捷话题、清空记忆。
 *
 * 用法：node tools/probe-live2d.js [--shots]
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright-core');
const { createRun, ROOT } = require('./probe-run');

const run = createRun('probe-live2d');
let fails = 0;

function check(ok, name, extra) {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
}

const visible = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const cs = getComputedStyle(el);
  return !el.classList.contains('hidden') && cs.display !== 'none' &&
    cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
}, sel);

const rig = (page) => page.evaluate(() => (window.__l2dRig ? window.__l2dRig() : null));

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/speech|voice|audio/i.test(m.text())) {
      errors.push('console: ' + m.text());
    }
  });

  await page.goto(pathToFileURL(path.join(ROOT, 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  /* 每次从干净的本地状态开始，避免上一次运行留下的记录影响断言 */
  await page.evaluate(() => { try { localStorage.removeItem('hf_live2d_state'); } catch (e) { /* 忽略 */ } });
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1100);

  check(await page.evaluate(() => !!document.querySelector('.desk-app[data-app="live2d"]')),
    '桌面出现「数字人」图标');

  await page.evaluate(() => window.openDeskApp('live2d'));
  await page.waitForTimeout(600);

  check(await visible(page, '#live2dWin'), '数字人窗口已打开');

  /* ?nostore=1 只禁写，本地中转仍会回填上次的 hf_* 状态：
     用 App 自己的「恢复默认」把起点清干净，避免消息条数随机器漂移。 */
  await page.click('#live2dWin [data-tab="persona"]');
  await page.waitForTimeout(200);
  await page.click('#live2dWin #l2dReset');
  await page.waitForTimeout(260);
  await page.click('#live2dWin [data-tab="chat"]');
  await page.waitForTimeout(200);

  /* ② 皮套加载：moc3 是 2.1MB + 两张 2048 纹理，本地也要给足解析时间 */
  const loaded = await page.waitForFunction(
    () => window.__l2dRig && window.__l2dRig() !== null,
    null, { timeout: 25000 }
  ).then(() => true).catch(() => false);
  check(loaded, 'Cubism 皮套加载成功（moc3 + 纹理）');

  const cv = await page.evaluate(() => {
    const c = document.querySelector('#l2dCanvas canvas');
    if (!c) return null;
    return { w: c.clientWidth, h: c.clientHeight, loading: !document.querySelector('#l2dRigLoading').hidden };
  });
  check(!!cv && cv.w > 100 && cv.h > 200, 'canvas 已挂载且尺寸合理', cv ? cv.w + '×' + cv.h : '无 canvas');
  check(!!cv && !cv.loading, '加载态已收起');
  check(await page.evaluate(() => document.getElementById('l2dRigErr').hidden), '没有落进错误态');

  /* ③ 呼吸 / 头部：模型自己在动 */
  const a = await rig(page);
  await page.waitForTimeout(900);
  const b = await rig(page);
  const moved = a && b && (Math.abs(a.breath - b.breath) > 0.02 || Math.abs(a.angleY - b.angleY) > 0.2);
  check(!!moved, '皮套有持续微动（呼吸 / 物理）',
    a && b ? 'breath ' + a.breath.toFixed(3) + ' → ' + b.breath.toFixed(3) : '参数不可读');

  /* 视线：鼠标移到舞台左 / 右，头部角度符号应相反 */
  const box = await page.evaluate(() => {
    const r = document.querySelector('#l2dStage').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  await page.mouse.move(box.x + box.w * 0.1, box.y + box.h * 0.45);
  await page.waitForTimeout(1300);
  const left = await rig(page);
  await page.mouse.move(box.x + box.w * 0.9, box.y + box.h * 0.45);
  await page.waitForTimeout(1300);
  const right = await rig(page);
  check(left && right && left.angleX < -2 && right.angleX > 2,
    '视线跟随鼠标左右转头', left && right ? left.angleX.toFixed(1) + ' → ' + right.angleX.toFixed(1) : '参数不可读');

  /* 纵向：原点在模型眼睛处，鼠标移到头顶上方应当抬头（angleY 为正） */
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.08);
  await page.waitForTimeout(1300);
  const up = await rig(page);
  check(!!up && up.angleY > 2, '鼠标在头顶上方时抬头', up ? up.angleY.toFixed(1) : '参数不可读');
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5);

  /* ④ 表情与动作（表情按钮在角色面板里） */
  await page.click('#live2dWin [data-tab="persona"]');
  await page.waitForTimeout(240);
  await page.click('#live2dWin [data-emo="shy"]');
  await page.waitForTimeout(500);
  const shy = await rig(page);
  check(await page.evaluate(() => document.getElementById('l2dMood').textContent.trim() === '害羞'),
    '「害羞」切换情绪文案');
  check(!!shy && shy.expr === 'blush', '害羞映射到 blush 表情', shy ? shy.expr : '无');

  await page.click('#live2dWin [data-exp="sunglasses"]');
  await page.waitForTimeout(400);
  const glasses = await rig(page);
  check(!!glasses && glasses.expr === 'sunglasses', '角色面板可试演额外表情', glasses ? glasses.expr : '无');

  await page.click('#live2dWin [data-emo="neutral"]');
  await page.click('#live2dWin [data-act="selfie"]');
  await page.waitForTimeout(500);
  const act = await rig(page);
  check(!!act && act.motion === 'selfie', '动作条播放 motion3 动作', act ? act.motion : '无');

  /* ---------- 2.0 语音：音色 / 语速 / 试听口型 / Esc ---------- */
  /* 先停掉动作条自动朗读遗留的口型窗口，避免污染后面的 boundary 断言 */
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => {
    const p = window.__l2dRig && window.__l2dRig();
    return !p || p.mouth < 0.08;
  }, null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(180);

  check(await visible(page, '#live2dWin #l2dVoiceSel'), '角色面板出现朗读音色下拉');

  /* range 不支持 fill：直接设 value 再派发 input */
  await page.$eval('#live2dWin #l2dRate', (el) => {
    el.value = '1.2';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(220);
  const ttsSaved = await page.evaluate(() => {
    let st = null;
    try { st = JSON.parse(localStorage.getItem('hf_live2d_state') || 'null'); } catch (e) { st = null; }
    const label = document.getElementById('l2dRateVal');
    return {
      rate: st && st.persona && st.persona.tts ? st.persona.tts.rate : null,
      label: label ? label.textContent.trim() : ''
    };
  });
  check(ttsSaved.rate === 1.2 && ttsSaved.label === '1.2', '语速改 1.2 后落盘且数值文案同步',
    (ttsSaved.rate === null ? '没有 persona.tts' : 'rate ' + ttsSaved.rate) + ' / label ' + (ttsSaved.label || '空'));

  /* 覆盖系统朗读：记录 utterance，手动派发 start / boundary / end */
  await page.evaluate(() => {
    window.__l2dUtter = null;
    window.__l2dSpeakTimers = [];
    window.__l2dCancelCalls = 0;
    const syn = window.speechSynthesis;
    if (!syn) return;
    syn.speak = function (u) {
      window.__l2dUtter = u;
      window.__l2dSpeakTimers.push(setTimeout(function () {
        try { if (u.onstart) u.onstart({ elapsedTime: 0, charIndex: 0 }); } catch (e) { /* 忽略 */ }
      }, 0));
      window.__l2dSpeakTimers.push(setTimeout(function () {
        try { if (u.onboundary) u.onboundary({ charIndex: 0, charLength: 2, name: 'word' }); } catch (e) { /* 忽略 */ }
      }, 60));
      window.__l2dSpeakTimers.push(setTimeout(function () {
        try { if (u.onend) u.onend({ elapsedTime: 0.3 }); } catch (e) { /* 忽略 */ }
      }, 300));
    };
    syn.cancel = function () {
      window.__l2dCancelCalls++;
      (window.__l2dSpeakTimers || []).forEach(clearTimeout);
      window.__l2dSpeakTimers = [];
    };
  });

  /* 记录整个试听过程中的最大张口度，避免 boundary 脉冲被错过 */
  await page.evaluate(() => {
    window.__l2dMouthMax = 0;
    window.__l2dMouthStop = false;
    (function tick() {
      if (window.__l2dMouthStop) return;
      const p = window.__l2dRig && window.__l2dRig();
      if (p && p.mouth > window.__l2dMouthMax) window.__l2dMouthMax = p.mouth;
      requestAnimationFrame(tick);
    })();
  });

  await page.click('#live2dWin #l2dVoiceTest');
  await page.waitForTimeout(130);
  const speakingOn = await page.evaluate(() => !!(window.__l2dDiag && window.__l2dDiag().speaking));
  const utter = await page.evaluate(() => {
    const u = window.__l2dUtter;
    return u ? { rate: u.rate, text: String(u.text || '') } : null;
  });
  const nameNow = await page.evaluate(() => document.getElementById('l2dName').textContent.trim());
  /* SpeechSynthesisUtterance.rate 是 float32，1.2 会存成 1.200000047… */
  check(!!utter && Math.abs(utter.rate - 1.2) < 0.01 && !!nameNow && utter.text.indexOf(nameNow) >= 0,
    '试听 utterance 语速跟随设置且含角色名',
    utter ? 'rate ' + utter.rate + ' / ' + utter.text.slice(0, 18) : '没有捕获 speak');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(260);
  const voiceAfter = await page.evaluate(() => {
    window.__l2dMouthStop = true;
    return {
      mouthMax: window.__l2dMouthMax,
      speaking: window.__l2dDiag ? window.__l2dDiag().speaking : null,
      cancels: window.__l2dCancelCalls
    };
  });
  check(voiceAfter.mouthMax > 0.08, '试听 onboundary 驱动口型',
    'mouth 峰值 ' + Number(voiceAfter.mouthMax).toFixed(3));
  check(speakingOn && voiceAfter.speaking === false, '朗读期间 speaking 为真，Esc 后归零',
    'speaking ' + speakingOn + ' → ' + voiceAfter.speaking + ' / cancel ×' + voiceAfter.cancels);

  await page.click('#live2dWin [data-tab="chat"]');
  await page.waitForTimeout(200);

  /* 关掉朗读，避免无头环境真的去调语音引擎 */
  await page.click('#live2dWin #l2dVoice');

  /* ⑥ 对话：stub 统一入口，验证流式渲染 + 情绪剥离 + 落盘 */
  /* 2.0：同一个 llmStreamRequest 还要服务「整理记忆」，按 system 文本分流，互不覆盖 */
  await page.evaluate(() => {
    window.__l2dReq = null;
    window.__l2dMemReq = null;
    window.llmStreamRequest = function (sys, msgs, onDelta, opts) {
      const sysText = String(sys || '');
      /* 先认对话：对话 system 一定带人设 + 情绪规则；记忆注入后它也会出现「记忆」 */
      const isChat = sysText.indexOf('你是「') >= 0 && sysText.indexOf('情绪') >= 0;
      const isMem = !isChat && sysText.indexOf('记忆') >= 0;
      if (isChat) {
        window.__l2dReq = { sys: sysText, msgs: msgs, app: opts && opts.app };
      } else if (isMem) {
        window.__l2dMemReq = { sys: sysText, msgs: msgs, app: opts && opts.app };
      }
      const parts = isMem
        ? ['用户最近睡得晚，', '喜欢猫，', '希望被叫小汐。']
        : ['【开心】', '好呀，', '我一直', '在等你', '呢。'];
      return new Promise((res) => {
        let full = '';
        let i = 0;
        const timer = setInterval(() => {
          if (i >= parts.length) { clearInterval(timer); res(full); return; }
          const d = parts[i++];
          full += d;
          try { onDelta(full, d, {}); } catch (e) { /* 忽略渲染异常，由后面的断言兜 */ }
        }, 28);
      });
    };
  });

  await page.fill('#live2dWin #l2dInput', '今天有点累');
  await page.press('#live2dWin #l2dInput', 'Enter');

  /* ⑤ 口型：流式期间嘴巴参数被抬起过 */
  const mouthMoved = await page.waitForFunction(() => {
    const p = window.__l2dRig && window.__l2dRig();
    return !!p && p.mouth > 0.08;
  }, null, { timeout: 4000 }).then(() => true).catch(() => false);
  check(mouthMoved, '流式回复时口型参数被驱动');

  const req = await page.evaluate(() => window.__l2dReq);
  const stageName = await page.evaluate(() => document.getElementById('l2dName').textContent.trim());
  check(!!req && req.app === 'live2d', '对话走统一 llmStreamRequest 且带 app 标记');
  check(!!req && req.sys.indexOf(stageName) >= 0 && /情绪/.test(req.sys),
    '系统提示词带人设与情绪标注规则');
  check(!!req && req.msgs.length >= 1 && req.msgs[req.msgs.length - 1].content === '今天有点累',
    '用户消息进入上下文');

  await page.waitForTimeout(700);
  const chat = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('#live2dWin .l2d-msg')];
    const last = nodes[nodes.length - 1];
    return {
      count: nodes.length,
      user: (document.querySelector('#live2dWin .l2d-msg.u .l2d-bubble-txt') || {}).textContent || '',
      last: (last && last.querySelector('.l2d-bubble-txt') ? last.querySelector('.l2d-bubble-txt').textContent : ''),
      mood: document.getElementById('l2dMood').textContent.trim(),
      stored: (() => { try { return JSON.parse(localStorage.getItem('hf_live2d_state')); } catch (e) { return null; } })()
    };
  });
  check(chat.user === '今天有点累', '用户气泡已渲染', chat.user);
  check(chat.last.indexOf('好呀，我一直在等你呢。') >= 0, '流式回复完整落地', chat.last);
  check(chat.last.indexOf('【') < 0 && chat.last.indexOf('】') < 0, '情绪标记已从回复中剥离');
  check(chat.mood === '开心', '回复情绪驱动表情', chat.mood);
  check(!!chat.stored && chat.stored.msgs.length >= 2 && chat.stored.aff > 12,
    '聊天记录与亲密度已落盘', chat.stored ? chat.stored.msgs.length + ' 条 / 亲密 ' + chat.stored.aff : '无');

  /* 舞台气泡：回复同步贴到头顶，点一下可以收起 */
  const say = await page.evaluate(() => {
    const el = document.getElementById('l2dSay');
    const t = document.getElementById('l2dSayTxt');
    const box = el ? el.getBoundingClientRect() : null;
    const stg = document.getElementById('l2dStage');
    const g = stg.getBoundingClientRect();
    const r = window.__l2dRig ? window.__l2dRig() : null;
    return {
      hidden: !el || el.hidden,
      txt: t ? t.textContent.trim() : '',
      bottom: box ? Math.round(box.bottom) : 0,
      relTop: box ? Math.round(box.top - g.top) : 0,
      relBottom: box ? Math.round(box.bottom - g.top) : 0,
      cssBottom: el ? el.style.bottom : '',
      stageH: stg.clientHeight,
      headTop: r ? Math.round(r.headTop) : -1
    };
  });
  check(!say.hidden && say.txt.indexOf('好呀，我一直在等你呢。') >= 0,
    '舞台气泡显示最新回复', say.txt.slice(0, 24) || '气泡为空');
  check(!say.hidden && say.relBottom > 0 && say.relBottom <= say.stageH,
    '气泡落在舞台可见范围内',
    'top ' + say.relTop + ' / bottom ' + say.relBottom + ' / stage ' + say.stageH +
    ' / headTop ' + say.headTop + ' / cssBottom ' + say.cssBottom);
  await run.shot(page, 'live2d-say-wide.png');
  await page.click('#live2dWin #l2dSay');
  await page.waitForTimeout(140);
  check(await page.evaluate(() => document.getElementById('l2dSay').hidden), '点气泡可收起');

  /* ⑦ 角色面板 */
  await page.click('#live2dWin [data-tab="persona"]');
  await page.waitForTimeout(220);
  check(await visible(page, '#live2dWin .l2d-pane-persona'), '角色面板可切换');
  check(await visible(page, '#live2dWin .l2d-credit'), '角色面板带皮套署名');
  await page.fill('#live2dWin #l2dFName', '小汐');
  await page.click('#live2dWin #l2dSave');
  await page.waitForTimeout(260);
  check(await page.evaluate(() => document.getElementById('l2dName').textContent.trim() === '小汐'),
    '改名后舞台名牌同步');

  /* ---------- 2.0 长期记忆 / 导出 / 快捷话题 ---------- */
  await page.click('#live2dWin [data-tab="persona"]');
  await page.waitForTimeout(180);
  await page.click('#live2dWin #l2dMemNow');
  await page.waitForFunction(() => {
    const t = document.getElementById('l2dMemText');
    return !!t && String(t.value || t.textContent || '').indexOf('猫') >= 0;
  }, null, { timeout: 4000 }).catch(() => {});
  const mem = await page.evaluate(() => {
    const t = document.getElementById('l2dMemText');
    const d = window.__l2dDiag ? window.__l2dDiag() : null;
    const r = window.__l2dMemReq;
    return {
      text: t ? String(t.value || t.textContent || '').trim() : '',
      summary: d && d.mem ? String(d.mem.summary || '') : '',
      sys: r ? String(r.sys || '') : ''
    };
  });
  check(mem.text.indexOf('猫') >= 0, '整理记忆后摘要写入面板',
    mem.text.slice(0, 28) || '没有摘要文本');
  check(mem.summary.indexOf('猫') >= 0, '整理记忆写入 diag.mem.summary',
    mem.summary.slice(0, 28) || 'summary 为空');
  check(mem.sys.indexOf('记忆') >= 0, '整理记忆走 llmStreamRequest 且 system 含「记忆」',
    mem.sys ? 'system ' + mem.sys.length + ' 字' : '没有捕获摘要请求');

  /* 记忆注入下一次对话 */
  await page.click('#live2dWin [data-tab="chat"]');
  await page.waitForTimeout(180);
  await page.evaluate(() => { window.__l2dReq = null; });
  await page.fill('#live2dWin #l2dInput', '还记得我吗');
  await page.press('#live2dWin #l2dInput', 'Enter');
  await page.waitForTimeout(650);
  const nextSys = await page.evaluate(() => (window.__l2dReq ? String(window.__l2dReq.sys || '') : ''));
  check(nextSys.indexOf('猫') >= 0, '整理后的记忆注入下一次对话 system',
    nextSys ? (nextSys.indexOf('猫') >= 0 ? '已注入' : '未注入') : '没有捕获对话请求');

  /* 导出 Markdown */
  const exp = await page.evaluate(() => {
    const txt = window.__l2dExportText ? String(window.__l2dExportText() || '') : '';
    const d = window.__l2dDiag ? window.__l2dDiag() : null;
    return { txt: txt, n: d ? d.msgs : -1 };
  });
  const expCount = exp.txt.match(/共\s*(\d+)\s*条/);
  check(!!exp.txt && exp.txt.indexOf('今天有点累') >= 0 && !!expCount,
    '__l2dExportText 生成的 Markdown 含原话与「共 N 条」',
    exp.txt ? '共 ' + (expCount ? expCount[1] : '?') + ' 条 / diag ' + exp.n : '没有返回文本');

  /* 快捷话题：点一下等价于把按钮文案发出去 */
  const quickTxt = await page.evaluate(() => {
    const b = document.querySelector('#live2dWin #l2dQuick button[data-quick]');
    /* 按钮上显示的是短标签，真正发出去的是 data-quick 文案 */
    return b ? b.getAttribute('data-quick') : '';
  });
  await page.click('#live2dWin #l2dQuick button[data-quick]');
  await page.waitForTimeout(650);
  const quickSent = await page.evaluate((txt) => {
    const list = [...document.querySelectorAll('#live2dWin .l2d-msg.u .l2d-bubble-txt')];
    return list.some((n) => n.textContent.trim() === txt);
  }, quickTxt);
  check(!!quickTxt && quickSent, '点快捷话题等价于发送该文案', quickTxt || '没有快捷话题按钮');

  /* 清空记忆：文案回到占位，diag 归零 */
  await page.click('#live2dWin [data-tab="persona"]');
  await page.waitForTimeout(180);
  await page.click('#live2dWin #l2dMemClear');
  await page.waitForTimeout(280);
  const memCleared = await page.evaluate(() => {
    const t = document.getElementById('l2dMemText');
    const d = window.__l2dDiag ? window.__l2dDiag() : null;
    return {
      text: t ? String(t.value || t.textContent || '').trim() : '',
      summary: d && d.mem ? String(d.mem.summary || '') : null
    };
  });
  check(memCleared.text === '还没有整理过记忆。' && memCleared.summary === '',
    '清空记忆后文案与 diag 归零',
    memCleared.text + ' / summary=' + JSON.stringify(memCleared.summary));

  /* 清空对话 */
  await page.click('#live2dWin [data-tab="chat"]');
  await page.click('#live2dWin #l2dClear');
  await page.waitForTimeout(220);
  check(await page.evaluate(() => document.querySelectorAll('#live2dWin .l2d-msg').length === 0),
    '清空对话后气泡全部移除');
  check(await visible(page, '#live2dWin .l2d-welcome'), '清空后回到欢迎引导');

  /* ⑧ 关窗再开：mount 幂等，canvas 与模型实例都不重建 */
  await page.evaluate(() => {
    window.__l2dLogNode = document.querySelector('#live2dWin #l2dLog');
    window.__l2dCanvasNode = document.querySelector('#l2dCanvas canvas');
    deskCloseWin(document.getElementById('live2dWin'));
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => window.openDeskApp('live2d'));
  await page.waitForTimeout(700);
  check(await visible(page, '#live2dWin'), '关窗后能再次打开');
  check(await page.evaluate(() => window.__l2dLogNode === document.querySelector('#live2dWin #l2dLog')),
    '再次打开复用原 DOM（mount 幂等）');
  check(await page.evaluate(() => window.__l2dCanvasNode === document.querySelector('#l2dCanvas canvas')),
    '皮套 canvas 没有被重建');
  check(await page.evaluate(() => document.getElementById('l2dName').textContent.trim() === '小汐'),
    '再次打开保留角色设置');

  /* ⑨ 窄窗口无横向溢出 */
  await page.setViewportSize({ width: 900, height: 760 });
  await page.waitForTimeout(620);
  const overflow = await page.evaluate(() => {
    const side = document.querySelector('#live2dWin .l2d-side');
    const app = document.querySelector('#live2dWin .l2d-app');
    const c = document.querySelector('#l2dCanvas canvas');
    return {
      side: side.scrollWidth - side.clientWidth,
      app: app.scrollWidth - app.clientWidth,
      height: document.querySelector('#live2dWin .l2d-stage').getBoundingClientRect().height,
      cw: c ? c.clientWidth : 0
    };
  });
  check(overflow.side <= 1 && overflow.app <= 1, '窄窗口下侧栏与 App 无横向溢出',
    'side +' + overflow.side + ' / app +' + overflow.app);
  check(overflow.height > 200 && overflow.cw > 100, '窄窗口下舞台与 canvas 仍保留尺寸',
    Math.round(overflow.height) + 'px / canvas ' + overflow.cw + 'px');

  /* 窄窗里气泡退化成底部浮层，但也必须留在舞台内 */
  await page.click('#live2dWin [data-act="greet"]');
  await page.waitForTimeout(380);
  const tightSay = await page.evaluate(() => {
    const el = document.getElementById('l2dSay');
    const box = el ? el.getBoundingClientRect() : null;
    const st = document.getElementById('l2dStage').getBoundingClientRect();
    const hud = document.querySelector('#live2dWin .l2d-hud').getBoundingClientRect();
    return {
      hidden: !el || el.hidden,
      tight: !!el && el.classList.contains('is-tight'),
      inside: !!box && box.top >= st.top - 1 && box.bottom <= st.bottom + 1,
      clearHud: !!box && box.top >= hud.bottom - 1,
      top: box ? Math.round(box.top - st.top) : -1
    };
  });
  check(!tightSay.hidden && tightSay.inside && tightSay.clearHud, '窄窗口下气泡不压名牌、不出舞台',
    (tightSay.tight ? '底部浮层' : '贴头顶') + ' / top ' + tightSay.top);
  await run.shot(page, 'live2d-say-narrow.png');

  await run.shot(page, 'live2d-window.png');

  await browser.close();
  check(errors.length === 0, '全程无 pageerror / console error', errors.join(' | '));

  run.finish(errors);
  console.log('\n' + (fails ? '❌ ' + fails + ' 项未通过' : '✅ 全部通过') + ' · 运行目录 ' + run.dir);
  process.exit(fails ? 1 : 0);
})().catch(async (err) => {
  console.error('探针异常：', err && err.stack || err);
  try { run.finish([err]); } catch (e) { /* 忽略 */ }
  process.exit(1);
});
