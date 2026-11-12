/* 桌面 AI 对话：对话内生图（计划 → 出图 → 卡片动作）
 *
 * 从 js/desk-chat.js 拆出（2026-11-01），见 desk-chat-core.js 顶部说明。
 * 状态（msgs / genSeq / imgCtrl / genTick 等）与卡片渲染仍在共享作用域里。
 */
/* ==================== 对话内生图 ====================
 * 一条图片消息的生命周期：plan（理解需求 / 改写提示词）→ gen（出图）→ done/error/cancel。
 * 卡片按 msg id 局部替换：阶段变了才重建 DOM，每秒的计时只在原地改一行文字，
 * 否则 <img> 会被反复重建，出图过程中整块区域一直在闪。 */

function imgSourceInfo(){
  if(typeof deskImage === 'undefined' || !deskImage.source){
    return { kind:'none', label:'未加载', ready:false, where:'image', hint:'生图模块（desk-image.js）未加载' };
  }
  return deskImage.source();
}

/* 同上，但会先校准一次「引擎到底在不在跑」。
 * 只在缓存说不 ready 时才真去探（见 desk-image.js 的 dimgCheck），
 * 所以快路径不多等一毫秒，而不会因为开机时的旧快照把能用的引擎判死。 */
async function imgSourceAsync(){
  if(typeof deskImage === 'undefined' || !deskImage.check) return imgSourceInfo();
  try{ return await deskImage.check(); }
  catch(e){ return imgSourceInfo(); }
}

function hasDesk(){ return !!(window.openagiDesktop && typeof window.openagiDesktop.assetPut === 'function'); }

function lockSend(on){
  const b = el('deskAiSend');
  if(b) b.disabled = !!on;
}

function fmtSec(ms){
  const s = Math.max(0, Number(ms) || 0) / 1000;
  return (s >= 10 ? Math.round(s) : Math.round(s * 10) / 10) + 's';
}

/* 重绘强度的四档：0 = 自动（按提示词猜），其余是写死的百分比。
   自动档不能只显示「自动」——用户要的是「这次到底改得狠不狠」，所以把实际值算出来给他看。 */
const DGEN_LEVELS = [0, 0.35, 0.52, 0.7];
function dgenStrengthPct(m){
  const v = Number(m.denoise) || 0;
  if(v) return Math.round(v * 100);
  const auto = (typeof comfyDenoiseFor === 'function') ? comfyDenoiseFor(m.prompt || m.raw || '') : 45;
  return Math.round((Number(auto) || 0.45) * 100);
}
function dgenStrengthLabel(m){
  return '重绘 ' + dgenStrengthPct(m) + '%' + (Number(m.denoise) ? '' : ' · 自动');
}

function genCard(m){
  const running = m.phase === 'plan' || m.phase === 'gen';
  const card = document.createElement('div');
  card.className = 'dgen is-' + (m.phase || 'plan');
  card.dataset.mid = m.id;
  card.dataset.phase = m.phase || 'plan';

  if(m.image){
    const img = document.createElement('img');
    img.className = 'dgen-img';
    img.src = m.image;
    img.alt = m.prompt ? ('生成图：' + m.prompt.slice(0, 40)) : '生成的图片';
    img.draggable = false;
    img.title = '点击放大';
    img.addEventListener('click', () => openViewer(m.image));
    card.appendChild(img);
  }else if(running){
    const sk = document.createElement('div');
    sk.className = 'dgen-skel';
    card.appendChild(sk);
  }

  if(m.ref){
    const ref = document.createElement('div');
    ref.className = 'dgen-ref';
    const im = document.createElement('img');
    im.src = m.ref;
    im.alt = '参考图';
    im.draggable = false;
    const t = document.createElement('span');
    t.textContent = '参考图 · 图生图';
    ref.append(im, t);
    card.appendChild(ref);
  }

  const st = document.createElement('div');
  st.className = 'dgen-st';
  if(running){
    const sp = document.createElement('span');
    sp.className = 'dgen-spin';
    st.appendChild(sp);
  }
  const ph = document.createElement('span');
  ph.className = 'dgen-phase';
  ph.textContent = m.phase === 'done'
    ? ('已出图 · ' + fmtSec(m.ms) + ' · ' + (m.srcLabel || '生图模型'))
    : (m.phase === 'error' ? (m.error || '生成失败')
      : m.phase === 'cancel' ? '已停止'
      : (m.phaseText || '生成中…'));
  st.appendChild(ph);
  if(running){
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'dgen-act stop';
    stop.dataset.act = 'stop';
    stop.dataset.mid = m.id;
    stop.textContent = '停止';
    st.appendChild(stop);
  }
  card.appendChild(st);

  if(m.prompt && (m.phase === 'done' || m.phase === 'error')){
    const p = document.createElement('div');
    p.className = 'dgen-prompt';
    p.textContent = m.prompt;
    p.title = m.prompt;
    card.appendChild(p);
  }
  if(m.trState && (m.phase === 'done' || m.phase === 'error')){
    const h = document.createElement('div');
    h.className = 'dgen-hint' + (m.trState === 'fail' ? ' warn' : '');
    const t = m.tr || {};
    if(m.trState === 'fail'){
      /* 原因必须写出来。原来那句「（语言模型没配好）」把人往设置里带，
         可实测的常见原因是「填了 Ollama 直连地址，被 CORS 拦了」——重填十次也没用。 */
      h.textContent = '本地模型只认英文：这句没译成（' + (t.reason || '原因未知') + '），出图可能和描述无关';
    }else{
      h.textContent = '本地模型只认英文：已自动译成英文再生成'
        + (t.via === 'ollama' ? '（本机 ' + (t.model || 'Ollama') + '）' : '');
    }
    card.appendChild(h);
  }

  if(m.phase === 'done' && m.image){
    const acts = document.createElement('div');
    acts.className = 'dgen-acts';
    const list = [
      ['save', hasDesk() ? '保存到图库' : '保存图片', 'primary'],
      ['down', '下载', ''],
      ['ref', '用作参考图', ''],
      ['again', '再生成', ''],
      ['copy', '复制提示词', '']
    ];
    /* 图生图给一个「重绘强度」开关。
     * 本地这套没有 mask / ControlNet，强度就是唯一的构图约束：
     * 调高了构图会跑、调低了改不动。自动档按提示词猜（换背景 62% / 换风格 52% / 微调 35%），
     * 但猜不准是常态——把旋钮交给用户，比让他反复重试碰运气强。 */
    if(m.ref && /^本地/.test(String(m.srcLabel || ''))){
      list.splice(4, 0, ['denoise', dgenStrengthLabel(m), '']);
    }
    list.forEach(([act, label, cls]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dgen-act' + (cls ? ' ' + cls : '');
      b.dataset.act = act;
      b.dataset.mid = m.id;
      b.textContent = label;
      b.title = act === 'denoise'
        ? (Number(m.denoise)
            ? '当前手动 ' + dgenStrengthPct(m) + '%：越低越像原图、越高改得越狠。点一下切换 自动 → 轻改 35% → 标准 52% → 大改 70%'
            : '自动 ' + dgenStrengthPct(m) + '%（按这句话里的「换背景 / 换风格 / 只微调」猜的）。点一下改成手动')
        : '';
      acts.appendChild(b);
    });
    card.appendChild(acts);
  }else if(m.phase === 'error'){
    const acts = document.createElement('div');
    acts.className = 'dgen-acts';
    [['again', '重试'], ['save', '去设置', '']].forEach(([act, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dgen-act' + (act === 'again' ? ' primary' : '');
      b.dataset.act = act === 'save' ? 'cfg' : act;
      b.dataset.mid = m.id;
      b.textContent = label;
      acts.appendChild(b);
    });
    card.appendChild(acts);
  }
  return card;
}

/* 局部刷新：阶段没变只改文字；阶段变了（plan→gen→done）整卡替换一次 */
function patchGen(m){
  const log = el('deskChatLog');
  if(!log) return;
  const card = log.querySelector('.dgen[data-mid="' + m.id + '"]');
  if(!card){ renderLog(); return; }
  if(card.dataset.phase !== (m.phase || '')){
    card.replaceWith(genCard(m));
    log.scrollTop = log.scrollHeight;
    return;
  }
  const ph = card.querySelector('.dgen-phase');
  if(ph && m.phaseText && ph.textContent !== m.phaseText) ph.textContent = m.phaseText;
}

function openViewer(src){
  let mask = el('dgenView');
  if(!mask){
    mask = document.createElement('div');
    mask.id = 'dgenView';
    mask.className = 'dgen-view hidden';
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-label', '查看大图');
    mask.addEventListener('click', () => mask.classList.add('hidden'));
    document.body.appendChild(mask);
  }
  mask.innerHTML = '';
  const img = document.createElement('img');
  img.src = src;
  img.alt = '生成的图片';
  mask.appendChild(img);
  mask.classList.remove('hidden');
}

function stopTick(){
  if(genTick){ clearInterval(genTick); genTick = 0; }
}

function startTick(m, token){
  stopTick();
  genTick = setInterval(() => {
    if(token !== genSeq || !m) return stopTick();
    if(m.phase !== 'plan' && m.phase !== 'gen') return stopTick();
    const from = m.phase === 'plan' ? (m.p0 || Date.now()) : (m.t0 || Date.now());
    const sec = Math.round((Date.now() - from) / 1000);
    /* 前 6 秒不改文案：提示词正在流式改写时，字数是更有效的信息；
       一直没动静（模型在想 / 排队）才切成读秒，让用户知道没死。 */
    if(sec < 6) return;
    m.phaseText = (m.phase === 'plan' ? '理解需求' : '生成中') + ' · ' + sec + 's';
    patchGen(m);
  }, 1000);
}

async function runGen(m, opts){
  const o = opts || {};
  const token = ++genSeq;
  /* 进锁：计数 + 代次，收尾全部交给函数最外层的 finally。
     中间有 3 处「token 已过期 → 直接 return」的早退，手工在每条路径上补一次收尾，
     正是这套代码最容易漏的地方 —— 漏一处的症状是「一直卡在出图中」，而且看不出谁干的。 */
  const busyTicket = chatBusyEnter();
  try{
    setDot('busy', '出图中…');
    renderImgLabel();          // 来源可能刚在设置里改过，别显示上次的
    m.phase = 'plan';
    m.p0 = Date.now();
    m.phaseText = '理解需求…';
    patchGen(m);
    startTick(m, token);

    let prompt = String(m.prompt || '');
    /* ① 提示词改写：把「一只在雨里的猫」这种口语扩成能画的描述。
       失败不算错——原话照样能生，绝不因为改写不通而让用户拿不到图。 */
    /* ⚠️ 图生图（有参考图）**不改写**。
       改写的目标是「写清主体+动作+环境+光线+材质+镜头+风格+色调」——那是给「从零生成」用的，
       喂给图生图等于把参考图丢掉、照一段全新描述重画：用户明明只说了「把背景换成海边日落」，
       改写却补出整套构图与光线，于是主体挪了位置、姿态也变了（「构图和原图不吻合」的头号原因）。
       改图指令本来就具体，直接翻译比扩写可靠。 */
    if(!o.skipRefine && refineOn && !prompt && !m.ref && canChat()){
      try{
        const sel = el('deskAiModel');
        const conn = connFor(sel ? sel.value : '');
        prompt = await deskImage.refine(m.raw, {
          conn: conn,
          onDelta: acc => {
            if(token !== genSeq) return;
            m.phaseText = '理解需求 · ' + String(acc || '').length + ' 字';
            patchGen(m);
          }
        });
      }catch(e){ prompt = ''; }
    }
    if(token !== genSeq) return;
    if(!prompt) prompt = deskImage.cleanPrompt(m.raw);
    m.prompt = prompt;
    if(!prompt){ m.phase = 'error'; m.error = '没读懂要画什么，换个说法再试一次'; return finishGen(m, token); }

    /* ② 出图 */
    m.phase = 'gen';
    m.t0 = Date.now();
    m.phaseText = '生成中 · 0s';
    patchGen(m);
    startTick(m, token);
    try{
      imgCtrl = new AbortController();
      const r = await deskImage.generate({ prompt: prompt, ref: m.ref, denoise: m.denoise, signal: imgCtrl.signal, timeoutSec: 300 });
      if(token !== genSeq) return;
      m.image = r.src;
      m.ms = r.ms;
      m.phase = 'done';
      /* 本地模型只认英文：provider 会把中文翻成英文再送（SD1.5 的 CLIP 没有中文）。
         翻没翻成要如实告诉用户，否则下次还是「图和描述无关」而不知道为什么。 */
      const tr = (typeof comfyLastLocalize === 'function') ? comfyLastLocalize() : null;
      if(tr && tr.zh === prompt && !tr.skipped && /^本地/.test(String(m.srcLabel || ''))){
        m.trState = tr.ok ? 'ok' : 'fail';
        m.tr = { via: tr.via || '', model: tr.model || '', reason: tr.reason || '' };   // 卡片上要说清「谁翻的 / 为什么没翻成」
      }
      lastImage = r.src;
      /* 轨迹：记的是**真正送进引擎的那句**（可能是改写后的），不是用户原本那句话。
       * 少了这条，「存成流程」就还原不出当时到底用了什么提示词。 */
      traceCap('imageGen', {
        ok: true,
        ms: Number(m.ms) || 0,
        model: (el('imgModel') && el('imgModel').value) || '',
        engine: m.srcLabel || '',
        inputs: { prompt: prompt, ref: m.ref || '', denoise: Number(m.denoise) || 0 },
        outKind: 'image',
        ref: r.src
      });
      setDot('ok', '已出图 · ' + (m.srcLabel || ''));
      /* 在线接口给的是远程地址：后面「把这张再改改」「用作参考图」「保存到图库」
         都要本地能取到像素，后台先转成 dataURL 备好。显示用的 <img> 不动（同一张图）。 */
      if(/^https?:/i.test(String(r.src || ''))){
        deskImage.toDataUrl(r.src).then(u => {
          if(!u) return;
          m.image = u;
          if(lastImage === r.src) lastImage = u;
        }).catch(() => {});
      }
    }catch(e){
      if(token !== genSeq) return;
      m.phase = 'error';
      m.error = (typeof friendlyErr === 'function') ? friendlyErr(e) : String((e && e.message) || e);
      /* 失败的尝试也记：它不会写进流程，但要让「存成流程」知道这一轮有过瑕疵，
       * 别把一次侥幸成功当成稳定做法固化下来。 */
      traceCap('imageGen', {
        ok: false, ms: 0,
        inputs: { prompt: prompt, ref: m.ref || '', denoise: Number(m.denoise) || 0 },
        error: m.error
      });
      setDot('err', '生图失败');
      deskToast('生图失败：' + String(m.error).slice(0, 80));
    }
    return finishGen(m, token);
  }finally{
    chatBusyLeave(busyTicket);
  }
}

function finishGen(m, token){
  if(token !== genSeq) return;
  stopTick();
  imgCtrl = null;
  /* busy / lockSend 不在这里收：那是 runGen 的 finally 的职责（计数器要能嵌套） */
  patchGen(m);
  renderImgLabel();
}

function cancelGen(){
  const m = msgs.slice().reverse().find(x => x.kind === 'image' && (x.phase === 'plan' || x.phase === 'gen'));
  if(!m) return;
  genSeq++;
  if(imgCtrl){ try{ imgCtrl.abort(); }catch(e){} imgCtrl = null; }
  stopTick();
  m.phase = 'cancel';
  m.phaseText = '已停止';
  /* 用户主动叫停：不等在途请求的 finally，直接换代 + 清零。
     换代很关键——那条被放弃的 runGen 稍后仍会走到自己的 finally，
     凭旧代的票它什么都做不了，不会把用户紧接着开的新一轮解开锁。 */
  chatBusyReset();
  setDot('', '已停止');
  patchGen(m);
}

/* 重新生成：新开一条消息而不是覆盖原来的——原图还能留着对比 */
function retryGen(m){
  if(isChatBusy()) return;
  const n = {
    id: ++msgSeq, role:'assistant', kind:'image', content:'',
    raw: m.raw, prompt: m.prompt, ref: m.ref || '', image:'',
    denoise: Number(m.denoise) || 0,      // 保持用户选定的重绘强度
    phase:'plan', phaseText:'重新生成…', ms:0, srcLabel: m.srcLabel
  };
  msgs.push(n);
  renderLog();
  runGen(n, { skipRefine: true });
}

function downloadDataUrl(dataUrl, name){
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function genFileName(m){
  const t = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = '' + t.getFullYear() + p2(t.getMonth() + 1) + p2(t.getDate()) + '-' + p2(t.getHours()) + p2(t.getMinutes()) + p2(t.getSeconds());
  const head = String(m.prompt || '生成图').slice(0, 20).replace(/[\\/:*?"<>|\s，,。]+/g, '-').replace(/^-+|-+$/g, '') || '生成图';
  return head + '-' + stamp + '.png';
}

async function saveImg(m, btn){
  if(!m.image) return;
  const name = genFileName(m);
  const label = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = '保存中…'; }
  try{
    const dataUrl = await deskImage.toDataUrl(m.image);
    if(hasDesk()){
      const r = await window.openagiDesktop.assetPut({ kind:'image', data: dataUrl, name: name, ext:'png', source:'chat' });
      if(!r || !r.ok) throw new Error((r && r.message) || '写入图库失败');
      deskToast('已保存到图库：' + name);
      if(typeof libRefresh === 'function'){ try{ libRefresh(false); }catch(e){} }
    }else{
      downloadDataUrl(dataUrl, name);
      deskToast('已下载：' + name);
    }
  }catch(e){
    deskToast('保存失败：' + String((e && e.message) || e));
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = label || '保存到图库'; }
  }
}

async function downloadImg(m){
  try{
    if(/^data:/i.test(String(m.image || ''))) downloadDataUrl(m.image, genFileName(m));
    else downloadDataUrl(await deskImage.toDataUrl(m.image), genFileName(m));
  }catch(e){ deskToast('下载失败：' + String((e && e.message) || e)); }
}

async function copyText(t){
  try{
    await navigator.clipboard.writeText(String(t || ''));
    deskToast('提示词已复制');
  }catch(e){ deskToast('复制失败：' + String((e && e.message) || e)); }
}

function genAction(act, mid, btn){
  const m = msgs.find(x => String(x.id) === String(mid));
  if(!m) return;
  if(act === 'stop'){ cancelGen(); return; }
  if(act === 'again'){ retryGen(m); return; }
  if(act === 'denoise'){
    /* 循环四档，换一档就按新强度重画一张（不是改当前这张的样式，是重新采样）。 */
    const cur = DGEN_LEVELS.indexOf(Number(m.denoise) || 0);
    m.denoise = DGEN_LEVELS[(cur + 1) % DGEN_LEVELS.length];
    deskToast(m.denoise ? '重绘强度 ' + Math.round(m.denoise * 100) + '%，正在重画' : '重绘强度：自动，正在重画');
    retryGen(m);
    return;
  }
  if(act === 'view'){ if(m.image) openViewer(m.image); return; }
  if(act === 'copy'){ copyText(m.prompt); return; }
  if(act === 'down'){ downloadImg(m); return; }
  if(act === 'save'){ saveImg(m, btn); return; }
  if(act === 'cfg'){
    /* 走到这里说明「刚才判断为不就绪」。缓存可能是旧快照，先校准再决定往哪儿跳，
       否则会出现「引擎明明起来了，还被推去启动引擎」。 */
    imgSourceAsync().then(s => {
      renderImgLabel();
      if(s.ready) return;                      // 已经好了：不用跳，直接让用户再说一次
      if(s.where === 'comfy'){
        deskToast(s.hint || '先在「本地生图」里启动引擎');
        if(typeof openComfyApp === 'function') openComfyApp();
      }else if(typeof openSettings === 'function') openSettings('image');
    }).catch(() => {});
    return;
  }
  if(act === 'ref'){
    if(!m.image) return;
    atts.push(m.image);
    renderAtts();
    deskToast('已加入参考图，接着说想怎么改');
    const input = el('deskAiText');
    if(input) input.focus();
  }
}