/* 体检：对话内生图（文生图 / 图生图）
 * 用法：node tools/chat-image.js
 *
 * 不碰真实网络：把 /v1/chat/completions 与 /images/* 用 route 拦下来，
 * 返回固定的 SSE 与图片，所以「改写提示词 → 出图 → 卡片」整条链路都能跑通。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const REFINED = '一只穿黑色风衣的赛博朋克猫站在雨夜街头，霓虹灯反射在积水里，电影级特写，冷蓝配洋红';

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));

  // 记录请求：断言「文生图打到 generations、图生图打到 edits」
  const seen = { gen: 0, edit: 0, lastGenBody: null, lastEditForm: null };
  let slowImage = 0;          // 毫秒；>0 时图片接口故意慢，用来测「停止」

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': '*',
    'content-type': 'application/json'
  };

  await page.route(/127\.0\.0\.1:9\//, async route => {
    const req = route.request();
    const url = req.url();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });

    if (/\/images\/(generations|edits)/.test(url)) {
      if (/edits/.test(url)) { seen.edit++; seen.lastEditForm = (req.postData() || '').slice(0, 200); }
      else { seen.gen++; try { seen.lastGenBody = JSON.parse(req.postData() || '{}'); } catch (e) { } }
      if (slowImage) await sleep(slowImage);
      return route.fulfill({
        status: 200, headers: cors,
        body: JSON.stringify({ data: [{ url: IMG }] })
      });
    }
    return route.fulfill({ status: 200, headers: cors, body: '{}' });
  });

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  // 关掉中转（否则请求会打到 127.0.0.1:8787，route 拦的是 :9）
  await page.evaluate(() => {
    const r = document.getElementById('relayOn');
    if (r) r.checked = false;
    document.getElementById('llmBaseUrl').value = 'http://127.0.0.1:9/v1';
    document.getElementById('llmKey').value = 'sk-test';
    document.getElementById('llmModel').value = 'test-model';
    document.getElementById('imgBaseUrl').value = '';
    document.getElementById('imgKey').value = '';
    document.getElementById('imgModel').value = '';
  });

  /* 语言模型整段换成假的：这个测试要验的是「路由 + 生图」，不是 SSE 解析
     （SSE 由 ai-thinking / desk-chat 等脚本覆盖）。这样也不再受本机
     Ollama 是否在跑、模型清单什么时候刷新完的影响。 */
  await page.evaluate(() => {
    window.__fake = { refine: 0, chat: 0, next: '', refined: '一只穿黑色风衣的赛博朋克猫站在雨夜街头，霓虹灯反射在积水里，电影级特写，冷蓝配洋红' };
    window.llmStreamRequest = async function (sys, messages, onDelta) {
      const isRefine = /提示词工程师/.test(String(sys || ''));
      if (isRefine) window.__fake.refine++; else window.__fake.chat++;
      const text = isRefine ? window.__fake.refined : (window.__fake.next || '好的，这是回答。');
      await new Promise(r => setTimeout(r, 30));
      if (onDelta) onDelta(text, text, { phase: 'answer' });
      return text;
    };
    window.llmChatMessagesStream = function (sys, messages, onDelta, opts) {
      return window.llmStreamRequest(sys, messages, onDelta, opts);
    };
  });

  /* ---------------- 1. 意图判断 ---------------- */
  console.log('\n=== 1. 意图判断（要图 / 聊天） ===');
  const intent = await page.evaluate(() => {
    const cases = [
      ['画一只在雨里的猫', true],
      ['帮我生成一张赛博朋克风格的城市夜景', true],
      ['给我画个LOGO，简约一点', true],
      ['来一张海边日落壁纸', true],
      ['把这张图改成水彩风格', true],
      ['背景换成雪山', false],
      ['怎么生成图片？', false],
      ['生成一张流程图', false],
      ['这个工作流有几个节点', false],
      ['我想了解扩散模型的原理', false],
      ['你支持图生图吗', false]
    ];
    return cases.map(([t, want]) => {
      const r = window.deskImage.intent(t, false);
      return { t, want, got: r.on, why: r.why };
    });
  });
  intent.forEach(c => check(c.got === c.want, '「' + c.t + '」→ ' + (c.want ? '出图' : '聊天'), c.why));

  /* 还得判「这张是新画，还是改上一张」——判错就会把上一张当参考图，
     新图被旧图污染（画面里混进上一张的主体，看着就像「图和提示词不对」）。
     裸「它」曾经被当成指代：一句「阳光洒在它身上」就把新画的猫做成图生图。 */
  const edits = await page.evaluate(() => {
    const cases = [
      ['画一只猫趴在地上，阳光透过树叶洒在它身上', false],
      ['画一个女孩，她在跳舞', false],
      ['把这张图改成水彩风格', true],
      ['把它改成水彩', true],
      ['给它加一顶帽子', true],
      ['再画一张，同一个风格', true]
    ];
    return cases.map(([t, want]) => ({ t, want, got: !!window.deskImage.intent(t, false).edit }));
  });
  edits.forEach(c => check(c.got === c.want,
    (c.want ? '改上一张' : '新画一张') + '：「' + c.t.slice(0, 16) + '…」', 'edit=' + c.got));

  console.log('\n=== 2. 模型指令解析（{"type":"image"}） ===');
  const seg = await page.evaluate(() => {
    const one = window.deskImage.segment('好的，我来画一只猫。\n{"type":"image","prompt":"一只橘猫在窗台上晒太阳","mode":"text"}');
    const two = window.deskImage.segment('{"type":"image","prompt":"改成水彩","mode":"image"}');
    const three = window.deskImage.segment('普通回答，没有指令');
    const live1 = window.deskImage.live('好的，我来画一只猫。\n{"type":"image","prom');
    const live2 = window.deskImage.live('好的，我来画一只猫。\n{"ty');
    return { one, two, three, live1, live2 };
  });
  check(seg.one.direct && seg.one.direct.prompt === '一只橘猫在窗台上晒太阳', '带说明的指令：prompt 解出来', seg.one.direct && seg.one.direct.prompt);
  check(seg.one.text === '好的，我来画一只猫。', '指令从正文里摘干净', seg.one.text);
  check(seg.two.direct && seg.two.direct.mode === 'image', 'mode=image 能识别为图生图', JSON.stringify(seg.two.direct));
  check(seg.two.text === '', '整条只有指令时正文为空');
  check(!seg.three.direct && seg.three.text === '普通回答，没有指令', '没有指令时原样返回');
  check(!/"type"/.test(seg.live1) && !/"type"/.test(seg.live2), '流式半截指令不外泄', JSON.stringify(seg.live2));

  /* 模型把同一条指令写两遍（抄一遍示例再写一遍真的）——只摘最后一条会把前一条留在正文里，
     用户看到的就是一行裸 JSON。这条以前真的漏在界面上。 */
  const dup = await page.evaluate(() => {
    const J = '{"type":"image","prompt":"一只猫站在窗户边","mode":"text"}';
    return {
      two: window.deskImage.segment(J + '\n' + J),
      fenced: window.deskImage.segment('```json\n' + J + '\n```\n' + J),
      cut: window.deskImage.segment('{"type":"image","prompt":"一只猫站'),
      live: window.deskImage.live(J + '\n' + J)
    };
  });
  check(dup.two.text === '' && dup.two.direct.prompt === '一只猫站在窗户边', '指令重复两遍：正文摘干净，提示词照取', JSON.stringify(dup.two).slice(0, 80));
  check(dup.fenced.text === '', '围栏里的那份也一起摘掉', JSON.stringify(dup.fenced.text));
  check(!/"type"/.test(dup.live), '流式期间重复指令也不外泄', JSON.stringify(dup.live));
  check(dup.cut.direct === null && !/"type"/.test(dup.cut.text || ''), '被截断的指令不摊给用户看', (dup.cut.text || '').slice(0, 30));

  /* ---------------- 3. 模式按钮 ---------------- */
  console.log('\n=== 3. 生图模式按钮（自动 / 生图 / 对话） ===');
  const btn0 = await page.evaluate(() => {
    const b = document.getElementById('deskAiImage');
    return b ? { mode: b.dataset.mode, txt: document.getElementById('deskAiModeTxt').textContent, title: b.title } : null;
  });
  check(!!btn0, '输入条上有生图模式按钮');
  check(btn0 && btn0.mode === 'auto' && btn0.txt === '自动', '默认是「自动」', btn0 && btn0.txt);
  const cycle = [];
  for (let i = 0; i < 3; i++) {
    await page.click('#deskAiImage');
    await sleep(90);
    cycle.push(await page.evaluate(() => ({
      mode: document.getElementById('deskAiImage').dataset.mode,
      txt: document.getElementById('deskAiModeTxt').textContent,
      store: localStorage.getItem('hf_desk_imgmode'),
      ph: document.getElementById('deskAiText').placeholder
    })));
  }
  check(cycle[0].mode === 'image' && cycle[0].txt === '生图', '点一下 → 总是生图', JSON.stringify(cycle[0]));
  check(cycle[0].ph.indexOf('描述你想要的画面') === 0, '生图模式下输入框提示改成「描述画面」', cycle[0].ph);
  check(cycle[1].mode === 'chat' && cycle[1].txt === '对话', '再点 → 仅对话', JSON.stringify(cycle[1]));
  check(cycle[2].mode === 'auto' && cycle[2].txt === '自动', '第三下回到自动', JSON.stringify(cycle[2]));
  check(cycle[2].store === 'auto', '模式写进 localStorage', cycle[2].store);

  /* ---------------- 4. 文生图 ---------------- */
  console.log('\n=== 4. 文生图：一句话 → 提示词 → 出图 ===');
  await page.fill('#deskAiText', '画一只在雨里的赛博朋克猫');
  await page.click('#deskAiSend');
  let ok = true;
  try {
    await page.waitForFunction(() => !!document.querySelector('.dgen.is-done .dgen-img'), null, { timeout: 15000 });
  } catch (e) { ok = false; }
  const gen = await page.evaluate(() => {
    const card = document.querySelector('.dgen.is-done');
    if (!card) return null;
    const img = card.querySelector('.dgen-img');
    return {
      src: img ? img.getAttribute('src').slice(0, 22) : '',
      w: img ? Math.round(img.getBoundingClientRect().width) : 0,
      phase: (card.querySelector('.dgen-phase') || {}).textContent,
      prompt: (card.querySelector('.dgen-prompt') || {}).textContent,
      acts: [...card.querySelectorAll('.dgen-act')].map(b => b.textContent),
      inPage2: !!document.querySelector('#chatWin .dgen'),
      userText: (document.querySelector('.dchat-msg.user:last-of-type .dchat-text') || {}).textContent || '',
      bodyTransparent: (function () {
        const b = card.closest('.dchat-body');
        return b ? getComputedStyle(b).backgroundColor : '';
      })()
    };
  });
  check(ok && !!gen, '出图完成，卡片出现在对话页');
  check(gen && gen.src.indexOf('data:image/png') === 0, '图片渲染进气泡', gen && gen.src);
  check(gen && gen.w > 100, '图片有实际宽度', gen && String(gen.w) + 'px');
  check(gen && /已出图/.test(gen.phase), '状态行显示已出图与耗时', gen && gen.phase);
  check(gen && gen.prompt.indexOf('赛博朋克') >= 0, '卡片里能读回改写后的提示词', gen && gen.prompt.slice(0, 28));
  const refineN = await page.evaluate(() => window.__fake.refine);
  check(refineN === 1, '先调了一次提示词改写', 'refine=' + refineN);
  check(seen.gen === 1, '文生图打到 /images/generations', 'gen=' + seen.gen);
  check(gen && gen.acts.length === 5, '动作按钮齐全（保存/下载/参考图/再生成/复制）', gen && gen.acts.join(' '));
  check(gen && gen.bodyTransparent === 'rgba(0, 0, 0, 0)', '纯图消息不再套灰气泡', gen && gen.bodyTransparent);
  const lastImg = await page.evaluate(() => window.deskChat.lastImage());
  check(!!lastImg, '最近一张图记下来了（供「把刚才那张…」用）');

  /* ---------------- 5. 图生图 ---------------- */
  console.log('\n=== 5. 图生图：用作参考图 → 改这一张 ===');
  await page.evaluate(() => {
    const card = document.querySelector('.dgen.is-done');
    card.querySelector('.dgen-act[data-act="ref"]').click();
  });
  await sleep(120);
  const attState = await page.evaluate(() => ({
    chips: document.querySelectorAll('#deskAiAtts .dai-chip').length,
    n: window.deskChat.atts().length
  }));
  check(attState.n === 1 && attState.chips === 1, '「用作参考图」把图放进了附件区', JSON.stringify(attState));
  await page.fill('#deskAiText', '把背景换成海边日落');
  await page.click('#deskAiSend');
  ok = true;
  try {
    await page.waitForFunction(() => document.querySelectorAll('.dgen.is-done').length === 2, null, { timeout: 15000 });
  } catch (e) { ok = false; }
  const i2i = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.dgen.is-done')];
    const card = cards[cards.length - 1];
    const ref = card.querySelector('.dgen-ref');
    return {
      n: cards.length,
      hasRef: !!ref,
      refText: ref ? ref.textContent : '',
      refSrc: ref ? ref.querySelector('img').getAttribute('src').slice(0, 22) : ''
    };
  });
  check(ok && i2i.n === 2, '第二张图生成完成', 'cards=' + i2i.n);
  check(i2i.hasRef && /图生图/.test(i2i.refText), '卡片标出「参考图 · 图生图」', i2i.refText);
  check(i2i.refSrc.indexOf('data:image') === 0, '参考图缩略图显示出来', i2i.refSrc);
  check(seen.edit === 1, '图生图打到 /images/edits', 'edit=' + seen.edit);

  /* ---------------- 6. 停止 ---------------- */
  console.log('\n=== 6. 生成中可以停止 ===');
  slowImage = 2500;
  await page.fill('#deskAiText', '画一座漂浮在云上的城堡');
  await page.click('#deskAiSend');
  let sawStop = false;
  try {
    await page.waitForFunction(() => !!document.querySelector('.dgen.is-gen .dgen-act[data-act="stop"]'), null, { timeout: 8000 });
    sawStop = true;
  } catch (e) { }
  const midCard = await page.evaluate(() => {
    const c = document.querySelector('.dgen.is-gen');
    return c ? {
      phase: c.querySelector('.dgen-phase').textContent,
      skel: !!c.querySelector('.dgen-skel'),
      cardPhase: c.dataset.phase
    } : null;
  });
  check(sawStop, '生成中显示「停止」按钮');
  check(midCard && midCard.skel && midCard.cardPhase === 'gen', '生成中显示占位骨架', midCard && midCard.phase);
  if (sawStop) await page.click('.dgen.is-gen .dgen-act[data-act="stop"]');
  await sleep(400);
  const cancelled = await page.evaluate(() => {
    const c = document.querySelector('.dgen.is-cancel');
    return {
      cancel: !!c,
      phase: c ? c.querySelector('.dgen-phase').textContent : '',
      sendDisabled: document.getElementById('deskAiSend').disabled,
      busyMsgs: document.querySelectorAll('.dgen.is-gen').length
    };
  });
  check(cancelled.cancel && cancelled.phase === '已停止', '点停止后卡片变「已停止」', cancelled.phase);
  check(!cancelled.sendDisabled, '停止后发送按钮解锁');
  check(cancelled.busyMsgs === 0, '没有卡在生成中的卡片');
  await sleep(2600);   // 让被放弃的那次请求返回，确认它不会把「已停止」覆盖成图片
  const notOverwritten = await page.evaluate(() => !document.querySelector('.dgen.is-cancel .dgen-img'));
  check(notOverwritten, '被取消的结果回来后不会覆盖已停止的卡片');
  slowImage = 0;

  /* ---------------- 7. 误触与模式 ---------------- */
  console.log('\n=== 7. 不该出图的句子不出图 ===');
  const before = await page.evaluate(() => document.querySelectorAll('.dgen').length);
  await page.fill('#deskAiText', '怎么生成图片？');
  await page.click('#deskAiSend');
  await sleep(1200);
  const after = await page.evaluate(() => ({
    n: document.querySelectorAll('.dgen').length,
    reply: (document.querySelector('.dchat-msg.ai:last-of-type .dchat-text') || {}).textContent || ''
  }));
  check(after.n === before, '问句走聊天，不生成图片', 'dgen ' + before + ' → ' + after.n);
  check(/好的/.test(after.reply), '聊天有正常回复', after.reply.slice(0, 20));

  await page.evaluate(() => window.deskChat.imgMode('chat'));
  await sleep(80);
  await page.fill('#deskAiText', '画一只猫');
  await page.click('#deskAiSend');
  await sleep(1200);
  const chatLock = await page.evaluate(() => ({
    n: document.querySelectorAll('.dgen').length,
    txt: (document.querySelector('.dchat-msg.ai:last-of-type .dchat-text') || {}).textContent || ''
  }));
  check(chatLock.n === before, '「仅对话」模式下画也不出图（不误扣额度）', 'dgen=' + chatLock.n);
  check(/好的/.test(chatLock.txt), '仍然正常聊天回答', chatLock.txt.slice(0, 16));

  /* ---------------- 8. 模型主动要出图 ---------------- */
  console.log('\n=== 8. 模型自己提出出图（指令解析 → 自动生成） ===');
  await page.evaluate(() => window.deskChat.imgMode('auto'));
  await page.evaluate(() => {
    window.__fake.next = '我建议做成霓虹紫的赛博朋克夜景。\n{"type":"image","prompt":"霓虹紫的赛博朋克夜景，湿滑街道，反光招牌","mode":"text"}';
  });
  await page.fill('#deskAiText', '来点赛博朋克的感觉吧');
  await page.click('#deskAiSend');
  ok = true;
  try {
    await page.waitForFunction(() => document.querySelectorAll('.dgen.is-done').length >= 3, null, { timeout: 15000 });
  } catch (e) { ok = false; }
  const fromChat = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.dgen.is-done')];
    const c = cards[cards.length - 1];
    return {
      n: cards.length,
      prompt: (c.querySelector('.dgen-prompt') || {}).textContent,
      txt: (c.closest('.dchat-body').querySelector('.dchat-text') || {}).textContent,
      leaked: !!document.querySelector('.dchat-log').textContent.match(/"type"\s*:\s*"image"/)
    };
  });
  check(ok, '模型给出指令后自动出图', 'cards=' + fromChat.n);
  check(fromChat.prompt.indexOf('霓虹紫') >= 0, '用的是模型写的提示词', fromChat.prompt.slice(0, 24));
  check(!fromChat.leaked, '页面上看不到裸 JSON 指令');
  check(/赛博朋克夜景/.test(fromChat.txt || ''), '模型那句说明保留在气泡里', (fromChat.txt || '').slice(0, 20));

  /* 真实翻车场景：本地小模型把整条指令重复写了两遍，界面上于是出现一行裸 JSON。
     这里走完整链路（流式 → 解析 → 出图 → 渲染）再验一遍。 */
  console.log('\n=== 8b. 指令重复两遍的完整链路 ===');
  await page.evaluate(() => window.deskChat.imgMode('auto'));
  const hadCards = await page.evaluate(() => document.querySelectorAll('.dgen.is-done').length);
  await page.evaluate(() => {
    const J = '{"type":"image","prompt":"窗边的猫，午后阳光，写实摄影","mode":"text"}';
    window.__fake.next = J + '\n' + J;
  });
  await page.fill('#deskAiText', '今天状态不错');
  await page.click('#deskAiSend');
  let dupOk = true;
  try {
    await page.waitForFunction(n => document.querySelectorAll('.dgen.is-done').length > n, hadCards, { timeout: 15000 });
  } catch (e) { dupOk = false; }
  const dupFlow = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.dgen.is-done')];
    const c = cards[cards.length - 1];
    const body = c && c.closest('.dchat-body');
    return {
      n: cards.length,
      prompt: (c && c.querySelector('.dgen-prompt') || {}).textContent,
      txt: (body && body.querySelector('.dchat-text') || {}).textContent || '',
      leaked: /"type"\s*:\s*"image"/.test(document.getElementById('deskChatLog').textContent)
    };
  });
  check(dupOk, '重复指令照样能出图', 'cards=' + dupFlow.n);
  check(!dupFlow.leaked, '整块日志里都没有裸 JSON', dupFlow.leaked ? '仍然漏了' : '');
  check(dupFlow.txt === '' || !/"type"/.test(dupFlow.txt), '气泡正文不含指令', JSON.stringify(dupFlow.txt).slice(0, 40));
  check(dupFlow.prompt.indexOf('窗边的猫') >= 0, '卡片用的是提示词本身', (dupFlow.prompt || '').slice(0, 20));

  /* ---------------- 9. 头部来源 + 大图 ---------------- */  console.log('\n=== 9. 来源标识与看大图 ===');
  const chip = await page.evaluate(() => {
    const b = document.getElementById('deskChatImg');
    return { text: b.textContent, title: b.title, off: b.classList.contains('off') };
  });
  check(/生图 · /.test(chip.text), '页头标出当前的出图来源', chip.text);
  await page.evaluate(() => document.querySelector('.dgen.is-done .dgen-img').click());
  await sleep(220);
  const viewer = await page.evaluate(() => {
    const v = document.getElementById('dgenView');
    if (!v) return null;
    const img = v.querySelector('img');
    const r = img.getBoundingClientRect();
    return { open: !v.classList.contains('hidden'), w: Math.round(r.width), z: getComputedStyle(v).zIndex };
  });
  check(!!viewer && viewer.open && viewer.w > 0, '点图片打开大图预览', viewer && viewer.w + 'px z=' + viewer.z);
  await page.keyboard.press('Escape');
  await sleep(180);
  const closed = await page.evaluate(() => document.getElementById('dgenView').classList.contains('hidden'));
  check(closed, 'Esc 关闭大图');

  /* ---------------- 10. 引擎明明在跑，却因为旧快照被拦 ----------------
   * 现场：开机自动启动那一百秒里探到 comfy.ok=false，引擎起来后没人再探；
   * 于是卡片写着「运行中」，一出图却弹「引擎没在运行」，还把用户拽去启动引擎。
   * 修法：出图前只在「缓存说不可用」时才真探一次。 */
  console.log('\n=== 10. 就绪判断不能信旧快照 ===');
  const stale = await page.evaluate(async () => {
    window.__rt = { refresh: 0 };
    window.__realRt = window.rtRefresh;
    rtHealth = { ok: false, ollama: { ok: false }, comfy: { ok: false } };   // 旧快照：当时引擎还没起
    try { localStorage.setItem('mc_scope_image', 'local'); } catch (e) { }
    // 真探测现在应该拿到「在跑」
    window.rtRefresh = async function () {
      window.__rt.refresh++;
      rtHealth = { ok: true, ollama: { ok: true }, comfy: { ok: true, status: 200 } };
      return rtHealth;
    };
    const before = window.deskImage.source();
    const after = await window.deskImage.check();
    const again = await window.deskImage.check();   // 第二次走快路径，不该再探
    return {
      beforeReady: before.ready,
      afterReady: after.ready,
      againReady: again.ready,
      probes: window.__rt.refresh,
      hint: before.hint
    };
  });
  check(stale.beforeReady === false, '缓存里的旧快照确实被判成「不可用」');
  check(/没在运行/.test(stale.hint || ''), '旧快照带着那句误导人的提示', (stale.hint || '').slice(0, 20));
  check(stale.afterReady === true, '校准后认出引擎其实在跑');
  check(stale.probes === 1, '只真探一次（第二次走缓存，不多等）', '探了 ' + stale.probes + ' 次');

  /* 端到端：这一条走完整 send()，确认不会再弹「没在运行」 */
  const staleFlow = await page.evaluate(async () => {
    window.__toasts = [];
    const realToast = window.deskToast;
    window.deskToast = function (m) { window.__toasts.push(String(m)); };
    const realImg = window.wfImage;
    window.wfImage = async function () { return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='; };
    try {
      rtHealth = { ok: false, ollama: { ok: false }, comfy: { ok: false } };  // 又回到旧快照
      window.deskChat.imgMode('auto');
      const before = document.querySelectorAll('.dchat-msg.ai').length;
      const input = document.getElementById('deskAiText');
      input.value = '画一只在雨里的小猫';
      document.getElementById('deskAiSend').click();
      await new Promise(r => setTimeout(r, 900));
      const cards = [...document.querySelectorAll('.dgen')];
      const last = cards[cards.length - 1];
      return {
        toasts: window.__toasts.slice(),
        phase: last ? last.dataset.phase : '',
        grew: document.querySelectorAll('.dchat-msg.ai').length > before
      };
    } finally {
      window.deskToast = realToast;
      window.wfImage = realImg;
      window.rtRefresh = window.__realRt;
    }
  });
  check(!staleFlow.toasts.some(t => /没在运行/.test(t)), '不再弹「引擎没在运行」', (staleFlow.toasts || []).join(' | ').slice(0, 60));
  check(staleFlow.phase === 'done', '照常出图', 'phase=' + staleFlow.phase);

  // 复位：后面没有用例了，但别把 localStorage 留给下一次运行
  await page.evaluate(() => {
    try {
      localStorage.removeItem('mc_scope_image');
      window.deskChat.imgMode('auto');
    } catch (e) { }
  });

  /* ---------------- 11. 本机引擎地址要自动搬到桥上 ----------------
   * 用户把语言模型填成 http://127.0.0.1:11434/v1 是最自然的写法。
   * 但页面直连它必被 CORS 拦（origin 'null'），实测连 /api/tags 都是 Failed to fetch，
   * 表现就是「本地对话用不了 / 中文提示词翻不出来（于是出图和描述无关）」。
   * 桥 8794 就是干这个的，地址必须透明地搬过去。 */
  console.log('\n=== 11. 本机引擎地址自动走桥 ===');
  const bridgeCase = await page.evaluate(() => {
    const cases = {
      ollamaChat: bridgedEngineUrl('http://127.0.0.1:11434/v1/chat/completions'),
      ollamaTags: bridgedEngineUrl('http://localhost:11434/api/tags'),
      comfy: bridgedEngineUrl('http://127.0.0.1:8188/view?filename=a.png'),
      already: bridgedEngineUrl('http://127.0.0.1:8794/ollama/api/tags'),
      cloud: bridgedEngineUrl('https://api.openai.com/v1/chat/completions'),
      empty: bridgedEngineUrl('')
    };
    const req = apiRequest('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST' });
    return { cases, reqUrl: req.url };
  });
  check(bridgeCase.cases.ollamaChat === 'http://127.0.0.1:8794/ollama/v1/chat/completions',
    'Ollama 直连 → 走桥的 /ollama', bridgeCase.cases.ollamaChat);
  check(bridgeCase.cases.ollamaTags === 'http://127.0.0.1:8794/ollama/api/tags',
    'localhost 写法同样搬运', bridgeCase.cases.ollamaTags);
  check(bridgeCase.cases.comfy === 'http://127.0.0.1:8794/comfy/view?filename=a.png',
    'ComfyUI 直连 → 走桥的 /comfy（查询串不能丢）', bridgeCase.cases.comfy);
  check(bridgeCase.cases.already === '', '已经是桥地址就不动');
  check(bridgeCase.cases.cloud === '', '公网地址不动');
  check(bridgeCase.cases.empty === '', '空地址不动');
  check(bridgeCase.reqUrl === 'http://127.0.0.1:8794/ollama/v1/chat/completions',
    '真正发请求时用的是搬过去的地址', bridgeCase.reqUrl);

  /* ---------------- 12. 图生图：不改写提示词 + 重绘强度可调 ----------------
   * 现场：用户说「把背景换成海边日落」，出来的图主体挪了位置、姿态也变了。
   * 原因之一是图生图也走了「扩写画面描述」的改写——那等于扔掉参考图重新描述一张新图。 */
  console.log('\n=== 12. 图生图：不改写、强度可调 ===');
  const i2iLocal = await page.evaluate(async () => {
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    window.__i2i = { calls: [] };
    window.__realSource = window.deskImage.source;
    window.__realGenerate = window.deskImage.generate;
    window.deskImage.source = () => ({ kind: 'local', label: '本地 · test.safetensors', ready: true, where: 'comfy', hint: '' });
    window.deskImage.generate = async o => {
      window.__i2i.calls.push({ prompt: o.prompt, ref: !!o.ref, denoise: Number(o.denoise) || 0 });
      return { src: PNG, ms: 10 };
    };
    window.__fake.refine = 0;
    window.deskChat.setLastImage(PNG);
    window.deskChat.imgMode('auto');
    window.deskChat.refine(true);
    const before = document.querySelectorAll('.dgen').length;
    document.getElementById('deskAiText').value = '把背景换成海边日落，猫和它的姿态保持不变';
    document.getElementById('deskAiSend').click();
    await new Promise(r => setTimeout(r, 700));
    const cards = [...document.querySelectorAll('.dgen')];
    const card = cards[cards.length - 1];
    const btn = card && card.querySelector('[data-act="denoise"]');
    return {
      refine: window.__fake.refine,
      calls: window.__i2i.calls.slice(),
      grew: cards.length > before,
      btn: !!btn,
      btnText: btn ? btn.textContent : '',
      mid: card ? card.dataset.mid : ''
    };
  });
  check(i2iLocal.grew, '图生图出新卡片');
  check(i2iLocal.refine === 0, '图生图不走提示词改写（改写会把参考图的构图换掉）', 'refine=' + i2iLocal.refine);
  check(i2iLocal.calls.length === 1 && i2iLocal.calls[0].ref, '确实带着参考图去生成');
  check(i2iLocal.calls[0].denoise === 0, '默认「自动」：前端不写死强度，交给 provider 按意图定');
  check(i2iLocal.btn, '本地图生图卡片上有「重绘强度」按钮');
  check(/重绘 \d+%/.test(i2iLocal.btnText), '按钮上写具体百分比（只写「自动」等于没说）', i2iLocal.btnText);

  await page.evaluate(mid => {
    const card = document.querySelector('.dgen[data-mid="' + mid + '"]');
    const b = card && card.querySelector('[data-act="denoise"]');
    if (b) b.click();
  }, i2iLocal.mid);
  await sleep(700);
  const i2iAfter = await page.evaluate(() => ({ calls: window.__i2i.calls.slice() }));
  check(i2iAfter.calls.length === 2, '点一下会按新强度重画一张', 'calls=' + i2iAfter.calls.length);
  check(i2iAfter.calls[1] && i2iAfter.calls[1].denoise === 0.35,
    '自动 → 轻改 35%', i2iAfter.calls[1] && String(i2iAfter.calls[1].denoise));

  await page.evaluate(() => {
    window.deskImage.source = window.__realSource;
    window.deskImage.generate = window.__realGenerate;
    window.deskChat.imgMode('auto');
    window.deskChat.refine(true);
  });

  check(errors.length === 0, '页面无 JS 异常', errors.join(' | ').slice(0, 300));

  await browser.close();
  console.log(fails === 0 ? '\n全部通过 ✅' : '\n失败 ' + fails + ' 项 ❌');
  process.exit(fails === 0 ? 0 : 1);
})();
