/* 单测：错误体的「说人话」层（prettyError / pickErrMsg / friendlyErr）
 * 用法：node tools/err-format.js
 *
 * 起因：运行日志里出现 `智能分支失败 · HTTP 400: [object Object]` ——
 * 上游回的是 {"error":{"message":"…"}}，老实现 `String(j.error)` 把对象压成了
 * "[object Object]"，等于报了个寂寞。用户看到这条完全无法判断是自己配错还是程序坏了。
 *
 * 这一层是**所有**接口报错的唯一出口（运行日志、节点状态、设置页测试都在用），
 * 所以值得单独钉住：不许再出现 [object Object]，也不许把能读的那句话弄丢。
 */
const { chromium } = require('playwright-core');
const { pathToFileURL } = require('url');
const path = require('path');

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

/* 真实见过的错误体形状 */
const CASES = [
  /* ⚠ 这条是**实测抓到的原文**（Ollama + qwen2.5:3b 收到 image_url 时）：
   * 老实现把它压成 [object Object]，运行日志就只剩「HTTP 400: [object Object]」。 */
  { name: 'Ollama 多模态拒绝（实测原文）',
    body: JSON.stringify({ error: { message: 'Multimodal data provided, but model does not support multimodal requests.', type: 'invalid_request_error', param: null, code: null } }),
    want: 'Multimodal data provided, but model does not support multimodal requests.' },
  { name: 'OpenAI 官方（error 是对象）',
    body: JSON.stringify({ error: { message: 'model does not support images', type: 'invalid_request_error' } }),
    want: 'model does not support images' },
  { name: 'Ollama（error 是字符串）',
    body: JSON.stringify({ error: 'model requires more system memory' }),
    want: 'model requires more system memory' },
  { name: 'vLLM / TGI（顶层 message）',
    body: JSON.stringify({ object: 'error', message: 'max context length exceeded' }),
    want: 'max context length exceeded' },
  { name: '网关 detail 里套数组',
    body: JSON.stringify({ detail: [{ msg: 'field required', loc: ['body', 'model'] }] }),
    want: 'field required' },
  { name: 'error_description（OAuth 风格）',
    body: JSON.stringify({ error: 'invalid_request', error_description: 'Missing Authorization header' }),
    want: 'Missing Authorization header' },
  { name: '嵌套一层 {error:{error:{message}}}',
    body: JSON.stringify({ error: { error: { message: 'upstream refused' } } }),
    want: 'upstream refused' }
];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.goto(pathToFileURL(path.join(__dirname, '..', 'index.html')).href + '?nostore=1', { waitUntil: 'load' });
  await page.waitForTimeout(900);

  console.log('\n=== 1. 各种错误体都能挖出那句话 ===');
  const got = await page.evaluate(list => list.map(c => {
    let out;
    try { out = prettyError(c.body); } catch (e) { out = 'ERR:' + e.message; }
    return out;
  }), CASES);
  CASES.forEach((c, i) => {
    check(got[i] === c.want, c.name, JSON.stringify(got[i]));
    check(!/\[object Object\]/.test(got[i]), c.name + ' · 不再是 [object Object]');
  });

  console.log('\n=== 2. 退化情形不抛、不空 ===');
  const edge = await page.evaluate(() => ({
    empty: prettyError(''),
    nullish: prettyError(null),
    emptyObj: prettyError('{}'),
    html: prettyError('<html><body><h1>502 Bad Gateway</h1></body></html>'),
    unknown: prettyError(JSON.stringify({ code: 4001, data: { x: 1 } })),
    plain: prettyError('some raw text'),
    number: prettyError('42')
  }));
  check(edge.empty === '（响应体为空）', '空响应体给明确提示', edge.empty);
  check(edge.nullish === '（响应体为空）', 'null 也一样', edge.nullish);
  check(/空对象/.test(edge.emptyObj), '{} 说明是空对象', edge.emptyObj);
  check(/502/.test(edge.html), 'HTML 错误页原样带出来（不吞）', edge.html.slice(0, 30));
  check(/4001/.test(edge.unknown), '认不出的结构压成 JSON 保留信息', edge.unknown.slice(0, 40));
  check(edge.plain === 'some raw text', '裸文本原样返回', edge.plain);
  check(/42/.test(edge.number), '数字也能转成文字', edge.number);

  console.log('\n=== 3. 长文本要裁（错误信息不能撑爆日志） ===');
  const long = await page.evaluate(() => prettyError('x'.repeat(2000)).length);
  check(long <= 300, '非 JSON 的长文本裁到 300 字以内', 'len=' + long);

  console.log('\n=== 4. friendlyErr：英文报错要翻成中文，并给能照做的动作 ===');
  const fr = await page.evaluate(() => ({
    /* 实测原文：这是这次真正踩到的那条（Ollama + qwen2.5:3b 收到 image_url） */
    multi: friendlyErr(new Error('HTTP 400：Multimodal data provided, but model does not support multimodal requests.')),
    img: friendlyErr(new Error('HTTP 400：model does not support images')),
    ctx: friendlyErr(new Error('max context length exceeded')),
    key: friendlyErr(new Error('HTTP 401: invalid api key provided')),
    rate: friendlyErr(new Error('HTTP 429: rate limit exceeded')),
    model: friendlyErr(new Error('HTTP 404: model not found')),
    quota: friendlyErr(new Error('insufficient quota')),
    oom: friendlyErr(new Error('CUDA error: out of memory')),
    /* 认不出的英文：不假装看懂，但要标明这是上游原文 */
    plain: friendlyErr(new Error('HTTP 500: boom')),
    /* 已经是中文的一条都不许再被包一层 */
    cn: friendlyErr(new Error('渲染失败：模型文件读不出来'))
  }));
  check(/图像输入/.test(fr.multi) && /视觉模型/.test(fr.multi), '多模态拒绝 → 说清「不接受图像输入」并给出动作', fr.multi.slice(0, 50));
  check(/原文/.test(fr.multi), '中文在前、原文附后（排错时还要靠英文去搜）', '…' + fr.multi.slice(-30));
  check(/图像输入/.test(fr.img), '同义写法也能命中（正则别只认一种）', fr.img.slice(0, 40));
  check(/上下文/.test(fr.ctx), '上下文超限 → 指向「减少图片 / 关上下文」', fr.ctx.slice(0, 40));
  check(/Key 无效/.test(fr.key), 'Key 无效 → 指向「重新粘贴，别带空格」', fr.key.slice(0, 40));
  check(/限流/.test(fr.rate), '429 → 说「被上游限流」', fr.rate.slice(0, 40));
  check(/模型名不存在/.test(fr.model), '模型不存在 → 指向「读取模型再选」', fr.model.slice(0, 40));
  check(/额度/.test(fr.quota), '余额不足 → 指向「充值或换来源」', fr.quota.slice(0, 40));
  check(/显存不足/.test(fr.oom), 'OOM 的既有中文文案没被挤掉', fr.oom.slice(0, 30));
  check(/上游返回错误/.test(fr.plain) && /500/.test(fr.plain), '认不出的英文 → 标明是上游原文，不假装看懂', fr.plain);
  check(fr.cn === '渲染失败：模型文件读不出来', '已经是中文的照原样返回（不重复包装）', fr.cn);
  /* 一条都不能剩纯英文 */
  const stillEnglish = Object.entries(fr).filter(([, v]) => !/[\u4e00-\u9fa5]/.test(v)).map(([k]) => k);
  check(stillEnglish.length === 0, '日志里不该再有纯英文的报错', stillEnglish.join(',') || 'none');

  console.log('\n=== 5. 页面零报错 ===');
  check(errors.length === 0, '没有未捕获的 JS 错误', errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log('\n' + (fails ? '❌ 失败 ' + fails + ' 项' : '✅ 全部通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('崩溃：', e); process.exit(1); });
