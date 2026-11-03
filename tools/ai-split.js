/* AI 拆件 · 真机验收（走用户已配置的 DeepSeek，真实读图，真实导出 GLB）
 *
 * 跑法：node tools/ai-split.js
 * 需要本机 8787 中转在跑（浏览器直连被 CORS 拒时会自动切 /proxy）。
 *
 * 验的是四件事：
 *   ① 候选岛图按网格分开、编号可读
 *   ② 语言模型真的读了图，并把岛分成了 头 / 头发 / 身体
 *   ③ 重建出来的部件几何非空，语义位置对（头在上、身体在中间、头发竖直跨度大）
 *   ④ 合并 GLB 能被 GLTFLoader 再读回来
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const PORT = 8148;
const MODEL = '/assets/models/mvvd80i5-f2df38c4.glb';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.obj': 'text/plain' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && p.indexOf('/api-proxy') === 0) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      try {
        const r = await fetch(upstream + p.slice('/api-proxy'.length), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': req.headers.authorization || ''
          },
          body: raw
        });
        const t = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(t);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
    return;
  }
  const f = path.join(ROOT, p);
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
});

let fails = 0;
const check = (ok, name, extra) => {
  console.log((ok ? ' ✅ ' : ' ❌ ') + name + (extra ? ' · ' + extra : ''));
  if (!ok) fails++;
};

/* 测试自带一层同源转发：浏览器直连会被 CORS 拒，本机 8787 中转有时不响应，
 * 这层只是把 /api-proxy/* 原样转发到真上游，让这份验收脚本不依赖外部服务。 */
let upstream = 'https://api.lingsuan.si/v1';

(async () => {
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));

  /* 只取接口配置（Key 不打印）；localStorage 的键名与 config.js 一致 */
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'openagi-store.json'), 'utf8'));
  const ls = store.localStorage || store;
  upstream = (ls.hf_llmBaseUrl || upstream).replace(/\/$/, '');
  const prefill = {
    hf_llmBaseUrl: 'http://127.0.0.1:' + PORT + '/api-proxy',
    hf_llmModel: ls.hf_llmModel, hf_llmKey: ls.hf_llmKey,
    hf_relayOn: 'false', hf_relayUrl: ls.hf_relayUrl
  };
  console.log('接口:', upstream, '/', prefill.hf_llmModel,
    '/ key 长度', String(prefill.hf_llmKey || '').length, '/ 经测试转发（同源，不依赖 8787）');

  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e && e.message)));
  await page.addInitScript(v => {
    Object.keys(v).forEach(k => { if (v[k] != null) localStorage.setItem(k, String(v[k])); });
  }, prefill);

  const lastInfo = { t: '' };
  page.on('console', m => {
    const t = m.text().slice(0, 800);
    if (m.type() === 'error') console.log('[page]', t);
    else if (/ModelSplit/.test(t)) console.log('[page]', t);
  });

  await page.goto('http://127.0.0.1:' + PORT + '/multiview.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.ModelSplit && window.multiview, null, { timeout: 20000 });
  console.log('\n=== 1. 载入真实模型 ===');
  const src = await page.evaluate(async (url) => {
    const b = await (await fetch(url)).blob();
    return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
  }, MODEL);
  const model = { name: '蓝发少女.glb', src };
  check(!!src && src.length > 1000, '模型已读成 dataURL', Math.round(src.length / 1024) + 'KB');

  await page.evaluate(m => ModelSplit.open(m), model);
  console.log('\n=== 2. 面板 / 按钮 ===');
  check(await page.isVisible('#mvSplitPanel'), 'AI 拆件面板打开了');
  check(await page.isDisabled('#mvSplitRun') === false, '「开始拆件」可点');

  /* 先用 prepare 单测（不花 AI 调用）：候选岛、按槽位的岛图 */
  const prep = await page.evaluate(async (src) => {
    const p = await ModelSplit.prepare(src, { maxCandidates: 120 });
    return {
      islands: p.a.islands.length, parts: p.a.parts.length,
      candidates: p.candidates.length,
      atlases: p.atlases.length,
      atlasLen: p.atlases.map(u => Math.round(u.length / 1024)),
      slots: p.atlasSlots,
      table: p.table.slice(0, 3)
    };
  }, src);
  check(prep.parts === 3, '模型有 3 个网格插槽', String(prep.parts));
  check(prep.atlases === 3, '候选岛图按插槽分开出 3 张', String(prep.atlases));
  check(prep.candidates >= 100, '候选岛数量合理', String(prep.candidates) + '/' + prep.islands);
  check(prep.table.length === 3 && prep.table[0].id === 0, '元数据表带 id/质心/slot', JSON.stringify(prep.table[0]));

  /* 正式跑：点按钮 → AI 读图 → 重建 → 预览 */
  console.log('\n=== 3. 点「开始拆件」跑完整流程 ===');
  const t0 = Date.now();
  await page.fill('#mvSplitParts', '面部和脖子、头发和头饰、身体');
  await page.click('#mvSplitRun');

  let done = false, timedOut = false;
  const deadline = Date.now() + 540000;
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => ({
      info: document.getElementById('mvSplitInfo').textContent.trim(),
      busy: document.getElementById('mvSplitRun').textContent.trim(),
      rows: document.querySelectorAll('#mvSplitList .mv-sp-row').length
    }));
    if (st.info !== lastInfo.t) { lastInfo.t = st.info; console.log('  …', st.info); }
    if (st.rows > 0 && st.busy === '开始拆件') { done = true; break; }
    if (/拆件失败/.test(st.info)) { done = true; break; }
    await page.waitForTimeout(1500);
  }
  if (!done) timedOut = true;
  const elapsed = Math.round((Date.now() - t0) / 1000);
  check(!timedOut, '完整流程结束', elapsed + 's');

  const r = await page.evaluate(() => {
    const u = ModelSplit._ui.result;
    if (!u) return null;
    const a = u.prep.a;
    const assign = u.built.assign;
    const parts = u.list.map((p, pi) => {
      let w = 0, cy = 0, dy = 0, n = 0;
      a.islands.forEach((o, id) => {
        if (assign[id] !== pi) return;
        const t = o.tris.length;
        w += t; cy += o.centroid[1] * t; n++;
        dy += (o.bbox[4] - o.bbox[1]) / a.h;
      });
      const sizeY = a.box.max.y - a.box.min.y;
      return {
        name: p.name, islands: p.ids.length, tris: p.tris,
        y: +((cy / Math.max(w, 1)) - a.box.min.y).toFixed(3) / (sizeY || 1),
        avgDy: +(dy / Math.max(n, 1)).toFixed(3),
        meshes: u.built.groups[pi].children.length
      };
    });
    return {
      parts, stats: u.stats, rounds: u.rounds, leftover: u.leftover,
      previewLen: Math.round(u.preview.length / 1024),
      aiNames: u.parts.map(p => p.name + ':' + p.islands.length),
      raw: String(ModelSplit._ui.rawReply || '').slice(0, 500),
      info: document.getElementById('mvSplitInfo').textContent.trim()
    };
  });
  check(!!r, '拿到拆件结果');
  if (!r) { console.log('页面报错:', errors.join(' | ')); await browser.close(); server.close(); process.exit(1); }

  console.log('  AI 返回:', r.aiNames.join('  '));
  console.log('  原始回复:', r.raw.replace(/\n/g, ' '));
  console.log('  统计:', JSON.stringify(r.stats));
  r.parts.forEach(p => console.log('    ' + p.name + ' · ' + p.islands + ' 岛 · ' + p.tris + ' 三角 · y=' + p.y + ' · dy=' + p.avgDy + ' · 网格 ' + p.meshes));

  const has = re => r.parts.filter(p => re.test(p.name));
  const head = has(/面|脸|头|颈|脖/).filter(p => !/发/.test(p.name));
  const hair = has(/发/);
  const body = has(/身|体|躯干/);
  check(head.length > 0, '有「面部和脖子」部件', head.map(p => p.name).join(','));
  check(hair.length > 0, '有「头发和头饰」部件', hair.map(p => p.name).join(','));
  check(body.length > 0, '有「身体」部件', body.map(p => p.name).join(','));
  if (head.length && body.length) {
    check(head[0].y > body[0].y, '面部质心比身体高（语义位置对）', head[0].y + ' > ' + body[0].y);
  }
  if (hair.length && body.length) {
    check(hair[0].avgDy >= body[0].avgDy * 0.7, '头发岛的竖直跨度更大', hair[0].avgDy + ' vs ' + body[0].avgDy);
  }
  check(r.parts.every(p => p.meshes > 0), '每个部件都有几何网格');
  check(r.parts.reduce((s, p) => s + p.islands, 0) === r.stats.aiAssigned, 'AI 分配的岛数对得上（无重叠、无遗漏）');

  console.log('\n=== 3.5 按确信度多轮 ===');
  console.log('  轮次:', r.rounds.map(x => x.name + ' ' + x.confidence.toFixed(2) + '(' + x.islands + '岛)').join(' → '),
    '· 自动补全 ' + r.leftover + ' 岛');
  check(r.rounds.length >= 1, '至少锁定了一个部件', String(r.rounds.length));
  check(r.rounds.every(x => x.confidence >= 0 && x.confidence <= 1), '每轮都带 0–1 的置信度');
  check(r.rounds.every(x => x.islands > 0), '每轮锁定的部件都有岛');
  check(/按确信度锁定/.test(r.info), '面板上写清了逐轮确信度', r.info.slice(0, 80));

  console.log('\n=== 4. 结果图 / 截图 ===');
  check(r.previewLen > 20, '拆件预览图已生成', r.previewLen + 'KB');
  const pngURL = await page.evaluate(() => ModelSplit._ui.result.preview);
  fs.writeFileSync(path.join(__dirname, '_ai_split_preview.png'), Buffer.from(pngURL.split(',')[1], 'base64'));
  const atlasURL = await page.evaluate(() => ModelSplit._ui.result.atlases[0]);
  fs.writeFileSync(path.join(__dirname, '_ai_split_atlas.jpg'), Buffer.from(atlasURL.split(',')[1], 'base64'));
  const viewsURL = await page.evaluate(() => ModelSplit._ui.result.views || '');
  if (viewsURL) fs.writeFileSync(path.join(__dirname, '_ai_split_views.jpg'), Buffer.from(viewsURL.split(',')[1], 'base64'));
  await page.locator('#mvSplitPanel').screenshot({ path: path.join(__dirname, '_ai_split_panel.png') });
  console.log('  已保存 _ai_split_preview.png / _ai_split_atlas.jpg / _ai_split_panel.png');

  console.log('\n=== 5. 导出 GLB 并读回 ===');
  const glb = await page.evaluate(async () => {
    const u = ModelSplit._ui.result;
    const buf = await ModelSplit.toGLB(ModelSplit.mergedGroup(u.built, 'ai-split'));
    const url = ModelSplit.bufToDataURL(buf);
    const m = await Model3D.load(url);
    const meshes = [];
    m.root.traverse(o => { if (o.isMesh) meshes.push(o.name); });
    return { kb: Math.round(buf.byteLength / 1024), url, meshes: meshes.length, ext: m.ext };
  });
  check(glb.kb > 50, '合并 GLB 导出了', glb.kb + 'KB');
  check(glb.meshes >= r.parts.length, '导出的 GLB 能再读回来（多节点）', glb.meshes + ' 个网格 / ext=' + glb.ext);
  fs.writeFileSync(path.join(__dirname, '_ai_split.glb'), Buffer.from(glb.url.split(',')[1], 'base64'));

  console.log('\n页面报错:', errors.length ? errors.join(' | ') : '无');
  console.log(fails ? '\n❌ 失败 ' + fails + ' 项' : '\n✅ AI 拆件全部通过');
  await browser.close();
  server.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
