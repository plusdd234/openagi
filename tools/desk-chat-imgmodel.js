/* 体检：输入条上的「生图模型」下拉
 *
 * 覆盖五件事：
 *   ① 下拉存在、能开、清单有分组（本地 ComfyUI / 在线接口）
 *   ② 清单里**没有 Tripo**（Tripo 是独立的网页操作节点，不在生图模型配置里）
 *   ③ 选中本地 ckpt → 写进 mc_comfy_ckpt（provider.js 真正读的那个键）
 *   ④ 选中在线模型 → 写进 hf_imgModel，并把 genEngine 切到 openai
 *   ⑤ 页头「生图 · xxx」标签与下拉一致；引擎切到 Tripo 时下拉禁用并说明
 *   ⑥ 菜单底部「＋ 配置自定义云端生图」：芯片只填不落盘、保存后字段/引擎/来源全同步、
 *      缺模型名要拦住（这条是「云端生图看着像没做」的正面修复）
 *
 * ⚠ 为什么在页面加载**之后**打补丁：
 *   provider.js / config.js / api.js 里那些是顶层 `function` / `let` 声明，
 *   加载前设 window.xxx 会被后加载的脚本覆盖掉（function 声明会重写 window 同名属性），
 *   而 `let` 声明（IMG_MODEL_CACHE）压根不在 window 上。
 *   所以：加载后 patch function 声明（providerFor / imgMode / setComfyCkpt…），
 *   加载后直接给 `let` 绑定赋值（IMG_MODEL_CACHE），再派发事件让对话侧重渲染。
 *   这样测试结果**不依赖本机 ComfyUI 有没有在跑**。
 *
 * 用法：node tools/desk-chat-imgmodel.js
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

const FAKE_CKPTS = ['dreamshaper_8.safetensors', 'sd_xl_base_1.0.safetensors'];
const FAKE_IMG_MODELS = ['seedream_v5', 'nano-banana-pro'];

(async () => {
  const errors = [];
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => errors.push(String(e && e.message)));

  const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  /* ---------- 打补丁（加载后） ---------- */
  await page.evaluate(async (cfg) => {
    window.__calls = { listModels: 0 };

    /* providerFor 是 function 声明 → 在 window 上，可以替换。 */
    const realProviderFor = window.providerFor;
    window.providerFor = function (kind, id) {
      if (kind === 'image' && id === 'comfy-image') {
        return {
          id: 'comfy-image', kind: 'image', label: 'ComfyUI 本地生图', local: true,
          status: () => true,
          async listModels() {
            window.__calls.listModels++;
            return cfg.ckpts.map(id => ({ id, owned_by: 'ComfyUI' }));
          },
          async generate() { throw new Error('测试不生图'); }
        };
      }
      return realProviderFor ? realProviderFor.apply(this, arguments) : null;
    };

    /* 这几个也是 function 声明 → 可替换。保持与真实实现同构的 localStorage 语义。 */
    window.imgMode = () => { try { return localStorage.getItem('mc_scope_image') || 'online'; } catch (e) { return 'online'; } };
    window.setImgMode = (m) => { const v = (m === 'local') ? 'local' : 'online'; try { localStorage.setItem('mc_scope_image', v); } catch (e) {} return v; };
    window.comfyCkptChoice = () => { try { return localStorage.getItem('mc_comfy_ckpt') || ''; } catch (e) { return ''; } };
    window.setComfyCkpt = (n) => { try { localStorage.setItem('mc_comfy_ckpt', String(n || '')); } catch (e) {} };

    /* IMG_MODEL_CACHE 是 `let` 顶层绑定，不在 window 上 —— 直接给裸标识符赋值。
     * base 必须与页面此刻算出来的一致，否则清单会被判为「不是当前接口的」而丢掉。
     * 页面的公式：imgBaseUrl || llmBaseUrl（去尾斜杠）——和 api.js 的 loadImgModels /
     * modelListForCurrentBase 完全一致，这里照抄，不要自己发明。 */
    try {
      const base = (document.getElementById('imgBaseUrl').value.trim()
        || document.getElementById('llmBaseUrl').value.trim()).replace(/\/$/, '');
      IMG_MODEL_CACHE = { base, list: cfg.imgModels.map(id => ({ id, owned_by: '' })) };
    } catch (e) {}

    /* 清干净上一轮的残留，让断言从确定状态开始 */
    try {
      localStorage.removeItem('hf_imgModel');
      localStorage.removeItem('mc_comfy_ckpt');
      localStorage.setItem('mc_scope_image', 'online');
      const eng = document.getElementById('genEngine');
      if (eng) eng.value = 'openai';
    } catch (e) {}

    /* 让对话侧重渲染一次 */
    window.dispatchEvent(new CustomEvent('hf-img-source-changed'));
    await new Promise(r => setTimeout(r, 500));
  }, { ckpts: FAKE_CKPTS, imgModels: FAKE_IMG_MODELS });

  console.log('\n=== 1. 下拉控件存在且位置正确 ===');
  for (const id of ['deskAiImgModel', 'deskAiImgBtn', 'deskAiImgLabel']) {
    const n = await page.locator('#' + id).count();
    check(n === 1, id + ' 存在');
  }
  const nativeVisible = await page.evaluate(() => {
    const s = document.getElementById('deskAiImgModel');
    return s ? getComputedStyle(s).display : 'missing';
  });
  check(nativeVisible === 'none', '原生 select 已隐藏（与语言模型下拉同一范式）', nativeVisible);

  const btnBox = await page.locator('#deskAiImgBtn').boundingBox();
  const modeBox = await page.locator('#deskAiImage').boundingBox();
  const dotBox = await page.locator('#deskAiDot').boundingBox();
  check(!!btnBox, '生图模型按钮可见');
  check(!!(modeBox && btnBox && modeBox.x < btnBox.x), '顺序：生图模式 在 生图模型 左边');
  check(!!(btnBox && dotBox && btnBox.x < dotBox.x), '顺序：生图模型 在 状态点 左边');

  console.log('\n=== 2. 清单分组正确（只有本地与在线，没有 Tripo） ===');
  const groups = await page.evaluate(() => {
    const sel = document.getElementById('deskAiImgModel');
    if (!sel) return [];
    return Array.from(sel.querySelectorAll('optgroup')).map(g => ({
      label: g.label,
      items: Array.from(g.children).map(o => o.value)
    }));
  });
  check(groups.length >= 2, '下拉按来源分组', JSON.stringify(groups.map(g => g.label)));
  const allVals = groups.flatMap(g => g.items);
  check(allVals.includes('comfy:dreamshaper_8.safetensors'), '本地 ComfyUI ckpt 在清单里（不是 [object Object]）');
  check(allVals.includes('online:seedream_v5'), '在线模型在清单里');
  check(allVals.every(v => typeof v === 'string' && v.indexOf('object') < 0), '选项值都是字符串（无 [object Object]）');
  check(!allVals.some(v => v.indexOf('tripo:') === 0), '清单里没有 Tripo 选项');
  check(!groups.some(g => /tripo/i.test(g.label)), '分组标题里没有 Tripo', JSON.stringify(groups.map(g => g.label)));

  console.log('\n=== 3. 按钮文字反映当前模型 ===');
  const labelText = await page.evaluate(() => {
    const l = document.getElementById('deskAiImgLabel');
    return l ? l.textContent : '';
  });
  check(!!labelText, '按钮上有文字', labelText);
  check(labelText !== '生图模型', '按钮文字不是占位符（说明已选中某个模型）', labelText);

  console.log('\n=== 4. 选中本地 ckpt → 写进 mc_comfy_ckpt ===');
  const appliedComfy = await page.evaluate(async () => {
    const sel = document.getElementById('deskAiImgModel');
    sel.value = 'comfy:dreamshaper_8.safetensors';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    return {
      ckpt: localStorage.getItem('mc_comfy_ckpt'),
      scope: localStorage.getItem('mc_scope_image'),
      imgModel: localStorage.getItem('hf_imgModel')
    };
  });
  check(appliedComfy.ckpt === 'dreamshaper_8.safetensors', '写进 mc_comfy_ckpt（provider 真正读的键）', String(appliedComfy.ckpt));
  check(appliedComfy.scope === 'local', '来源切到本地（mc_scope_image=local）', String(appliedComfy.scope));
  check(!appliedComfy.imgModel, '没有动在线模型名（本地与在线互不干扰）', String(appliedComfy.imgModel));

  console.log('\n=== 5. 选中在线模型 → 写 hf_imgModel，引擎切 openai ===');
  const appliedOnline = await page.evaluate(async () => {
    const sel = document.getElementById('deskAiImgModel');
    sel.value = 'online:nano-banana-pro';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 250));
    const eng = document.getElementById('genEngine');
    const field = document.getElementById('imgModel');
    return {
      stored: localStorage.getItem('hf_imgModel'),
      field: field ? field.value : '',
      engine: eng ? eng.value : '',
      scope: localStorage.getItem('mc_scope_image'),
      ckpt: localStorage.getItem('mc_comfy_ckpt')
    };
  });
  check(appliedOnline.stored === 'nano-banana-pro', '写进 hf_imgModel', String(appliedOnline.stored));
  check(appliedOnline.field === 'nano-banana-pro', '设置页的生图模型输入框同步更新', String(appliedOnline.field));
  check(appliedOnline.engine === 'openai', '生成引擎切到 openai（否则会发给 Tripo）', String(appliedOnline.engine));
  check(appliedOnline.scope === 'online', '来源切回在线', String(appliedOnline.scope));
  check(appliedOnline.ckpt === 'dreamshaper_8.safetensors', '本地 ckpt 保留（换回来还能用）', String(appliedOnline.ckpt));

  console.log('\n=== 6. 引擎切到 Tripo → 下拉禁用并说明（Tripo 是网页操作节点） ===');
  const tripoState = await page.evaluate(async () => {
    const eng = document.getElementById('genEngine');
    eng.value = 'tripo';
    eng.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const sel = document.getElementById('deskAiImgModel');
    const lab = document.getElementById('deskAiImgLabel');
    return {
      disabled: sel ? sel.disabled : null,
      text: sel && sel.options.length ? sel.options[0].textContent : '',
      label: lab ? lab.textContent : ''
    };
  });
  check(tripoState.disabled === true, '引擎是 Tripo 时下拉禁用', String(tripoState.disabled));
  check(/Tripo/.test(tripoState.text), '有说明文字（不是空白）', tripoState.text);
  check(/Tripo/.test(tripoState.label), '按钮文字也说明了', tripoState.label);

  await page.evaluate(async () => {
    const eng = document.getElementById('genEngine');
    eng.value = 'openai';
    eng.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
  });

  console.log('\n=== 7. 页头标签与下拉一致 ===');
  const headerSync = await page.evaluate(async () => {
    const sel = document.getElementById('deskAiImgModel');
    sel.value = 'online:nano-banana-pro';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const chip = document.getElementById('deskChatImg');
    const lab = document.getElementById('deskAiImgLabel');
    return { chip: chip ? chip.textContent : '', btn: lab ? lab.textContent : '' };
  });
  check(headerSync.chip.indexOf('nano-banana-pro') >= 0, '页头标签含模型名', headerSync.chip);
  check(headerSync.btn === 'nano-banana-pro', '下拉按钮文字与模型名一致', headerSync.btn);

  console.log('\n=== 8. 设置页切来源 → 对话侧跟着换 ===');
  const afterScope = await page.evaluate(async () => {
    window.setImgMode('local');
    window.dispatchEvent(new CustomEvent('hf-img-source-changed'));
    await new Promise(r => setTimeout(r, 450));
    const sel = document.getElementById('deskAiImgModel');
    const lab = document.getElementById('deskAiImgLabel');
    return { value: sel ? sel.value : '', label: lab ? lab.textContent : '' };
  });
  check(afterScope.value === 'comfy:dreamshaper_8.safetensors', '切到本地后下拉选中本地 ckpt', afterScope.value);
  check(afterScope.label === 'dreamshaper_8.safetensors', '按钮文字跟着换成 ckpt 名', afterScope.label);

  console.log('\n=== 9. 确实问过引擎要 ckpt 清单 ===');
  const listCalls = await page.evaluate(() => window.__calls.listModels);
  check(listCalls >= 1, '问过引擎要 ckpt 清单', 'listModels 调用 ' + listCalls + ' 次');

  console.log('\n=== 10. 打开下拉菜单能看见分组与选项 ===');
  await page.click('#deskAiImgBtn');
  await sleep(350);
  const menu = await page.evaluate(() => {
    const m = Array.from(document.querySelectorAll('.dai-menu')).find(x => !x.classList.contains('hidden'));
    if (!m) return null;
    return {
      groups: Array.from(m.querySelectorAll('.dai-menu-group')).map(g => g.textContent),
      items: Array.from(m.querySelectorAll('.dai-menu-item')).map(i => i.textContent.trim()),
      onCount: m.querySelectorAll('.dai-menu-item.is-on').length
    };
  });
  check(!!menu, '弹层已打开');
  if (menu) {
    check(menu.groups.length >= 2, '弹层有分组标题', JSON.stringify(menu.groups));
    check(menu.items.some(t => t.indexOf('dreamshaper') >= 0), '弹层里有本地 ckpt');
    check(menu.items.some(t => t.indexOf('nano-banana') >= 0), '弹层里有在线模型');
    check(!menu.items.some(t => /tripo/i.test(t)), '弹层里没有 Tripo 项');
    check(menu.onCount === 1, '当前项有勾选标记', 'is-on=' + menu.onCount);
  }
  await page.evaluate(() => { document.body.click(); });
  await sleep(200);

  console.log('\n=== 11. 菜单底部「＋ 配置自定义云端生图」 ===');
  /* 在线那一组来自设置页读过的清单；没配过接口时下拉里只剩本地 ckpt，
     看着像「云端生图没做」。所以菜单底部必须有接入口，且点了真能配。 */
  /* 上一段用 body.click() 收菜单，但它只派发 click、不派发 pointerdown，
     菜单其实还开着；再点触发器反而是「关」。所以这里先看状态，只在关着时才开。 */
  await page.evaluate(() => {
    const open = Array.from(document.querySelectorAll('.dai-menu')).some(x => !x.classList.contains('hidden'));
    if (!open) document.getElementById('deskAiImgBtn').click();
  });
  await sleep(320);
  const entry = await page.evaluate(() => {
    const b = document.getElementById('daiImgCfgOpen');
    return b ? { text: b.textContent.trim(), inMenu: !!(b.closest && b.closest('.dai-menu')) } : null;
  });
  check(!!entry, '菜单底部有入口（#daiImgCfgOpen）');
  check(!!(entry && /云端生图/.test(entry.text)), '文案是「配置自定义云端生图」', entry && entry.text);
  check(!!(entry && entry.inMenu), '入口在菜单里（不是游离在 body 上）');

  await page.click('#daiImgCfgOpen');
  await sleep(320);
  const dlg = await page.evaluate(() => {
    const m = document.getElementById('daiImgCfgMask');
    const miss = ['daiImgCfgBase', 'daiImgCfgKey', 'daiImgCfgModel', 'daiImgCfgEndpoint', 'daiImgCfgSize']
      .filter(id => !document.getElementById(id));
    const src = document.getElementById('daiImgCfgSrc');
    return {
      open: !!m && !m.classList.contains('hidden'),
      miss,
      chips: src ? Array.from(src.children).map(c => c.textContent) : [],
      preselected: {
        base: document.getElementById('daiImgCfgBase') ? document.getElementById('daiImgCfgBase').value : null,
        pageBase: document.getElementById('imgBaseUrl').value
      }
    };
  });
  check(dlg.open, '点入口打开配置弹层');
  check(dlg.miss.length === 0, '五个字段都在（地址 / Key / 模型 / 端点 / 尺寸）', dlg.miss.join(','));
  check(dlg.chips.length >= 3, '有中转站快捷芯片', 'chips=' + dlg.chips.length);
  check(dlg.chips.some(t => /复用分析接口/.test(t)), '有「复用分析接口」芯片');
  check(dlg.chips.some(t => /自定义/.test(t)), '有「自定义」芯片');

  const chipPick = await page.evaluate(() => {
    const box = document.getElementById('daiImgCfgSrc');
    const hit = Array.from(box.children).find(c => /Crazyrouter/.test(c.textContent));
    if (!hit) return null;
    hit.click();
    return {
      base: document.getElementById('daiImgCfgBase').value,
      model: document.getElementById('daiImgCfgModel').value,
      endpoint: document.getElementById('daiImgCfgEndpoint').value,
      pageBase: document.getElementById('imgBaseUrl').value
    };
  });
  check(!!(chipPick && /crazyrouter/.test(chipPick.base)), '点中转站芯片 → 填好 Base URL', chipPick && chipPick.base);
  check(!!(chipPick && chipPick.model), '点中转站芯片 → 填好模型名', chipPick && chipPick.model);
  check(!!(chipPick && chipPick.endpoint === '/images/edits'), '端点默认 /images/edits', chipPick && chipPick.endpoint);
  check(!!(chipPick && chipPick.pageBase !== chipPick.base), '点芯片只填不落盘（设置页字段未被悄悄改掉）', chipPick && chipPick.pageBase);

  await page.fill('#daiImgCfgBase', 'https://relay.example.com/v1');
  await page.fill('#daiImgCfgKey', 'sk-test-only');
  await page.fill('#daiImgCfgModel', 'nano-banana-2.1');
  await page.click('#daiImgCfgSave');
  await sleep(700);
  const saved = await page.evaluate(() => {
    const m = document.getElementById('daiImgCfgMask');
    const sel = document.getElementById('deskAiImgModel');
    return {
      closed: !!m && m.classList.contains('hidden'),
      pageBase: document.getElementById('imgBaseUrl').value,
      pageKey: document.getElementById('imgKey').value,
      pageModel: document.getElementById('imgModel').value,
      pageEndpoint: document.getElementById('imgEndpoint').value,
      stored: localStorage.getItem('hf_imgModel'),
      scope: localStorage.getItem('mc_scope_image'),
      engine: document.getElementById('genEngine').value,
      value: sel ? sel.value : '',
      label: (document.getElementById('deskAiImgLabel') || {}).textContent,
      inList: sel ? Array.from(sel.options).some(o => o.value === 'online:nano-banana-2.1') : false
    };
  });
  check(saved.closed, '保存后弹层关闭');
  check(saved.pageBase === 'https://relay.example.com/v1', '写进设置页 imgBaseUrl', saved.pageBase);
  check(saved.pageKey === 'sk-test-only', '写进设置页 imgKey');
  check(saved.pageModel === 'nano-banana-2.1', '写进设置页 imgModel', saved.pageModel);
  check(saved.stored === 'nano-banana-2.1', '写进 hf_imgModel（wfImage 真正读的键）', String(saved.stored));
  check(saved.scope === 'online', '来源切到在线', String(saved.scope));
  check(saved.engine === 'openai', '引擎切到 openai（否则会发给 Tripo）', saved.engine);
  check(saved.inList, '新模型立刻出现在下拉清单里（不落进「当前选择」临时分组）');
  check(saved.value === 'online:nano-banana-2.1', '保存后自动选中该模型', saved.value);
  check(saved.label === 'nano-banana-2.1', '按钮文字跟着变成新模型', saved.label);

  /* 缺字段要拦，且拦得住（不能静默保存一个不可用的配置） */
  const blocked = await page.evaluate(async () => {
    window.deskChat.imgCfg.open();
    document.getElementById('daiImgCfgModel').value = '';
    document.getElementById('daiImgCfgSave').click();
    await new Promise(r => setTimeout(r, 200));
    const err = document.getElementById('daiImgCfgErr');
    const m = document.getElementById('daiImgCfgMask');
    const out = {
      errShown: !!err && !err.classList.contains('hidden') && !!err.textContent,
      stillOpen: !!m && !m.classList.contains('hidden')
    };
    window.deskChat.imgCfg.close();
    return out;
  });
  check(blocked.errShown, '模型名为空时给出明确错误');
  check(blocked.stillOpen, '有错时弹层不关闭（否则用户以为保存成功了）');
  await sleep(200);

  console.log('\n=== 12. 访问官网（用户自己去官网拿 Key） ===');
  /* 中转站的 Key 只能去它自己官网建。所以弹层里「还没有 Key？」后面必须有一个可点的官网链接，
     并且随着「选中的站」变化：命中预设 → 预设登记的官网；手填地址 → 该地址 origin；
     本机地址 → 不给（127.0.0.1 没有官网可去，给了就是骗人）。 */
  const sitePreset = await page.evaluate(async () => {
    window.deskChat.imgCfg.open();
    await new Promise(r => setTimeout(r, 200));
    const box = document.getElementById('daiImgCfgSrc');
    const hit = Array.from(box.children).find(c => /OpenAI/.test(c.textContent));
    if (hit) hit.click();
    await new Promise(r => setTimeout(r, 150));
    const a = document.getElementById('daiImgCfgSite');
    const row = document.getElementById('daiImgCfgGetKey');
    return {
      href: a.getAttribute('href'),
      text: a.textContent,
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel') || '',
      hidden: row.classList.contains('hidden')
    };
  });
  check(sitePreset.href === 'https://platform.openai.com', '预设 → 链接来自预设登记的官网', sitePreset.href);
  check(/OpenAI/.test(sitePreset.text) && /官网/.test(sitePreset.text), '文案是「打开 OpenAI 官网」', sitePreset.text);
  check(sitePreset.target === '_blank' && /noopener/.test(sitePreset.rel), '新窗口打开且带 noopener（桌面端交给 shell.openExternal）');
  check(!sitePreset.hidden, '链接行可见');

  const siteCustom = await page.evaluate(async () => {
    const input = document.getElementById('daiImgCfgBase');
    input.value = 'https://relay.example.com/v1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const a = document.getElementById('daiImgCfgSite');
    return { href: a.getAttribute('href'), text: a.textContent };
  });
  check(siteCustom.href === 'https://relay.example.com', '手填地址 → 链接退回该站 origin（任意站都能点）', siteCustom.href);
  check(/relay\.example\.com/.test(siteCustom.text), '文案带域名（点去哪一目了然）', siteCustom.text);

  const siteLocal = await page.evaluate(async () => {
    const input = document.getElementById('daiImgCfgBase');
    input.value = 'http://127.0.0.1:11434/v1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const row = document.getElementById('daiImgCfgGetKey');
    return { hidden: row.classList.contains('hidden'), href: document.getElementById('daiImgCfgSite').getAttribute('href') };
  });
  check(siteLocal.hidden, '本机地址不摆「官网」链接（127.0.0.1 没有官网）');
  check(!siteLocal.href, '本机地址时 href 被清掉（不是留一个死链）');

  await page.evaluate(() => {
    window.deskChat.imgCfg.close();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await sleep(240);

  /* 已经配过站的人：菜单底部第二行直接去官网（充值 / 看新模型）。
     此刻在线地址是第 11 段存下的 relay.example.com。 */
  const menuSite = await page.evaluate(async () => {
    const open = Array.from(document.querySelectorAll('.dai-menu')).some(x => !x.classList.contains('hidden'));
    if (!open) document.getElementById('deskAiImgBtn').click();
    await new Promise(r => setTimeout(r, 260));
    const a = document.getElementById('daiImgSiteOpen');
    return a ? { href: a.getAttribute('href'), text: a.textContent } : null;
  });
  check(!!menuSite, '菜单底部出现「打开 xx 官网」第二行');
  check(!!(menuSite && menuSite.href === 'https://relay.example.com'), '菜单里的链接指向当前站 origin', menuSite && menuSite.href);
  await page.evaluate(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await sleep(200);

  const presetLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#imgPresetLinks a')).map(a => a.textContent.trim()));
  check(presetLinks.some(t => /OpenAI/.test(t)), '设置页官网链接覆盖官方直连（原来只列中转站）', presetLinks.join(' | '));

  console.log('\n=== 13. 无页面异常 ===');
  check(errors.length === 0, '没有未捕获的 JS 错误', errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n' + (fails === 0 ? '✅ 全部通过' : '❌ 有 ' + fails + ' 项未通过'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
