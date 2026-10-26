/* 分析 / 生图 / Tripo 生图 / Tripo 3D / 复制 / 设置面板
 * 原 index.html 2433-2766 行
 * 由解耦脚本机械切分，内容与顺序保持原样
 */
// ---- 分析：解读幻觉 + 拟写修复提示词 ----
const ANALYSIS_SYSTEM = `你是图像画面诊断专家，负责诊断"生图幻觉"并拟写修复提示词。

【什么是幻觉】画面中无意义的结构：像某物又不是某物的形体、无意义的图案、一团看不清结构的噪声、破碎的散面与乱连线。

【修复原理】生图模型见过大量真实图像。当你给某块无意义结构一个准确的"名称"，注意力机制就会调出对应的训练数据，把这些像素收敛成有意义的结构。所以修复 = 命名 + 收敛，不是重画。

【铁律】
1. 只处理幻觉区域。画面中已经清晰、合理的部分，一律不要写进提示词。
2. 每个幻觉区域只给一个中性名词（头发、水晶、运动鞋、裙摆、衣领、手指、耳饰）。
3. 禁止任何颜色词（白、黑、红、金、透明……）。
4. 禁止具体款式、风格、材质、装饰细节（连衣裙、高马尾、荷叶边、蕾丝、金属……）。
5. 判断标准：这个词一说出来，脑子里就有具体形象的，就不要用。只给"它本质是什么"。
6. 除命名外，只允许加"收敛 / 不改变"类指令：保持构图、姿态、比例、色彩、光影不变，只在原位置把无意义结构收敛为对应名词；不新增元素、不重画整块区域、不改变原有款式。
7. 若确实看不出某区域是什么，宁可写"该区域结构不清晰，向最接近的同类形体收敛"，不要猜具体物体。
8. 不要建议迭代多轮；一次只修当前可见的幻觉。

【输出格式】只输出 JSON，不要额外解释：
{
  "幻觉区域列表": [{"位置":"画面上方","问题":"破碎散面与乱连线","修正名词":"头发"}],
  "修复提示词": "一段纯中文、可直接用于生图的提示词，只含中性名词与收敛指令",
  "修复思路": "一两句说明这样命名为什么能把噪声收敛、为什么不会引入新形象"
}

修复提示词示例（仅示范语气与粒度）：
"保持整体构图、姿态、比例、色彩与光影不变，只在原位置修复以下结构：画面上方的破碎散面收敛为头发；手中的破碎块收敛为水晶；脚部的乱连线收敛为运动鞋。不要新增元素，不要重画，不要改变原有款式与配色。"`;

async function analyze(){
  if(!currentImageDataURL){ setStatus('请先选择一张原图', 'error'); return; }
  const base = $('llmBaseUrl').value.trim();
  const model = $('llmModel').value.trim();
  const key = $('llmKey').value.trim();
  if(!base || !key || !model){ setStatus('请填写完整的分析 Base URL / Model / API Key', 'error'); return; }

  setButton('btnAnalyze', true, '分析中…');
  try{
    const content = [
      { type: 'text', text: '请分析这张图片中的无意义结构，并按系统要求的 JSON 格式输出。' },
      { type: 'image_url', image_url: { url: currentImageDataURL } }
    ];

    const data = await post(base, key, '/chat/completions', {
      model, messages: [
        { role: 'system', content: ANALYSIS_SYSTEM },
        { role: 'user', content }
      ],
      temperature: 0.4,
      max_tokens: 1500
    });
    const text = data.choices[0].message.content;
    // 提取 JSON
    const m = text.match(/\{[\s\S]*\}/);
    let parsed = {};
    if(m){ try{ parsed = JSON.parse(m[0]); }catch(e){ parsed = { raw: text }; } }

    const failRegions = parsed['幻觉区域列表'] || [];
    currentPrompt = parsed['修复提示词'] || text;

    // 渲染
    let analysisHTML = '';
    if(failRegions.length){
      analysisHTML += '<div style="font-weight:600;margin-bottom:8px;">检测到幻觉区域：</div>';
      failRegions.forEach(r=>{
        analysisHTML += `<div style="background:var(--panel2);border-radius:8px;padding:8px 10px;margin-bottom:6px;">
          <div><b>${r['位置']||''}</b> <span class="badge" style="background:rgba(255,180,84,.15);color:var(--warn);">${r['问题']||''}</span>
          <span class="badge" style="background:rgba(61,214,140,.15);color:var(--ok);margin-left:4px;">修正 → ${r['修正名词']||''}</span></div>
        </div>`;
      });
    } else {
      analysisHTML = parsed['修复思路'] ? '<div class="analysis">' + parsed['修复思路'] + '</div>' : ('<div class="analysis">' + text.replace(/\n/g,'<br>') + '</div>');
    }
    if(parsed['修复思路']) analysisHTML += '<div style="margin-top:10px;" class="hint">' + parsed['修复思路'] + '</div>';

    const ao = $('analysisOut');
    ao.classList.remove('hidden');
    ao.innerHTML = analysisHTML;
    $('analysisEmpty').classList.add('hidden');
    const po = $('promptOut');
    $('promptOutWrap').classList.remove('hidden');
    $('promptEmpty').classList.add('hidden');
    po.value = currentPrompt;
    setStatus('分析完成，已生成修复提示词', 'ok');
  }catch(err){
    setStatus('分析失败：' + friendlyErr(err), 'error');
  }finally{
    setButton('btnAnalyze', false);
  }
}

// ---- 生图 ----
async function generate(){
  if(!currentImageDataURL){ setStatus('请先选择一张原图', 'error'); return; }
  const promptText = $('promptOut').value.trim();
  if(!promptText){ setStatus('提示词为空，请先分析或手动填写', 'error'); return; }
  currentPrompt = promptText;

  const base = ($('imgBaseUrl').value.trim() || $('llmBaseUrl').value.trim()).replace(/\/$/,'');
  const model = ($('imgModel').value.trim() || $('llmModel').value.trim());
  const key = $('imgKey').value.trim() || $('llmKey').value.trim();
  const endpoint = $('imgEndpoint').value.trim();
  if(!base || !model || !key){ setStatus('请填写生图 Base URL / Model / API Key', 'error'); return; }

  setButton('btnGenerate', true, '生图中…');
  try{
    const size = $('imgSize').value.trim() || '1024x1024';
    const useImage = $('sendImage').checked;
    const isEdit = /edit/i.test(endpoint);
    let data;

    if(useImage && isEdit){
      // OpenAI 兼容 /images/edits：必须 multipart/form-data
      const blob = await (await fetch(currentImageDataURL)).blob();
      const fd = new FormData();
      fd.append('model', model);
      fd.append('prompt', currentPrompt);
      fd.append('size', size);
      fd.append('image', blob, 'source.png');
      const res = await apiFetch(base + endpoint, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key },
        body: fd
      });
      if(!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text()).slice(0,300));
      data = await res.json();
    } else {
      const body = { model, prompt: currentPrompt, size };
      if(useImage) body.image = currentImageDataURL.split(',')[1];
      data = await post(base, key, endpoint, body);
    }
    const path = $('respPath').value.trim() || 'data[0].url';

    // 或 b64_json
    let url = lookupPath(data, path);
    let imgEl = '';
    let resultSrc = '';
    if(url){
      resultSrc = url;
      imgEl = `<img src="${url}" style="width:100%;border-radius:10px;border:1px solid var(--border);">`;
    } else {
      const b64json = lookupPath(data, 'data[0].b64_json');
      if(b64json){
        resultSrc = 'data:image/png;base64,' + b64json;
        imgEl = `<img src="${resultSrc}" style="width:100%;border-radius:10px;border:1px solid var(--border);">`;
      } else {
        imgEl = '<div class="placeholder">未找到图片地址。<br>可在「高级设置 → 响应图片字段路径」调整。原始返回：<br><div style="font-size:11px;text-align:left;max-height:150px;overflow:auto;white-space:pre-wrap;">' + JSON.stringify(data).slice(0,500) + '</div></div>';
      }
    }
    if(resultSrc){
      imgEl += `<div class="row" style="margin-top:12px;">
        <button class="btn sm ghost" id="useAsSource">用作下一轮原图</button>
        <a class="btn sm ghost" href="${resultSrc}" download="repair.png">下载</a>
      </div>
      <div class="hint" style="margin-top:8px;">下一轮以本轮结果为起点时，只处理新的局部幻觉；保留原始图作对照，避免噪声在自身结果上反复采样累积。</div>`;
    }
    const rc = $('resultCard');
    rc.style.display = '';
    $('resultImg').innerHTML = imgEl;
    if(resultSrc) bindUseAsSource(resultSrc);
    $('resultImg').scrollIntoView({behavior:'smooth'});
    setStatus('生图完成', 'ok');
  }catch(err){
    setStatus('生图失败：' + friendlyErr(err), 'error');
  }finally{
    setButton('btnGenerate', false);
  }
}

function bindUseAsSource(src){
  $('useAsSource').addEventListener('click', async ()=>{
    try{
      if(src.startsWith('data:')){
        currentImageDataURL = src;
      } else {
        const b = await (await apiFetch(src)).blob();
        currentImageDataURL = await new Promise(r=>{
          const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b);
        });
      }
      ensurePreview();
      $('previewBox').innerHTML = `<img src="${currentImageDataURL}">`;
      $('imgMeta').textContent = '已载入';
      setStatus('已把结果设为下一轮原图', 'ok');
    }catch(e){
      setStatus('无法读取结果图（跨域限制），请手动下载后再上传', 'error');
    }
  });
}

// ---- Tripo 生图 ----
async function generateTripo(){
  if(!currentImageDataURL){ setStatus('请先选择一张原图', 'error'); return; }
  const promptText = $('promptOut').value.trim();
  if(!promptText){ setStatus('提示词为空，请先分析或手动填写', 'error'); return; }
  const model = $('imgModel').value.trim() || 'seedream_v5';

  setButton('btnGenerate', true, '生成中…');
  try{
    setStatus('上传原图到 Tripo…');
    const token = await tripoUpload(currentImageDataURL);
    setStatus('已提交 Tripo 重绘任务…');
    const task = await tripoCall('/generation/image-to-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: token, prompt: promptText, size: '2K', output_format: 'png' })
    });
    const done = await tripoPoll(task.task_id, p => setStatus(`Tripo 重绘中 ${p}%`));
    const src = done.output && done.output.generated_image_url;
    if(!src) throw new Error('任务完成但未返回图片地址');

    $('resultCard').style.display = '';
    $('resultImg').innerHTML = `<img src="${src}" style="width:100%;border-radius:10px;border:1px solid var(--border);">
      <div class="row" style="margin-top:12px;">
        <button class="btn sm ghost" id="useAsSource">用作下一轮原图</button>
        <a class="btn sm ghost" href="${src}" target="_blank" rel="noopener" download="repair.png">下载</a>
      </div>
      <div class="hint" style="margin-top:8px;">下一轮以本轮结果为起点时，只处理新的局部幻觉；保留原始图作对照，避免噪声在自身结果上反复采样累积。</div>`;
    bindUseAsSource(src);
    $('resultImg').scrollIntoView({behavior:'smooth'});
    setStatus('Tripo 修复图已生成', 'ok');
  }catch(err){
    setStatus('Tripo 生图失败：' + friendlyErr(err), 'error');
  }finally{
    setButton('btnGenerate', false);
  }
}

// ---- Tripo 3D 建模 ----
async function generate3D(){
  if(!currentImageDataURL){ setStatus('请先选择一张原图', 'error'); return; }
  const version = $('tripoVersion').value;

  setButton('btnGenerate3D', true, '建模中…');
  try{
    setStatus('上传原图到 Tripo…');
    const token = await tripoUpload(currentImageDataURL);
    setStatus('已提交 Tripo 建模任务…');
    const task = await tripoCall('/generation/image-to-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: version, input: token, texture: true, pbr: true })
    });
    const done = await tripoPoll(task.task_id, p => setStatus(`Tripo 建模中 ${p}%`));
    const out = done.output || {};
    const preview = out.rendered_image_url || '';
    const modelUrl = out.model_url || out.pbr_model || '';

    $('resultCard').style.display = '';
    $('resultImg').innerHTML =
      (preview ? `<img src="${preview}" style="width:100%;border-radius:10px;border:1px solid var(--border);">` : '') +
      `<div class="row" style="margin-top:10px;">
        ${modelUrl ? `<a class="btn sm" href="${modelUrl}" target="_blank" rel="noopener" download="model.glb">下载 GLB</a>` : ''}
        ${modelUrl ? `<button class="btn sm" id="btnPreview3D" type="button">3D 预览</button>` : ''}
        ${modelUrl ? `<button class="btn sm" id="btnQuadViews" type="button">导出四视图</button>` : ''}
        <span class="hint">${version}${done.credits_consumed != null ? ' · 消耗 ' + done.credits_consumed + ' 积分' : ''}</span>
      </div>` +
      (modelUrl ? '' : '<div class="hint" style="margin-top:8px;">任务完成，但未返回模型地址。</div>');
    const pvBtn = $('btnPreview3D');
    if(pvBtn) pvBtn.addEventListener('click', () => {
      if(!window.Model3D || !Model3D.ready()){ setStatus('3D 组件未就绪', 'warn'); return; }
      setStatus('正在加载 3D 模型…');
      Model3D.openPreview(modelUrl, { title: '3D 模型预览' })
        .then(() => setStatus('3D 预览已打开', 'ok'))
        .catch(e => setStatus('3D 预览失败：' + friendlyErr(e), 'error'));
    });
    const qvBtn = $('btnQuadViews');
    if(qvBtn) qvBtn.addEventListener('click', async () => {
      if(!window.Model3D || !Model3D.ready()){ setStatus('3D 组件未就绪', 'warn'); return; }
      qvBtn.disabled = true;
      setStatus('正在渲染四视图…');
      try{
        const url = await Model3D.quadViews(modelUrl, { size: 2048, mode: 'line' });
        const a = document.createElement('a');
        a.href = url; a.download = 'model_quad_views.png'; a.click();
        setStatus('四视图已导出', 'ok');
      }catch(e){ setStatus('四视图导出失败：' + friendlyErr(e), 'error'); }
      finally{ qvBtn.disabled = false; }
    });
    $('resultImg').scrollIntoView({behavior:'smooth'});
    setStatus(modelUrl ? '3D 模型已生成' : '3D 任务完成，但缺少模型地址', modelUrl ? 'ok' : 'warn');
  }catch(err){
    setStatus('Tripo 建模失败：' + friendlyErr(err), 'error');
  }finally{
    setButton('btnGenerate3D', false);
  }
}

function setButton(id, busy, label){
  const b = $(id);
  if(!b.dataset.label) b.dataset.label = b.innerHTML;
  b.disabled = busy;
  b.innerHTML = busy ? `<span class="spin"></span> ${label || ''}` : b.dataset.label;
}

// ---- 复制 ----
$('btnCopy').addEventListener('click', async ()=>{
  const val = $('promptOut').value.trim();
  if(!val){ return; }
  await navigator.clipboard.writeText(val);
  const b = $('btnCopy'); b.textContent = '已复制';
  setTimeout(()=> b.textContent = '复制', 1200);
});

$('btnAnalyze').addEventListener('click', analyze);
$('btnGenerate').addEventListener('click', () => isTripo() ? generateTripo() : generate());
$('btnGenerate3D').addEventListener('click', generate3D);
$('testLLM').addEventListener('click', testLLM);
$('testIMG').addEventListener('click', testIMG);
$('resetKey').addEventListener('click', clearKeys);

// ---- 设置面板 ----
function switchTab(name){
  document.querySelectorAll('.tab').forEach(t => {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== name));
}
function openSettings(tab){
  if(tab) switchTab(tab);
  if(tab === 'image') setTimeout(() => refreshTripoWebStatus(true), 200);
  if(typeof renderGatewayPane === 'function') renderGatewayPane();
  $('settingsBackdrop').classList.remove('hidden');
  $('btnCloseSettings').focus();
}
function closeSettings(){
  $('settingsBackdrop').classList.add('hidden');
  $('btnSettings').focus();
  refreshDeskStates();
}
async function testRelay(){
  $('relayStatus').textContent = '测试中…';
  const issue = relayUrlIssue();          // 地址被填成别的内容时，先说清楚，别只报「未连接」
  const target = relayBase();
  const t0 = performance.now();
  try{
    const res = await fetch(target + '/health');
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if(!d || !d.ok) throw new Error('返回内容异常');
    $('relayStatus').textContent = `中转正常 · ${target} · ${Math.round(performance.now() - t0)}ms`
      + (issue ? '（' + issue + '）' : '');
  }catch(e){
    // Failed to fetch = 请求根本没发出去（服务没开 / 被代理拦 / 地址不对）
    const why = (!e || e instanceof TypeError || /Failed to fetch|NetworkError/i.test(String(e.message)))
      ? '请求发不出去'
      : String(e.message || '未知错误');
    $('relayStatus').textContent = `中转未连接（${why}）· 目标 ${target}。`
      + '请双击 start-relay.bat 启动，或运行 node relay.js'
      + (issue ? '；另外：' + issue : '')
      + '。若开了系统代理，请确认代理放行 127.0.0.1。';
  }
}
$('btnRelayDefault') && $('btnRelayDefault').addEventListener('click', () => {
  $('relayUrl').value = '';
  saveAll();
  $('relayStatus').textContent = '已恢复默认中转地址：' + relayBase() + '。点「测试中转」确认。';
});
$('btnTestRelay').addEventListener('click', testRelay);
$('relayOn').addEventListener('change', () => {
  $('relayStatus').textContent = relayEnabled()
    ? `已启用中转。先运行 node relay.js，再点击测试中转（${relayBase()}）。`
    : '已关闭中转，恢复浏览器直连。';
});
$('btnSettings').addEventListener('click', () => openSettings());
$('btnCloseSettings').addEventListener('click', closeSettings);
$('settingsBackdrop').addEventListener('click', e => { if(e.target === $('settingsBackdrop')) closeSettings(); });
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && !$('settingsBackdrop').classList.contains('hidden')) closeSettings();
});
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
document.querySelectorAll('.status-chip').forEach(c => c.addEventListener('click', () => openSettings(c.dataset.tab)));

