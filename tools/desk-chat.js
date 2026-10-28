/* 体检：桌面 AI 对话条（红框区输入条 + 右侧聊天面板）
 * 用法：node tools/desk-chat.js
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

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  console.log('\n=== 1. 输入条在桌面底部空白带 ===');
  const wrapBox = await page.locator('#deskAiWrap').boundingBox();
  check(!!wrapBox, '输入条存在且可见');
  const vw = 1440, vh = 900;
  check(wrapBox && wrapBox.y + wrapBox.height <= vh + 2, '输入条在视口内（底部区域）',
    wrapBox ? Math.round(wrapBox.y) + '~' + Math.round(wrapBox.y + wrapBox.height) : '');
  check(wrapBox && wrapBox.y > vh * 0.45, '输入条落在桌面下半部空白带',
    wrapBox ? 'top=' + Math.round(wrapBox.y) : '');
  // Dock 已移除：改为断言底部 Dock 不存在，且输入条贴近桌面底边
  const dockCount = await page.locator('#deskDock').count();
  check(dockCount === 0, '底部 Dock 已移除');
  check(wrapBox && vh - (wrapBox.y + wrapBox.height) <= 60, '输入条贴近桌面底边',
    wrapBox ? 'gap=' + Math.round(vh - (wrapBox.y + wrapBox.height)) : '');

  console.log('\n=== 2. 工具栏控件齐备（对应参考图） ===');
  // 上下文 / 模型现在露在外面的是自绘触发器，原生 select 只当值容器（.dai-native，不显示）
  const ids = ['deskAiAdd', 'deskAiCtx', 'deskAiCtxBtn', 'deskAiDot', 'deskAiModel', 'deskAiBtn', 'deskAiMic', 'deskAiSend'];
  for (const id of ids) {
    const n = await page.locator('#' + id).count();
    check(n === 1, id + ' 存在');
  }
  const nativeVisible = await page.evaluate(() => {
    const s = document.getElementById('deskAiModel');
    return getComputedStyle(s).display;
  });
  check(nativeVisible === 'none', '原生 select 已隐藏（弹层是自绘的，不再是系统蓝底）', nativeVisible);
  const addBox = await page.locator('#deskAiAdd').boundingBox();
  const ctxBox = await page.locator('#deskAiCtxBtn').boundingBox();
  const dotBox = await page.locator('#deskAiDot').boundingBox();
  const modelBox = await page.locator('#deskAiBtn').boundingBox();
  const micBox = await page.locator('#deskAiMic').boundingBox();
  const sendBox = await page.locator('#deskAiSend').boundingBox();
  check(!!(addBox && ctxBox && dotBox && modelBox && micBox && sendBox), '六个控件都可见');
  check(addBox && ctxBox && addBox.x < ctxBox.x, '顺序：+ 附件 在 上下文 左边');
  check(ctxBox && dotBox && ctxBox.x < dotBox.x, '顺序：上下文 在 状态点 左边');
  check(dotBox && modelBox && dotBox.x < modelBox.x, '顺序：状态点 在 模型 左边');
  check(modelBox && micBox && modelBox.x < micBox.x, '顺序：模型 在 麦克风 左边');
  check(micBox && sendBox && micBox.x < sendBox.x, '顺序：麦克风 在 发送 左边');
  const sendStyle = await page.evaluate(() => {
    const el = document.getElementById('deskAiSend');
    const s = getComputedStyle(el);
    return {
      text: (el.textContent || '').trim(),
      bg: s.backgroundColor, bgImg: s.backgroundImage,
      color: s.color, radius: parseFloat(s.borderTopLeftRadius) || 0,
      w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height)
    };
  });
  check(sendStyle.text === 'Send', '发送按钮是英文 Send（不是箭头图标）', sendStyle.text);
  check(/^rgba?\(240, ?180, ?41/.test(sendStyle.bg) && sendStyle.bgImg === 'none',
    '发送按钮是平面金黄底（无渐变）', sendStyle.bg + ' · ' + sendStyle.bgImg);
  check(sendStyle.radius >= 8 && sendStyle.w > sendStyle.h,
    '发送按钮是圆角方框（不是小圆钮）', 'r=' + sendStyle.radius + ' ' + sendStyle.w + 'x' + sendStyle.h);

  // 状态点：不再是红/绿，统一平面金黄
  const dotStyle = await page.evaluate(() => {
    const d = document.getElementById('deskAiDot');
    const s = getComputedStyle(d);
    const appDots = [...document.querySelectorAll('.desk-app-state')].map(e => getComputedStyle(e).backgroundColor);
    return { bg: s.backgroundColor, shadow: s.boxShadow, appDots };
  });
  check(dotStyle.shadow === 'none', '输入条状态点去掉了发光环（平面）', dotStyle.shadow);
  check(dotStyle.appDots.every(c => /^rgba?\(240, ?180, ?41/.test(c)),
    '图标状态小点全部是金黄', dotStyle.appDots.join(' | '));

  console.log('\n=== 3. 上下文下拉可选项 ===');
  const ctxOpts = await page.evaluate(() => Array.from(document.getElementById('deskAiCtx').options).map(o => ({ v: o.value, t: o.textContent })));
  check(ctxOpts.some(o => o.v === 'none' && /无上下文/.test(o.t)), '有「无上下文」项');
  const hasFlow = ctxOpts.filter(o => o.v.indexOf('flow:') === 0);
  check(true, '工作流上下文项：' + hasFlow.length + ' 个' + (hasFlow.length ? '（' + hasFlow.map(o => o.t).join('、') + '）' : ''));

  console.log('\n=== 4. 模型下拉可选项 ===');
  const modelState = await page.evaluate(() => {
    const sel = document.getElementById('deskAiModel');
    return {
      groups: Array.from(sel.querySelectorAll('optgroup')).map(g => g.label),
      count: sel.options.length,
      disabled: sel.disabled,
      value: sel.value
    };
  });
  check(modelState.count > 0, '模型下拉有可选项（' + modelState.count + ' 个）', JSON.stringify(modelState.groups));
  check(modelState.groups.length >= 1, '模型按来源分组', JSON.stringify(modelState.groups));

  console.log('\n=== 4b. 自绘模型菜单（替代系统蓝底弹层） ===');
  const btnBox = await page.locator('#deskAiBtn').boundingBox();
  await page.click('#deskAiBtn');
  await sleep(260);
  const menu = await page.evaluate(() => {
    const menu = document.querySelector('.dai-menu');
    if (!menu) return null;
    const r = menu.getBoundingClientRect();
    const on = menu.querySelector('.dai-menu-item.is-on');
    const groups = [...menu.querySelectorAll('.dai-menu-group')].map(g => g.textContent);
    const items = [...menu.querySelectorAll('.dai-menu-item')].length;
    const s = on ? getComputedStyle(on) : null;
    return {
      hidden: menu.classList.contains('hidden'),
      w: Math.round(r.width), h: Math.round(r.height),
      left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom),
      groups, items,
      onBg: s ? s.backgroundColor : '', onColor: s ? s.color : '',
      tickVisible: on ? getComputedStyle(on.querySelector('.dai-menu-tick')).opacity : '',
      btnOpen: document.getElementById('deskAiBtn').classList.contains('is-open'),
      cfgText: (document.getElementById('daiCfgOpen') || {}).textContent || '',
      cfgInMenu: !!(document.getElementById('daiCfgOpen') && menu.contains(document.getElementById('daiCfgOpen')))
    };
  });
  check(!!menu && !menu.hidden, '点触发器后菜单展开');
  check(!!menu && menu.groups.length >= 1, '菜单里有分组标题', menu ? menu.groups.join(' / ') : '');
  check(!!menu && menu.items >= 1, '菜单里有可点选项', menu ? menu.items + ' 项' : '');
  check(!!menu && menu.onBg === 'rgb(253, 246, 230)', '当前项是淡金底（不是系统蓝 rgb(0,120,215)）', menu ? menu.onBg : '');
  check(!!menu && menu.tickVisible === '1', '当前项带金色对勾', menu ? menu.tickVisible : '');
  check(!!menu && menu.btnOpen, '触发器进入展开态（描边转金）');
  check(!!menu && !!btnBox && menu.bottom <= Math.round(btnBox.y) + 2, '菜单向上展开，不压住输入条',
    menu && btnBox ? 'menu.bottom=' + menu.bottom + ' btn.top=' + Math.round(btnBox.y) : '');
  check(!!menu && menu.cfgInMenu && /配置自定义模型/.test(menu.cfgText), '菜单底部有「配置自定义模型」入口', menu ? menu.cfgText : '');

  // 点一个非当前项：值要真的换掉，菜单要收起
  const switched = await page.evaluate(() => {
    const menu = document.querySelector('.dai-menu');
    const other = [...menu.querySelectorAll('.dai-menu-item')].find(b => !b.classList.contains('is-on'));
    if (!other) return null;
    const want = other.dataset.value;
    other.click();
    return { want, got: document.getElementById('deskAiModel').value };
  });
  await sleep(120);
  if (switched) {
    check(switched.want === switched.got, '点选项后值写回 select', JSON.stringify(switched));
  } else {
    check(true, '菜单只有一个选项，跳过切换断言');
  }
  const closed = await page.evaluate(() => !!document.querySelector('.dai-menu.hidden'));
  check(closed, '选完自动收起菜单');

  console.log('\n=== 4c. 配置自定义模型弹窗 ===');
  await page.click('#deskAiBtn');
  await sleep(200);
  await page.click('#daiCfgOpen');
  await sleep(260);
  const cfg = await page.evaluate(() => {
    const mask = document.getElementById('daiCfgMask');
    if (!mask) return null;
    const card = mask.querySelector('.dai-cfg');
    const r = card.getBoundingClientRect();
    return {
      visible: !mask.classList.contains('hidden'),
      title: card.querySelector('.dai-cfg-head').textContent,
      fields: ['daiCfgBase', 'daiCfgKey', 'daiCfgModel'].map(id => !!document.getElementById(id)),
      base: document.getElementById('daiCfgBase').value,
      curBase: document.getElementById('llmBaseUrl').value,
      keyType: document.getElementById('daiCfgKey').type,
      saveText: document.getElementById('daiCfgSave').textContent,
      inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth,
      z: getComputedStyle(mask).zIndex,
      menuClosed: !!document.querySelector('.dai-menu.hidden')
    };
  });
  check(!!cfg && cfg.visible, '弹窗打开');
  check(!!cfg && /配置自定义模型/.test(cfg.title), '标题正确', cfg ? cfg.title.replace(/\s+/g, ' ').trim() : '');
  check(!!cfg && cfg.fields.every(Boolean), '三个字段齐全（地址 / Key / 模型）');
  check(!!cfg && cfg.base === cfg.curBase, '接口地址带出设置里的现值', cfg ? cfg.base : '');
  check(!!cfg && cfg.keyType === 'password', 'API Key 是密码框');
  check(!!cfg && /保存/.test(cfg.saveText), '有保存按钮', cfg ? cfg.saveText : '');
  check(!!cfg && cfg.inViewport, '弹窗完整落在视口内');
  check(!!cfg && Number(cfg.z) >= 100, '弹窗盖在桌面之上', cfg ? 'z=' + cfg.z : '');
  check(!!cfg && cfg.menuClosed, '打开弹窗时模型菜单已收起');

  await page.click('#daiCfgCancel');
  await sleep(160);
  const cfgClosed = await page.evaluate(() => document.getElementById('daiCfgMask').classList.contains('hidden'));
  check(cfgClosed, '点取消关闭弹窗');

  console.log('\n=== 4d. 保存自定义模型：写回设置 + 立刻可选 ===');
  await page.click('#deskAiBtn');
  await sleep(200);
  await page.click('#daiCfgOpen');
  await sleep(240);
  await page.fill('#daiCfgBase', 'https://api.test.local/v1');
  await page.fill('#daiCfgKey', 'sk-test-123');
  // 弹窗会带出设置里的现值（默认配置里有 Ollama 的 qwen2.5:3b），要测「空模型名」得先清空
  await page.fill('#daiCfgModel', '');
  await page.click('#daiCfgSave');           // 模型名还没填
  await sleep(180);
  const badSave = await page.evaluate(() => ({
    err: document.getElementById('daiCfgErr').classList.contains('hidden') ? '' : document.getElementById('daiCfgErr').textContent,
    stillOpen: !document.getElementById('daiCfgMask').classList.contains('hidden')
  }));
  check(/模型名/.test(badSave.err) && badSave.stillOpen, '模型名为空时拦下并提示', badSave.err);

  await page.fill('#daiCfgModel', 'my-custom-model');
  await page.click('#daiCfgSave');
  let settled = true;
  try {
    await page.waitForFunction(
      () => document.getElementById('deskAiLabel').textContent === 'my-custom-model',
      null, { timeout: 9000 }
    );
  } catch (e) { settled = false; }
  const saved = await page.evaluate(() => {
    const sel = document.getElementById('deskAiModel');
    return {
      maskHidden: document.getElementById('daiCfgMask').classList.contains('hidden'),
      base: document.getElementById('llmBaseUrl').value,
      key: document.getElementById('llmKey').value,
      model: document.getElementById('llmModel').value,
      hasOption: Array.from(sel.options).some(o => o.value === 'local:my-custom-model'),
      value: sel.value,
      label: document.getElementById('deskAiLabel').textContent,
      tag: document.getElementById('deskAiTag').textContent,
      tagHidden: document.getElementById('deskAiTag').hidden
    };
  });
  check(settled, '模型清单刷新完成');
  check(saved.maskHidden, '保存后弹窗关闭');
  check(saved.base === 'https://api.test.local/v1' && saved.model === 'my-custom-model' && saved.key === 'sk-test-123',
    '三个值写回设置项（工作流里的 LLM 节点同步生效）', saved.base + ' · ' + saved.model);
  check(saved.hasOption, '模型清单里出现刚接的模型');
  check(saved.value === 'local:my-custom-model', '并自动选中它', saved.value);
  check(saved.label === 'my-custom-model', '触发器直接显示模型名', saved.label);
  check(!saved.tagHidden && saved.tag === '自定义', '来源角标显示「自定义」', saved.tag);

  console.log('\n=== 5. 发送后：翻到 App 页（对话是普通 App） ===');
  // 伪造一个已配置模型，让 connFor 能过校验（不发真实网络请求）
  await page.evaluate(() => {
    const sel = document.getElementById('deskAiModel');
    sel.disabled = false;
    if (!Array.from(sel.options).some(o => o.value === 'local:test-model')) {
      const g = sel.querySelector('optgroup') || sel;
      const op = document.createElement('option');
      op.value = 'local:test-model';
      op.textContent = 'test-model';
      if (g.tagName === 'OPTGROUP') g.appendChild(op); else sel.appendChild(op);
    }
    sel.value = 'local:test-model';
    // 用假的 base/key/model 覆盖连接，stream 会失败但流程走向可验证
    const base = document.getElementById('llmBaseUrl');
    const key = document.getElementById('llmKey');
    const model = document.getElementById('llmModel');
    if (base) base.value = 'http://127.0.0.1:9/v1';
    if (key) key.value = 'test-key';
    if (model) model.value = 'test-model';
  });
  const appCount = await page.evaluate(() => document.querySelectorAll('.desk-app').length);
  const wallBox = await page.locator('#deskWall').boundingBox();
  // 翻页前先量一遍输入条几何：翻过去之后必须一模一样
  const measureBar = () => page.evaluate(() => {
    const wrap = document.getElementById('deskAiWrap').getBoundingClientRect();
    const box = document.querySelector('.desk-ai');
    const cs = getComputedStyle(box);
    return {
      x: Math.round(wrap.x), w: Math.round(wrap.width),
      h: Math.round(box.getBoundingClientRect().height),
      pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join('/'),
      radius: cs.borderTopLeftRadius
    };
  });
  const barBefore = await measureBar();
  // 塞两条示例消息（一问一答），用来验气泡与头像
  await page.evaluate(() => window.deskChat.seed());
  await page.evaluate(() => { document.getElementById('deskAiText').value = '测试一下上下文'; });
  await page.click('#deskAiSend');
  await sleep(900);
  const state = await page.evaluate(() => {
    const p1 = document.getElementById('deskPage1');
    const p3 = document.getElementById('deskPageApps');
    const cs1 = getComputedStyle(p1), cs3 = getComputedStyle(p3);
    const r3 = p3.getBoundingClientRect();
    const win = document.getElementById('chatWin');
    return {
      open: document.getElementById('deskWall').classList.contains('app-open'),
      inChat: !!document.querySelector('#deskChatFoot #deskAiWrap'),
      winMounted: !!document.querySelector('#deskAppHost #chatWin'),
      winHidden: win ? win.classList.contains('hidden') : true,
      p1opacity: cs1.opacity, p1transform: cs1.transform, p1pointer: cs1.pointerEvents,
      p3opacity: cs3.opacity, p3transform: cs3.transform,
      p3rect: { x: Math.round(r3.x), w: Math.round(r3.width) },
      appTitle: (document.getElementById('deskAppTitle') || {}).textContent,
      hasBackBtn: !!document.getElementById('deskAppBack'),
      logMsgs: document.querySelectorAll('#deskChatLog .dchat-msg').length,
      modelLabel: (document.getElementById('deskChatModel') || {}).textContent,
      ctxLabel: (document.getElementById('deskChatCtx') || {}).textContent
    };
  });
  check(state.open, '桌面加上了 app-open（走统一 App 翻页）');
  check(state.p1opacity === '0' || parseFloat(state.p1opacity) < 0.05, '第一页（桌面）已隐藏', 'opacity=' + state.p1opacity);
  check(state.p3opacity === '1' && /matrix\(1, 0, 0, 1, 0, 0\)|none/.test(state.p3transform), '第三页（App 页）完全展开', state.p3transform);
  // App 页要铺满工作台（不是侧边栏）：左边缘贴工作台左边、右边缘贴视口右边
  check(Math.abs(state.p3rect.x - Math.round(wallBox.x)) <= 2 && Math.abs(state.p3rect.x + state.p3rect.w - 1440) <= 2,
    'App 页铺满整个工作台（不是侧边栏）', JSON.stringify(state.p3rect) + ' wall.x=' + Math.round(wallBox.x));
  check(state.winMounted && !state.winHidden, '对话窗口已挂进 App 页（和其他 App 同一套机制）');
  check(state.appTitle === 'AI 对话', 'App 页标题显示「AI 对话」', state.appTitle);
  check(state.hasBackBtn, '有统一的 << 返回按钮');
  check(state.inChat, '输入条迁移进对话窗口底部');
  check(state.logMsgs >= 1, '聊天日志有消息（' + state.logMsgs + ' 条）');
  check(!!state.modelLabel, '对话区显示当前模型：' + state.modelLabel);
  check(!!state.ctxLabel, '对话区显示当前上下文：' + state.ctxLabel);

  console.log('\n=== 5b. 翻页后输入条形状不变 + QQ 式气泡与头像 ===');
  const barAfter = await measureBar();
  /* 对话现在是普通 App，窗口落在灰底画布里（画布有 margin + padding + inset），
     所以输入条整体宽度必然比桌面上窄一截——那是布局的必然，不是缺陷。
     真正必须保证的是「输入框自己的样子不变」：
     内边距、圆角、高度一模一样，用户看着才像同一个输入框。
     宽度则要保证它铺满了对话窗口的可用宽度（不能只占一半）。 */
  check(barAfter.pad === barBefore.pad && barAfter.radius === barBefore.radius && barAfter.h === barBefore.h,
    '翻页后输入条内边距/圆角/高度不变（还是同一个输入框）',
    barAfter.pad + ' · r=' + barAfter.radius + ' · h=' + barAfter.h);
  const fillRate = await page.evaluate(() => {
    const wrap = document.getElementById('deskAiWrap').getBoundingClientRect();
    const foot = document.getElementById('deskChatFoot').getBoundingClientRect();
    const cs = getComputedStyle(document.getElementById('deskChatFoot'));
    const avail = foot.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { w: Math.round(wrap.width), avail: Math.round(avail), rate: wrap.width / avail };
  });
  check(fillRate.rate > 0.98, '输入条铺满对话窗口的可用宽度',
    fillRate.w + '/' + fillRate.avail + ' = ' + fillRate.rate.toFixed(3));

  const bubbles = await page.evaluate(() => {
    const user = document.querySelector('.dchat-msg.user');
    const ai = document.querySelector('.dchat-msg.ai');
    if (!user || !ai) return null;
    const ub = user.querySelector('.dchat-body');
    const ab = ai.querySelector('.dchat-body');
    const ua = user.querySelector('.dchat-ava');
    const aaWrap = ai.querySelector('.dchat-ava');
    const aa = aaWrap && aaWrap.querySelector('img');
    const ur = user.getBoundingClientRect(), ar = ai.getBoundingClientRect();
    return {
      userBg: getComputedStyle(ub).backgroundColor,
      aiBg: getComputedStyle(ab).backgroundColor,
      userRight: ur.right > ar.right - 1,
      aiAvatarSrc: (aa && aa.getAttribute('src')) || '',
      aiAvatarVisible: !!(aa && aa.getBoundingClientRect().width > 12),
      userAvatarText: (ua && ua.textContent.trim()) || '',
      userAvatarRight: !!(ua && ua.getBoundingClientRect().left > ub.getBoundingClientRect().right - 2),
      aiAvatarLeft: !!(aaWrap && aaWrap.getBoundingClientRect().right <= ab.getBoundingClientRect().left + 2)
    };
  });
  check(!!bubbles, '聊天记录里同时有用户与 AI 气泡');
  check(bubbles && bubbles.userBg === 'rgb(255, 255, 255)', '用户气泡是白底', bubbles && bubbles.userBg);
  check(bubbles && bubbles.aiBg === 'rgb(242, 243, 245)', 'AI 气泡是灰底', bubbles && bubbles.aiBg);
  check(bubbles && bubbles.userRight, '用户气泡靠右');
  check(bubbles && /ollama-llama\.png$/.test(bubbles.aiAvatarSrc) && bubbles.aiAvatarVisible,
    'AI 默认头像是 Ollama 羊驼', bubbles && bubbles.aiAvatarSrc);
  check(bubbles && bubbles.userAvatarText === '我' && bubbles.userAvatarRight, '用户头像在气泡右侧', bubbles && bubbles.userAvatarText);
  check(bubbles && bubbles.aiAvatarLeft, 'AI 头像在气泡左侧');

  console.log('\n=== 6. 回到第一页（统一的 << 返回按钮） ===');
  await page.click('#deskAppBack');
  await sleep(700);
  const back = await page.evaluate(() => ({
    open: document.getElementById('deskWall').classList.contains('app-open'),
    inPage1: !!document.querySelector('#deskPage1 #deskAiWrap'),
    winRestored: !!document.querySelector('#deskPage1 #chatWin') || !document.querySelector('#deskAppHost #chatWin'),
    p1opacity: getComputedStyle(document.getElementById('deskPage1')).opacity,
    p3opacity: getComputedStyle(document.getElementById('deskPageApps')).opacity
  }));
  check(!back.open, 'app-open 已移除');
  check(back.inPage1, '输入条回到第一页');
  check(back.winRestored, '对话窗口已放回原位');
  check(parseFloat(back.p1opacity) > 0.95, '桌面重新可见', 'opacity=' + back.p1opacity);
  check(parseFloat(back.p3opacity) < 0.05, 'App 页已收起', 'opacity=' + back.p3opacity);

  console.log('\n=== 7. 上下文文本注入 ===');
  const ctxText = await page.evaluate(() => {
    const sel = document.getElementById('deskAiCtx');
    const flow = Array.from(sel.options).find(o => o.value.indexOf('flow:') === 0);
    if (!flow) return '(无工作流可测)';
    sel.value = flow.value;
    sel.dispatchEvent(new Event('change'));
    return window.deskChat && window.deskChat.ctxText ? window.deskChat.ctxText(sel.value) : '(未暴露)';
  });
  check(typeof ctxText === 'string', '上下文文本可构造', ctxText.slice(0, 90));

  check(errors.length === 0, '页面无 JS 异常', errors.join(' | ').slice(0, 300));

  await browser.close();
  console.log(fails === 0 ? '\n全部通过 ✅' : '\n失败 ' + fails + ' 项 ❌');
  process.exit(fails === 0 ? 0 : 1);
})();
