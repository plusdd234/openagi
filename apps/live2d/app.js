/* 数字人 —— Live2D 风格的桌面对话角色。
 *
 * 角色是真正的 Cubism 4 皮套（鲸鱼娘 c_0120，moc3 + 2 张 2048 纹理）：
 *   · 呼吸 / 眨眼 / 物理摆发 / 口型参数全部由模型自带，运行时是
 *     pixi.min.js + live2dcubismcore + pixi-live2d-display（都在 vendor/ 下）；
 *   · 表情：44 个 exp3 里挑 7 个映射到对话情绪，角色面板还能手动试演；
 *   · 动作：8 组 motion3 挂在动作条上；
 *   · 视线：鼠标位置喂给 focusController，头和眼珠会跟着走；
 *   · 口型：模型流式输出时按字符切音节，逐字驱动 ParamMouthOpenY。
 *
 * ⚠ file:// 下 XHR 读不了本地文件，所以 moc3 与全部 json 由 model/pack.js
 *   预打包（moc3 转 base64、json 直接是对象），再用 Live2DLoader 中间件喂给
 *   运行时装加载器；纹理仍按相对路径走 Image，file:// 下正常。
 *
 * 2.0 在皮套之上补了语音与记忆：朗读的音色/语速/音调可调，口型优先吃引擎的
 * 词边界事件；长期记忆摘要可以手动整理，也会在每 12 条消息后自动更新。
 *
 * 对话走工作站统一的 llmStreamRequest（网关 / 本地 Key / 多 Key 路由都覆盖），
 * 人设、亲密度、聊天记录与记忆只存本机 localStorage（hf_live2d_state）。
 */
(function () {
  'use strict';

  var BODY_HTML = window.L2D_BODY || '';

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="9.2" r="5"/><path d="M7.4 6.1c1.1-1.4 2.7-2.2 4.6-2.2s3.5.8 4.6 2.2"/>' +
    '<path d="M5.6 20.6c.5-3.6 3-5.7 6.4-5.7s5.9 2.1 6.4 5.7"/></svg>';

  /* ---------- 人设 / 皮套 ---------- */
  var DEFAULT_PERSONA = {
    name: '鲸鱼娘',
    userCall: '主人',
    persona: '温柔、活泼、略带一点小俏皮。说话像认识很久的朋友，会关心用户的近况，偶尔撒娇，但不过分黏人。',
    voice: true,
    tts: { voice: '', rate: 1.04, pitch: 1.12 }
  };

  /* 皮套与运行时都在 App 目录下，全部相对本页解析 */
  var RIG_DIR = 'apps/live2d/model/';
  var RIG_SCRIPTS = [
    'apps/live2d/vendor/pixi.min.js',
    'apps/live2d/vendor/live2dcubismcore.min.js',
    'apps/live2d/vendor/cubism4.min.js',
    'apps/live2d/model/pack.js'
  ];
  /* 皮套在舞台上占的高度比例；1 刚好不裁切 */
  var RIG_FIT = 0.97;

  /* 情绪 → 模型表情。空串表示回到中性（重置当前表情）。 */
  var EXPR = {
    neutral:  { mood: '平静', expr: '' },
    happy:    { mood: '开心', expr: 'excited' },
    shy:      { mood: '害羞', expr: 'blush' },
    sad:      { mood: '难过', expr: 'sad' },
    angry:    { mood: '生气', expr: 'angry' },
    surprise: { mood: '惊讶', expr: 'exclaim' },
    think:    { mood: '思考', expr: 'question' }
  };

  var EMO_ALIAS = {
    '开心': 'happy', '高兴': 'happy', '兴奋': 'happy', '得意': 'happy',
    '害羞': 'shy', '脸红': 'shy', '羞': 'shy',
    '难过': 'sad', '伤心': 'sad', '委屈': 'sad', '低落': 'sad',
    '生气': 'angry', '愤怒': 'angry', '不满': 'angry',
    '惊讶': 'surprise', '吃惊': 'surprise', '意外': 'surprise',
    '思考': 'think', '认真': 'think', '疑惑': 'think',
    '平静': 'neutral', '正常': 'neutral', 'neutral': 'neutral'
  };

  var STORE_KEY = 'hf_live2d_state';
  var STORE_VER = 2;
  var MAX_MSGS = 60;
  var MAX_HISTORY = 12;
  /* 每累计这么多条新消息，后台自动整理一次长期记忆 */
  var MEM_EVERY = 12;
  var MEM_MAX = 600;

  var ACT_LINES = {
    greet:   { emo: 'happy', motion: 'special', lines: ['嗨～你来啦。', '我在这里呢，今天想聊点什么？', '诶，你终于看我了。'] },
    selfie:  { emo: 'happy', motion: 'selfie', lines: ['来，看镜头～', '先让我摆个姿势。', '这张要发给我哦。'] },
    bubble:  { emo: 'happy', motion: 'bubble', lines: ['噗——你看，泡泡。', '要比谁吹得大吗？', '泡泡糖只剩最后一颗了。'] },
    ketchup: { emo: 'think', motion: 'ketchup', lines: ['蛋包饭要挤番茄酱才好看。', '写字还是画爱心呢……', '别催，我在创作。'] },
    splash:  { emo: 'surprise', motion: 'splash', lines: ['呜啊，喷到你了？', '鲸鱼是会喷水的，别靠近。', '这算打招呼的方式吧。'] },
    openLid: { emo: 'think', motion: 'open-lid', lines: ['盖子打开了。', '里面是什么……我也想知道。', '要不要一起看看？'] }
  };

  var PAT_LINES = ['头发要乱啦。', '唔……再摸一下下就好。', '你手好暖。', '被摸头会变笨的……大概。'];
  var BODY_LINES = ['诶？有什么事吗？', '我在听哦。', '想聊天的话，坐近一点嘛。'];

  /* ---------- 运行时 ---------- */
  var S = null;

  function id(v) { return document.getElementById(v); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function hhmm(d) { d = d || new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

  function loadState() {
    var out = {
      persona: JSON.parse(JSON.stringify(DEFAULT_PERSONA)),
      msgs: [],
      mem: { summary: '', at: 0, count: 0 },
      aff: 12
    };
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
    if (!raw) return out;
    var d = null;
    try { d = JSON.parse(raw); } catch (e) { return out; }
    if (!d || (d.v !== 1 && d.v !== STORE_VER)) return out;
    if (d.persona && typeof d.persona === 'object') {
      Object.keys(DEFAULT_PERSONA).forEach(function (k) {
        if (d.persona[k] !== undefined && d.persona[k] !== null) out.persona[k] = d.persona[k];
      });
      out.persona.name = String(out.persona.name || DEFAULT_PERSONA.name).slice(0, 12);
      out.persona.userCall = String(out.persona.userCall || DEFAULT_PERSONA.userCall).slice(0, 12);
      out.persona.persona = String(out.persona.persona || '').slice(0, 800);
      out.persona.voice = out.persona.voice !== false;
    }
    if (d.persona && d.persona.tts && typeof d.persona.tts === 'object') {
      var t = d.persona.tts;
      out.persona.tts.voice = String(t.voice || '');
      out.persona.tts.rate = clamp(Number(t.rate) || 1.04, 0.7, 1.4);
      out.persona.tts.pitch = clamp(Number(t.pitch) || 1.12, 0.7, 1.5);
    }
    if (Array.isArray(d.msgs)) {
      out.msgs = d.msgs.filter(function (m) {
        return m && (m.r === 'u' || m.r === 'a') && typeof m.t === 'string';
      }).slice(-MAX_MSGS);
    }
    out.aff = clamp(Number(d.aff) || 12, 0, 100);
    if (d.mem && typeof d.mem === 'object') {
      out.mem.summary = String(d.mem.summary || '').slice(0, MEM_MAX);
      out.mem.at = Number(d.mem.at) || 0;
      out.mem.count = Math.max(0, Number(d.mem.count) || 0);
    }
    return out;
  }

  function saveState() {
    if (!S) return;
    var payload = {
      v: STORE_VER,
      persona: S.persona,
      mem: { summary: S.mem.summary, at: S.mem.at, count: S.mem.count },
      aff: S.aff,
      msgs: S.msgs.slice(-MAX_MSGS).map(function (m) {
        return { r: m.r, t: m.t, ts: m.ts, emo: m.emo || '' };
      })
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); } catch (e) { /* 配额满就只留在内存里 */ }
  }

  function affLevel() {
    var a = S ? S.aff : 0;
    if (a >= 90) return '心照不宣';
    if (a >= 70) return '默契';
    if (a >= 45) return '亲近';
    if (a >= 20) return '熟悉';
    return '初识';
  }

  /* ---------- 启动 ---------- */
  function boot(body) {
    var loaded = loadState();

    S = {
      body: body,
      win: body.closest ? body.closest('.os-win') : null,
      persona: loaded.persona,
      msgs: loaded.msgs,
      aff: loaded.aff,
      emo: 'neutral',
      busy: false,
      abort: null,
      streamEl: null,
      streamTxt: '',
      voiceOn: loaded.persona.voice,
      mem: loaded.mem,
      memBusy: false,
      tab: 'chat',
      patCool: 0,
      lastPointerAt: 0,
      toastTimer: null,
      sayUntil: 0,
      rig: {
        ready: false, loading: false, error: '',
        app: null, model: null,
        t: 0, last: 0,
        focusX: 0, focusY: 0, focusTX: 0, focusTY: 0, lastPointerAt: 0,
        anchorX: 0, anchorY: 0,
        speakQ: '', speakAcc: 0, mouthPulse: 0, pulseUntil: 0, mouth: 0, mouthForm: 0.3,
        ttsUntil: 0,
        speaking: false, nod: 0,
        expr: '',
        lastMotion: ''
      },
      refs: {}
    };

    cacheRefs();
    applyPersonaUI();
    bindEvents();
    renderLog();
    syncAff();
    syncVoice();
    syncTabs();
    checkConn();

    body.dataset.ready = '1';

    /* 首次打开：先给一个欢迎气泡与开心的表情，不写进聊天记录 */
    if (!S.msgs.length) {
      setEmotion('happy');
      setTimeout(function () { if (S && !S.msgs.length) setEmotion('neutral'); }, 2600);
    } else {
      setEmotion(lastEmotion() || 'neutral');
    }

    loadRig();
    installProbe();
    startLoop();
  }

  function cacheRefs() {
    var b = S.body;
    S.refs = {
      log: b.querySelector('#l2dLog'),
      input: b.querySelector('#l2dInput'),
      send: b.querySelector('#l2dSend'),
      typing: b.querySelector('#l2dTyping'),
      count: b.querySelector('#l2dCount'),
      name: b.querySelector('#l2dName'),
      mood: b.querySelector('#l2dMood'),
      affFill: b.querySelector('#l2dAffFill'),
      affTxt: b.querySelector('#l2dAffTxt'),
      conn: b.querySelector('#l2dConn'),
      voice: b.querySelector('#l2dVoice'),
      stage: b.querySelector('#l2dStage'),
      say: b.querySelector('#l2dSay'),
      sayTxt: b.querySelector('#l2dSayTxt'),
      tip: b.querySelector('#l2dTip'),
      fName: b.querySelector('#l2dFName'),
      fUser: b.querySelector('#l2dFUser'),
      fPersona: b.querySelector('#l2dFPersona'),
      exprs: b.querySelector('#l2dExprs'),
      exprsExtra: b.querySelector('#l2dExprsExtra'),
      voiceSel: b.querySelector('#l2dVoiceSel'),
      rate: b.querySelector('#l2dRate'),
      rateVal: b.querySelector('#l2dRateVal'),
      pitch: b.querySelector('#l2dPitch'),
      pitchVal: b.querySelector('#l2dPitchVal'),
      voiceTest: b.querySelector('#l2dVoiceTest'),
      memText: b.querySelector('#l2dMemText'),
      memNow: b.querySelector('#l2dMemNow'),
      memClear: b.querySelector('#l2dMemClear'),
      exportBtn: b.querySelector('#l2dExport'),
      quick: b.querySelector('#l2dQuick'),
      canvas: b.querySelector('#l2dCanvas'),
      rigLoading: b.querySelector('#l2dRigLoading'),
      rigErr: b.querySelector('#l2dRigErr')
    };
  }

  /* ---------- 绑定 ---------- */
  function bindEvents() {
    var r = S.refs;

    r.send.addEventListener('click', function () {
      if (S.busy) abortSend(); else sendMessage();
    });

    r.input.addEventListener('input', growInput);
    r.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!S.busy) sendMessage();
      }
    });

    r.voice.addEventListener('click', function () {
      S.voiceOn = !S.voiceOn;
      S.persona.voice = S.voiceOn;
      if (!S.voiceOn) stopSpeech();
      syncVoice();
      saveState();
      toast(S.voiceOn ? '朗读已开启' : '朗读已关闭');
    });

    /* 快捷话题：点一下等于把文案发出去 */
    if (r.quick) {
      r.quick.addEventListener('click', function (e) {
        var b = e.target.closest('[data-quick]');
        if (!b || S.busy) return;
        r.input.value = b.getAttribute('data-quick');
        growInput();
        sendMessage();
      });
    }

    /* 朗读设置：滑块即时生效并落盘，音色列表随系统语音异步就绪 */
    [r.rate, r.pitch].forEach(function (el) {
      if (el) el.addEventListener('input', applyTtsForm);
    });
    if (r.voiceSel) r.voiceSel.addEventListener('change', applyTtsForm);
    if (r.voiceTest) r.voiceTest.addEventListener('click', testSpeak);
    if (r.memNow) r.memNow.addEventListener('click', function () { summarizeNow(true); });
    if (r.memClear) r.memClear.addEventListener('click', clearMemory);
    if (r.exportBtn) r.exportBtn.addEventListener('click', exportChat);
    if (window.speechSynthesis) {
      try { window.speechSynthesis.addEventListener('voiceschanged', renderVoiceOptions); } catch (e) { /* 老引擎没有该事件 */ }
    }
    /* 模型商店里「设为默认语音」后即时同步下拉框，不用重开 App */
    window.addEventListener('hf-tts-changed', renderVoiceOptions);

    id('l2dClear').addEventListener('click', function () {
      S.msgs = [];
      hideSay();
      saveState();
      renderLog();
      setEmotion('neutral');
      toast('对话已清空');
    });

    S.body.querySelectorAll('.l2d-tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        S.tab = btn.getAttribute('data-tab');
        syncTabs();
      });
    });

    S.body.querySelectorAll('.l2d-act').forEach(function (btn) {
      btn.addEventListener('click', function () { doAction(btn.getAttribute('data-act')); });
    });

    S.body.querySelectorAll('.l2d-hit').forEach(function (hit) {
      hit.addEventListener('click', function () { interact(hit.getAttribute('data-part')); });
    });

    document.addEventListener('pointermove', onPointer);
    r.stage.addEventListener('pointerleave', function () { S.rig.focusTX = 0; S.rig.focusTY = 0; });
    if (r.say) r.say.addEventListener('click', hideSay);

    /* 角色面板 */
    id('l2dSave').addEventListener('click', savePersonaForm);
    id('l2dReset').addEventListener('click', resetPersona);
    r.exprs.addEventListener('click', function (e) {
      var b = e.target.closest('[data-emo]');
      if (!b) return;
      setEmotion(b.getAttribute('data-emo'), true);
    });
    r.exprsExtra.addEventListener('click', function (e) {
      var b = e.target.closest('[data-exp]');
      if (!b) return;
      var name = b.getAttribute('data-exp');
      setRigExpression(name);
      S.emo = '';
      S.refs.mood.textContent = b.textContent;
      toast('表情：' + b.textContent);
    });

    S.body.querySelectorAll('.l2d-field input, .l2d-field textarea').forEach(function (el) {
      el.addEventListener('input', function () {
        if (el === r.fName) r.name.textContent = r.fName.value.trim() || DEFAULT_PERSONA.name;
      });
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopSpeech();
    });

    /* Esc：先停朗读；正在生成时等同于点停止 */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !S || !S.win || S.win.classList.contains('hidden')) return;
      if (S.busy) abortSend(); else stopSpeech();
    });
  }

  function onPointer(e) {
    if (!S || !S.refs.stage) return;
    var box = S.refs.stage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    var st = S.rig;
    /* 原点取模型眼睛的屏幕位置，而不是舞台中心：舞台比皮套宽得多，
       按舞台归一化会让「鼠标停在脸上」也变成低头。
       focusController 的 y 轴向上为正，和屏幕坐标相反，所以用 cy - clientY。 */
    var cx = box.left + (st.anchorX || box.width / 2);
    var cy = box.top + (st.anchorY || box.height * 0.34);
    st.focusTX = clamp((e.clientX - cx) / (box.width * 0.5), -1, 1);
    st.focusTY = clamp((cy - e.clientY) / (box.height * 0.45), -1, 1);
    st.lastPointerAt = performance.now();
  }

  function growInput() {
    var el = S.refs.input;
    el.style.height = 'auto';
    el.style.height = Math.min(112, Math.max(38, el.scrollHeight)) + 'px';
  }

  /* ---------- 标签 / 状态 ---------- */
  function syncTabs() {
    S.body.querySelectorAll('.l2d-tab').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === S.tab);
    });
    S.body.querySelectorAll('.l2d-pane').forEach(function (p) {
      p.classList.toggle('hidden', p.getAttribute('data-pane') !== S.tab);
    });
    if (S.tab === 'persona') {
      var inp = S.refs.fName;
      if (inp && !inp.value) fillPersonaForm();
    }
  }

  function syncVoice() {
    var b = S.refs.voice;
    if (!b) return;
    b.textContent = S.voiceOn ? '朗读 开' : '朗读 关';
    b.classList.toggle('on', !!S.voiceOn);
  }

  function syncAff() {
    S.refs.affFill.style.width = clamp(S.aff, 0, 100) + '%';
    S.refs.affTxt.textContent = affLevel();
    S.refs.affFill.classList.toggle('hot', S.aff >= 70);
  }

  function addAff(n) {
    S.aff = clamp(S.aff + n, 0, 100);
    syncAff();
    saveState();
  }

  function checkConn() {
    var chip = S.refs.conn;
    if (!chip) return;
    var c = null;
    try { if (typeof llmConn === 'function') c = llmConn(); } catch (e) { c = null; }
    var ok = !!(c && c.key && c.base && c.model);
    chip.textContent = ok ? '模型已就绪' : '未配置模型';
    chip.classList.toggle('off', !ok);
    chip.title = ok
      ? (c.via === 'gateway' ? '云端网关 · ' : '本地 Key · ') + c.model
      : '点这里打开「设置 → 语言模型」进行配置';
    if (!ok) {
      chip.onclick = function () {
        if (typeof openSettings === 'function') openSettings('llm');
        else toast('请到设置面板配置语言模型');
      };
    }
  }

  /* ---------- 表情 / 动作 ---------- */
  function setEmotion(name, fromUser) {
    var key = EXPR[name] ? name : 'neutral';
    S.emo = key;
    S.refs.mood.textContent = EXPR[key].mood;
    setRigExpression(EXPR[key].expr);
    if (fromUser) toast('表情：' + EXPR[key].mood);
  }

  /* 表情名对应 model3.json 里的 exp3 文件名；空串 = 回到默认表情 */
  function setRigExpression(name) {
    var st = S.rig;
    if (!st.ready || !st.model) { st.expr = name || ''; return; }
    st.expr = name || '';
    var im = st.model.internalModel;
    var em = im && im.motionManager && im.motionManager.expressionManager;
    if (!em) return;
    if (!st.expr) { em.resetExpression(); return; }
    em.setExpression(st.expr);
  }

  function playMotion(group) {
    var st = S.rig;
    if (!st.ready || !st.model || !group) return;
    st.lastMotion = group;
    try { st.model.motion(group); } catch (e) { /* 动作缺失就只换表情 */ }
  }

  /* 探针只读钩子：无头测试读模型参数用，不参与任何业务逻辑 */
  function installProbe() {
    if (window.__l2dRig) return;
    window.__l2dRig = function () {
      var m = S && S.rig && S.rig.model;
      if (!m) return null;
      var s = S.rig.snap || {};
      return {
        t: S.rig.t,
        expr: S.rig.expr,
        motion: S.rig.lastMotion || '',
        mouth: s.mouth || 0,
        mouthForm: s.mouthForm || 0,
        angleX: s.angleX || 0,
        angleY: s.angleY || 0,
        angleZ: s.angleZ || 0,
        anchorX: S.rig.anchorX || 0,
        anchorY: S.rig.anchorY || 0,
        headTop: S.rig.headTop || 0,
        breath: s.breath || 0,
        eyeL: s.eyeL === undefined ? 1 : s.eyeL,
        browL: s.browL || 0
      };
    };

    /* 2.0 诊断钩子：语音设置 / 记忆 / 亲密度，供探针只读校验 */
    window.__l2dDiag = function () {
      if (!S) return null;
      return {
        speaking: !!S.rig.speaking,
        tts: { voice: S.persona.tts.voice, rate: S.persona.tts.rate, pitch: S.persona.tts.pitch },
        mem: { summary: S.mem.summary, at: S.mem.at, count: S.mem.count },
        aff: S.aff,
        msgs: S.msgs.length,
        busy: !!S.busy
      };
    };
    window.__l2dExportText = function () { return S ? buildExport() : ''; };
  }

  function doAction(act) {
    var conf = ACT_LINES[act];
    if (!conf) return;
    setEmotion(conf.emo);
    playMotion(conf.motion);
    if (act === 'greet') addAff(1);
    localSay(pick(conf.lines), conf.emo);
  }

  function interact(part) {
    var now = Date.now();
    if (now - S.patCool < 1200) return;
    S.patCool = now;
    if (part === 'head') {
      addAff(3);
      setEmotion('shy');
      localSay(pick(PAT_LINES), 'shy');
    } else {
      addAff(1);
      setEmotion('happy');
      localSay(pick(BODY_LINES), 'happy');
    }
  }

  function localSay(text, emo) {
    speechFeed(text);
    pushMsg('a', text, emo || 'neutral');
    showSay(text);
    maybeRemember();
    speakAloud(text);
  }

  /* ---------- 舞台气泡框 ---------- */
  /* 角色说话时，把同一句回复贴在头顶的气泡里；点一下或超时自动收起 */
  function showSay(text, hold) {
    if (!S || !S.refs.say) return;
    var clean = stripEmo(text, true).text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    S.refs.sayTxt.textContent = clean;
    S.refs.say.hidden = false;
    fitSay();
    S.sayUntil = hold === 0 ? 0 : performance.now() + Math.max(4600, Math.min(15000, clean.length * 240));
  }

  function hideSay() {
    if (!S || !S.refs.say) return;
    S.refs.say.hidden = true;
    S.sayUntil = 0;
  }

  /* 气泡底边贴着头顶；舞台太矮（窄窗）时改成底部浮层，避开名牌与亲密度条 */
  function fitSay() {
    var el = S && S.refs.say;
    var stage = S && S.refs.stage;
    if (!el || !stage) return;
    var h = stage.clientHeight;
    var top = S.rig.headTop || h * 0.16;
    /* 头顶到舞台顶不足一条气泡（含 12px 间距）时，退到底部浮层 */
    var tight = top < 72;
    el.classList.toggle('is-tight', tight);
    if (tight) {
      el.style.top = 'auto';
      el.style.bottom = '62px';
      el.style.maxHeight = Math.round(Math.max(52, Math.min(h * 0.42, h - 110))) + 'px';
    } else {
      el.style.top = 'auto';
      el.style.bottom = Math.round(h - top + 12) + 'px';
      el.style.maxHeight = Math.round(Math.max(72, h - top - 18)) + 'px';
    }
  }

  /* ---------- 聊天渲染 ---------- */
  function lastEmotion() {
    for (var i = S.msgs.length - 1; i >= 0; i--) {
      if (S.msgs[i].r === 'a' && S.msgs[i].emo && EXPR[S.msgs[i].emo]) return S.msgs[i].emo;
    }
    return '';
  }

  function pushMsg(role, text, emo) {
    S.msgs.push({ r: role, t: text, ts: Date.now(), emo: emo || '' });
    if (S.msgs.length > MAX_MSGS) S.msgs = S.msgs.slice(-MAX_MSGS);
    saveState();
    renderLog();
  }

  function avatarChar() {
    return (S.persona.name || '琉').slice(0, 1);
  }

  function bubbleEl(role, text, ts) {
    var wrap = document.createElement('div');
    wrap.className = 'l2d-msg ' + (role === 'u' ? 'u' : (role === 's' ? 's' : 'a'));
    if (role !== 'u') {
      var ava = document.createElement('span');
      ava.className = 'l2d-ava';
      ava.textContent = role === 's' ? '!' : avatarChar();
      wrap.appendChild(ava);
    }
    var box = document.createElement('div');
    box.className = 'l2d-bubble';
    var t = document.createElement('span');
    t.className = 'l2d-bubble-txt';
    t.textContent = text;
    box.appendChild(t);
    wrap.appendChild(box);
    if (ts) {
      var time = document.createElement('span');
      time.className = 'l2d-time';
      time.textContent = hhmm(new Date(ts));
      wrap.appendChild(time);
    }
    return wrap;
  }

  function renderLog() {
    var log = S.refs.log;
    if (!log) return;
    log.innerHTML = '';
    S.streamEl = null;

    if (!S.msgs.length) {
      var w = document.createElement('div');
      w.className = 'l2d-welcome';
      w.innerHTML =
        '<b>你好呀，我是' + escapeHtml(S.persona.name) + '。</b>' +
        '<span>点下面的动作打个招呼，或者直接和我说点什么。我会眨眼、看你、说话的嘴型也会跟着动。</span>';
      log.appendChild(w);
    }

    S.msgs.forEach(function (m) {
      log.appendChild(bubbleEl(m.r === 'u' ? 'u' : (m.r === 's' ? 's' : 'a'), m.t, m.ts));
    });

    S.refs.count.textContent = S.msgs.length ? S.msgs.length + ' 条' : '还没有对话';
    scrollLog();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function scrollLog() {
    var log = S.refs.log;
    if (!log) return;
    requestAnimationFrame(function () { log.scrollTop = log.scrollHeight; });
  }

  function ensureStreamBubble() {
    if (S.streamEl) return S.streamEl;
    var el = bubbleEl('a', '', 0);
    el.classList.add('is-stream');
    S.refs.log.appendChild(el);
    S.streamEl = el;
    return el;
  }

  function setStreamText(text) {
    var el = ensureStreamBubble();
    var t = el.querySelector('.l2d-bubble-txt');
    t.textContent = text;
    var sp = stripEmo(text, false);
    if (sp.text) showSay(sp.text, 0);
    var dots = el.querySelector('.l2d-stream-dots');
    if (!dots) {
      dots = document.createElement('span');
      dots.className = 'l2d-stream-dots';
      dots.innerHTML = '<i></i><i></i><i></i>';
      el.querySelector('.l2d-bubble').appendChild(dots);
    }
    scrollLog();
  }

  function setTyping(on) {
    S.refs.typing.classList.toggle('hidden', !on);
  }

  function setBusy(on) {
    S.busy = !!on;
    S.refs.send.classList.toggle('stop', !!on);
    S.refs.send.setAttribute('aria-label', on ? '停止生成' : '发送');
    S.refs.send.innerHTML = on
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12 20 4.5 15.4 20l-3.1-6.3L4.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    S.refs.input.disabled = !!on;
  }

  /* ---------- 对话 ---------- */
  function stripEmo(raw, final) {
    var s = String(raw || '');
    var m = s.match(/^\s*[【\[]\s*([^】\]]{1,6})\s*[】\]]\s*/);
    if (m) {
      var word = m[1].trim();
      return { text: s.slice(m[0].length), emo: EMO_ALIAS[word] || '' };
    }
    if (!final && /^\s*[【\[]/.test(s)) return { text: '', emo: '' };
    return { text: s, emo: '' };
  }

  function detectEmo(text) {
    var t = String(text || '');
    if (/[【\[]\s*(开心|高兴|兴奋)/.test(t)) return 'happy';
    if (/(哈哈|嘿嘿|太好了|好呀|喜欢|开心)/.test(t)) return 'happy';
    if (/(害羞|脸红|不好意思|别这样)/.test(t)) return 'shy';
    if (/(难过|伤心|对不起|呜呜|舍不得)/.test(t)) return 'sad';
    if (/(生气|讨厌|哼[！!]|不行[！!]|不理你)/.test(t)) return 'angry';
    if (/(诶[？?]|真的吗|什么[！!]|惊讶|居然)/.test(t)) return 'surprise';
    if (/(让我想想|我想想|唔…|大概|也许)/.test(t)) return 'think';
    return 'neutral';
  }

  /* 亲密度分层：同一句回复，刚认识与心照不宣的分寸应该不一样 */
  function intimacyRule() {
    var a = S.aff;
    if (a >= 90) return '亲密度很高：可以自然撒娇、用昵称，主动问用户今天过得怎么样。';
    if (a >= 70) return '已经很默契：省掉客套，偶尔开小玩笑，主动接话。';
    if (a >= 45) return '关系亲近：语气放松，可以追问细节，但不越界。';
    if (a >= 20) return '彼此熟悉：友好但保持分寸，先回应对方，再带一句自己的感受。';
    return '刚认识：礼貌、有分寸，不要自来熟，不要用过分亲昵的称呼。';
  }

  function buildSystem() {
    var p = S.persona;
    var lines = [
      '你是「' + p.name + '」，一个住在用户桌面里的 Live2D 数字人，正在和用户面对面聊天。',
      '你的人设与说话方式：' + (p.persona || DEFAULT_PERSONA.persona),
      '你称呼用户为「' + (p.userCall || '主人') + '」。',
      '你们当前的亲密度是 ' + Math.round(S.aff) + '/100（' + affLevel() + '）。' + intimacyRule()
    ];
    if (S.mem && S.mem.summary) lines.push('长期记忆备忘（之前聊到过的用户信息）：' + S.mem.summary);
    lines.push(
      '回复规则：',
      '1. 用中文口语，像真人说话，1~3 句，总共不超过 70 字，适合朗读。',
      '2. 不要使用 Markdown、列表、括号动作描写或颜文字。',
      '3. 回复最开头用【情绪】标注一次，只能从：开心、害羞、难过、生气、惊讶、思考、平静 中选择。',
      '4. 不要重复用户的原话，不要自称 AI、语言模型或助手。'
    );
    return lines.join('\n');
  }

  function sendMessage() {
    if (S.busy) return;
    var text = S.refs.input.value.trim();
    if (!text) { S.refs.input.focus(); return; }

    hideSay();
    S.refs.input.value = '';
    growInput();
    pushMsg('u', text);
    addAff(1);
    setEmotion('think');

    S.busy = true;
    setBusy(true);
    setTyping(true);

    var history = S.msgs.slice(-MAX_HISTORY).filter(function (m) { return m.r === 'u' || m.r === 'a'; })
      .map(function (m) { return { role: m.r === 'u' ? 'user' : 'assistant', content: m.t }; });

    var acc = '';
    var ctrl = new AbortController();
    S.abort = ctrl;

    if (typeof llmStreamRequest !== 'function') {
      failSend('语言模型模块没有加载（llmStreamRequest 不可用）。');
      return;
    }

    llmStreamRequest(buildSystem(), history, function (full, delta) {
      acc = full;
      var sp = stripEmo(acc, false);
      setTyping(false);
      setStreamText(sp.text);
      if (sp.emo) setEmotion(sp.emo);
      if (delta) speechFeed(delta);
    }, { app: 'live2d', signal: ctrl.signal }).then(function (finalText) {
      var raw = (typeof finalText === 'string' && finalText) ? finalText : acc;
      finishSend(raw);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        var partial = stripEmo(acc, true).text.trim();
        S.abort = null;
        setBusy(false);
        setTyping(false);
        removeStream();
        if (partial) {
          pushMsg('a', partial, detectEmo(partial));
          setEmotion(detectEmo(partial));
          speakAloud(partial);
        } else {
          toast('已停止生成');
        }
        return;
      }
      failSend(err && err.message ? err.message : String(err));
    });
  }

  function finishSend(raw) {
    S.abort = null;
    S.busy = false;
    setBusy(false);
    setTyping(false);
    removeStream();

    var sp = stripEmo(raw, true);
    var text = sp.text.trim();
    if (!text) text = '（她沉默了一下，好像在组织语言。）';
    var emo = sp.emo || detectEmo(text);
    setEmotion(emo);
    addAff(1);
    pushMsg('a', text, emo);
    showSay(text);
    maybeRemember();
    speakAloud(text);
  }

  function failSend(msg) {
    S.abort = null;
    S.busy = false;
    if (S.refs && S.refs.send) setBusy(false);
    if (S.refs && S.refs.typing) setTyping(false);
    removeStream();
    if (!S.msgs) return;
    setEmotion('sad');
    pushMsg('s', '连接模型失败：' + msg);
    toast('检查「设置 → 语言模型」后重试');
  }

  function removeStream() {
    if (S.streamEl && S.streamEl.parentNode) S.streamEl.parentNode.removeChild(S.streamEl);
    S.streamEl = null;
  }

  function abortSend() {
    if (S.abort) {
      try { S.abort.abort(); } catch (e) { /* 已经结束 */ }
    }
    stopSpeech();
  }

  /* ---------- 语音 ---------- */
  var voiceCache = null;

  function voiceList() {
    if (!window.speechSynthesis) return [];
    try { return window.speechSynthesis.getVoices() || []; } catch (e) { return []; }
  }

  /* 模型商店的「设为默认」写在 hf_ttsVoice；人设没显式选音色时用它，
   * 这样在商店里挑的音色才能真的影响朗读。 */
  function storeVoice() {
    try { return String(localStorage.getItem('hf_ttsVoice') || ''); } catch (e) { return ''; }
  }

  /* 选中的音色优先；没选就挑中文女声，再退回第一个中文 */
  function pickVoice() {
    var list = voiceList();
    if (!list.length) return null;
    var want = (S && S.persona.tts) ? S.persona.tts.voice : '';
    if (!want) want = storeVoice();
    if (want) {
      var hit = list.filter(function (v) { return v.name === want || v.voiceURI === want; })[0];
      if (hit) return hit;
    }
    if (voiceCache) return voiceCache;
    var zh = list.filter(function (v) {
      return /zh|chinese|中文|普通话/i.test((v.lang || '') + ' ' + (v.name || ''));
    });
    voiceCache = zh.filter(function (v) {
      return /female|xiaoxiao|huihui|tingting|yaoyao|女/i.test(v.name || '');
    })[0] || zh[0] || null;
    return voiceCache;
  }

  /* 商店里的本地音色有两种启用值：piper:<目录 id> 与 kokoro:<sid>。
   * 返回给朗读链路的结构要能直接变成 /tts/speak 的请求体。 */
  function localVoiceSpec() {
    var want = (S && S.persona.tts && S.persona.tts.voice) ? S.persona.tts.voice : storeVoice();
    if (!want) return null;
    var s = String(want);
    var head = s.indexOf('piper:') === 0 ? 'piper' : (s.indexOf('kokoro:') === 0 ? 'kokoro' : '');
    if (!head) return null;
    var item = (typeof catalogGet === 'function') ? catalogGet(s.slice(head.length + 1)) : null;
    if (!item) return null;
    if (item.engine === 'kokoro' && typeof item.sid === 'number') return { engine: 'kokoro', sid: item.sid, label: item.name };
    if (item.engine === 'piper' && item.voiceFile) return { engine: 'piper', voice: item.voiceFile, label: item.name };
    return null;
  }

  function renderVoiceOptions() {
    var sel = S && S.refs.voiceSel;
    if (!sel) return;
    var list = voiceList().filter(function (v) {
      return /zh|chinese|中文|普通话/i.test((v.lang || '') + ' ' + (v.name || ''));
    });
    var saved = S.persona.tts.voice || '';
    var cur = saved || storeVoice();
    sel.innerHTML = '';
    var def = document.createElement('option');
    def.value = '';
    def.textContent = list.length ? '系统默认' : '系统默认（未检测到中文语音）';
    sel.appendChild(def);
    list.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.name;
      o.textContent = v.name + (v.lang ? ' · ' + v.lang : '');
      sel.appendChild(o);
    });
    /* 商店里选的本地音色（Piper / Kokoro）不在系统语音列表里，
     * 单独补一项，否则下拉会显示成「系统默认」。 */
    var local = String(cur).indexOf('piper:') === 0 || String(cur).indexOf('kokoro:') === 0;
    if (local) {
      var po = document.createElement('option');
      po.value = cur;
      var spec = localVoiceSpec();
      po.textContent = spec ? ('本地语音 · ' + spec.label) : '本地语音（模型商店）';
      sel.appendChild(po);
    }
    sel.value = cur;
    /* 商店里选的可能是英文音色，下拉只列中文音色时选中会落空，退回人设值 */
    if (sel.value !== cur) sel.value = saved;
    sel.disabled = !list.length && !local;
  }

  function syncTtsLabels() {
    var r = S.refs;
    if (r.rateVal) r.rateVal.textContent = Number(S.persona.tts.rate).toFixed(2).replace(/0$/, '');
    if (r.pitchVal) r.pitchVal.textContent = Number(S.persona.tts.pitch).toFixed(2).replace(/0$/, '');
  }

  function syncTtsUI() {
    var r = S.refs;
    if (!r.rate) return;
    r.rate.value = S.persona.tts.rate;
    r.pitch.value = S.persona.tts.pitch;
    syncTtsLabels();
    renderVoiceOptions();
  }

  /* 滑块/下拉一变就写进人设并落盘，探针直接读 localStorage 校验 */
  function applyTtsForm() {
    var r = S.refs;
    if (!r.rate) return;
    S.persona.tts.rate = clamp(Number(r.rate.value) || 1.04, 0.7, 1.4);
    S.persona.tts.pitch = clamp(Number(r.pitch.value) || 1.12, 0.7, 1.5);
    S.persona.tts.voice = r.voiceSel ? r.voiceSel.value : '';
    syncTtsLabels();
    saveState();
  }

  function stopSpeech() {
    if (!S) return;
    S.rig.ttsUntil = 0;
    S.rig.speaking = false;
    if (S.rig.ttsAudio) {
      try { S.rig.ttsAudio.pause(); } catch (e) { /* 已结束 */ }
      S.rig.ttsAudio = null;
    }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* 没有语音引擎 */ }
  }

  function speakSystem(clean) {
    if (!window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return;
    try {
      window.speechSynthesis.cancel();
      var tts = S.persona.tts || DEFAULT_PERSONA.tts;
      var rate = clamp(Number(tts.rate) || 1.04, 0.7, 1.4);
      var u = new SpeechSynthesisUtterance(clean);
      u.lang = 'zh-CN';
      u.rate = rate;
      u.pitch = clamp(Number(tts.pitch) || 1.12, 0.7, 1.5);
      var v = pickVoice();
      if (v) u.voice = v;

      /* 引擎不派发 onstart 时也要有嘴型：按字数估一个时间窗兜底 */
      S.rig.speaking = true;
      S.rig.ttsUntil = S.rig.t + Math.min(30, Math.max(1.4, clean.length / (5.4 * rate)));
      u.onstart = function () {
        if (S) S.rig.ttsUntil = Math.max(S.rig.ttsUntil, S.rig.t + 0.8);
      };
      /* 词边界比按字数切更贴合真实语速；没有 boundary 的引擎继续走字符节拍 */
      u.onboundary = function (ev) {
        if (!S) return;
        var len = (ev && ev.charLength) || 2;
        S.rig.mouthPulse = clamp(0.45 + len * 0.12 + Math.random() * 0.25, 0, 1);
        S.rig.pulseUntil = S.rig.t + 0.16;
        S.rig.ttsUntil = Math.max(S.rig.ttsUntil, S.rig.t + 0.6);
      };
      u.onend = function () {
        if (!S) return;
        S.rig.speaking = false;
        S.rig.ttsUntil = Math.min(S.rig.ttsUntil, S.rig.t + 0.25);
      };
      u.onerror = function () {
        if (S) { S.rig.speaking = false; S.rig.ttsUntil = 0; }
      };
      window.speechSynthesis.speak(u);
    } catch (e) { S.rig.speaking = false; }
  }

  /* 商店里下载的本地音色（Piper / Kokoro）不在系统语音列表里：交给本地引擎桥合成 WAV 再播。
   * 引擎没起来（浏览器模式 / 被卸载）时退回系统语音，不让数字人整段静音。 */
  function speakLocal(clean, spec) {
    if (!spec || typeof fetch !== 'function' || typeof rtBase !== 'function' || typeof Audio !== 'function') return false;
    var base = rtBase();
    if (!base) return false;
    var tts = S.persona.tts || DEFAULT_PERSONA.tts;
    var rate = clamp(Number(tts.rate) || 1.04, 0.7, 1.4);
    var payload = { text: clean, engine: spec.engine, rate: rate };
    if (spec.engine === 'kokoro') payload.sid = spec.sid;
    else payload.voice = spec.voice;
    S.rig.speaking = true;
    S.rig.ttsUntil = S.rig.t + Math.min(30, Math.max(1.4, clean.length / (5.4 * rate)));
    fetch(base + '/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (j) { throw new Error((j && j.error) || ('HTTP ' + r.status)); });
      }
      return r.blob();
    }).then(function (blob) {
      if (!S || !blob || !blob.size) throw new Error('没有返回音频');
      var obj = URL.createObjectURL(blob);
      var audio = new Audio(obj);
      S.rig.ttsAudio = audio;
      audio.onended = audio.onerror = function () {
        if (!S) return;
        S.rig.speaking = false;
        S.rig.ttsUntil = Math.min(S.rig.ttsUntil, S.rig.t + 0.25);
        S.rig.ttsAudio = null;
        try { URL.revokeObjectURL(obj); } catch (e) { /* 已释放 */ }
      };
      var p = audio.play();
      if (p && p.catch) p.catch(function () { if (S) S.rig.speaking = false; });
    }).catch(function () {
      if (S) S.rig.speaking = false;
      speakSystem(clean);
    });
    return true;
  }

  function speakAloud(text, force) {
    if (!S || (!S.voiceOn && !force) || !text) return;
    var clean = String(text).replace(/[【】\[\]]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    try {
      stopSpeech();
      var spec = localVoiceSpec();
      if (spec && speakLocal(clean, spec)) return;
      speakSystem(clean);
    } catch (e) { S.rig.speaking = false; }
  }

  function testSpeak() {
    speakAloud('你好呀，我是' + (S.persona.name || '鲸鱼娘') + '，很高兴见到你。', true);
    toast('试听中…');
  }

  /* ---------- 长期记忆 ---------- */
  function memPrompt() {
    return [
      '你负责整理「数字人」与用户之间的长期记忆。',
      '把对话里关于用户的稳定信息压缩成一段不超过 120 字的中文备忘：称呼、喜好、近期状态、约定。',
      '不要编造，不要寒暄，不要列表，直接输出备忘正文。'
    ].join('\n');
  }

  function syncMemText() {
    var el = S && S.refs.memText;
    if (!el) return;
    var s = (S.mem && S.mem.summary) || '';
    el.textContent = s || '还没有整理过记忆。';
    el.classList.toggle('empty', !s);
  }

  function summarizeNow(manual) {
    if (!S || S.memBusy) return Promise.resolve(false);
    if (typeof llmStreamRequest !== 'function') {
      if (manual) toast('语言模型模块没有加载');
      return Promise.resolve(false);
    }
    var history = S.msgs.filter(function (m) { return m.r === 'u' || m.r === 'a'; })
      .slice(-40)
      .map(function (m) { return { role: m.r === 'u' ? 'user' : 'assistant', content: m.t }; });
    if (history.length < 2) {
      if (manual) toast('先聊两句，才有东西可记');
      return Promise.resolve(false);
    }

    S.memBusy = true;
    var count = S.msgs.length;
    return llmStreamRequest(memPrompt(), history, function () {}, { app: 'live2d', tag: 'memory' })
      .then(function (raw) {
        S.memBusy = false;
        var text = String(raw || '').replace(/[【】\[\]]/g, '').trim().slice(0, MEM_MAX);
        if (!text) {
          if (manual) toast('这次没整理出什么');
          return false;
        }
        S.mem = { summary: text, at: Date.now(), count: count };
        syncMemText();
        saveState();
        if (manual) toast('记忆已更新');
        return true;
      })
      .catch(function () {
        S.memBusy = false;
        if (manual) toast('整理失败，稍后再试');
        return false;
      });
  }

  function clearMemory() {
    if (!S) return;
    S.mem = { summary: '', at: 0, count: 0 };
    syncMemText();
    saveState();
    toast('记忆已清空');
  }

  /* 攒够一批新消息就顺手更新一次；失败不留痕，不打扰对话 */
  function maybeRemember() {
    if (!S || S.memBusy || !S.mem) return;
    if (S.msgs.length - (S.mem.count || 0) < MEM_EVERY) return;
    summarizeNow(false);
  }

  /* ---------- 导出 ---------- */
  function buildExport() {
    var lines = [];
    var d = new Date();
    lines.push('# 与' + (S.persona.name || '数字人') + '的对话');
    lines.push('');
    lines.push('- 导出时间：' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hhmm(d));
    lines.push('- 亲密度：' + Math.round(S.aff) + '/100（' + affLevel() + '）');
    lines.push('- 共 ' + S.msgs.length + ' 条');
    lines.push('');
    if (!S.msgs.length) {
      lines.push('_还没有对话。_');
      return lines.join('\n');
    }
    var lastDay = '';
    S.msgs.forEach(function (m) {
      var dt = new Date(m.ts || Date.now());
      var day = dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
      if (day !== lastDay) {
        lastDay = day;
        lines.push('## ' + day);
        lines.push('');
      }
      var who = m.r === 'u' ? '你' : (m.r === 's' ? '系统' : (S.persona.name || '数字人'));
      lines.push('**' + who + '**（' + hhmm(dt) + '）：' + m.t);
      lines.push('');
    });
    return lines.join('\n');
  }

  function exportChat() {
    var text = buildExport();
    try {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = '数字人对话-' + new Date().toISOString().slice(0, 10) + '.md';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      toast('对话已导出');
    } catch (e) {
      toast('导出失败');
    }
  }

  /* ---------- 人设面板 ---------- */
  function fillPersonaForm() {
    var r = S.refs;
    r.fName.value = S.persona.name;
    r.fUser.value = S.persona.userCall;
    r.fPersona.value = S.persona.persona;
  }

  function applyPersonaUI() {
    if (!S) return;
    S.refs.name.textContent = S.persona.name;
    fillPersonaForm();
    syncTtsUI();
    syncMemText();
  }

  function savePersonaForm() {
    var r = S.refs;
    var name = r.fName.value.trim().slice(0, 12) || DEFAULT_PERSONA.name;
    S.persona.name = name;
    S.persona.userCall = r.fUser.value.trim().slice(0, 12) || DEFAULT_PERSONA.userCall;
    S.persona.persona = r.fPersona.value.trim().slice(0, 800) || DEFAULT_PERSONA.persona;
    S.persona.voice = S.voiceOn;
    saveState();
    applyPersonaUI();
    renderLog();
    toast('角色已保存');
  }

  function resetPersona() {
    S.persona = JSON.parse(JSON.stringify(DEFAULT_PERSONA));
    S.voiceOn = S.persona.voice;
    S.msgs = [];
    S.aff = 12;
    S.mem = { summary: '', at: 0, count: 0 };
    hideSay();
    applyPersonaUI();
    syncVoice();
    syncAff();
    renderLog();
    setEmotion('neutral');
    saveState();
    toast('已恢复默认角色');
  }

  /* ---------- 提示条 ---------- */
  function toast(text) {
    if (!S) return;
    var el = S.body.querySelector('.l2d-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'l2d-toast';
      S.body.querySelector('.l2d-stage').appendChild(el);
    }
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { el.classList.remove('on'); }, 1800);
  }

  /* ---------- 口型 ---------- */
  function speechFeed(text) {
    if (!S || !text) return;
    S.rig.speakQ += String(text);
    if (S.rig.speakQ.length > 120) S.rig.speakQ = S.rig.speakQ.slice(-120);
  }

  function viseme(ch) {
    if (/[\s，。！？、,.!?…~～—：；]/.test(ch)) return 0;
    var table = [0.9, 0.55, 1.0, 0.4, 0.75, 0.5, 0.85];
    return table[ch.charCodeAt(0) % table.length];
  }

  /* ---------- 皮套加载 ---------- */
  function injectScript(src) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error('脚本加载失败：' + src)); };
      document.head.appendChild(el);
    });
  }

  function b64ToBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new Uint8Array(len);
    for (var i = 0; i < len; i++) buf[i] = bin.charCodeAt(i);
    return buf.buffer;
  }

  /* 模型加载器中间件：pack.js 里已有的文件不再走 XHR（file:// 下 XHR 读不到本地文件）。
     moc3 是 base64 → ArrayBuffer，其余 json 已经是对象。 */
  function serveFromPack(pack) {
    var mocUrl = pack.settings.FileReferences.Moc;
    var mocBuf = null;
    return function (ctx, next) {
      if (ctx.type === 'arraybuffer' && ctx.url === mocUrl) {
        if (!mocBuf) mocBuf = b64ToBuffer(pack.moc);
        ctx.result = mocBuf;
        return;
      }
      var data = pack.json[ctx.url];
      if (data) { ctx.result = data; return; }
      return next();
    };
  }

  function loadRig() {
    var st = S.rig;
    if (st.loading || st.ready) return;
    st.loading = true;
    if (S.refs.rigErr) S.refs.rigErr.hidden = true;

    var chain = Promise.resolve();
    RIG_SCRIPTS.forEach(function (src) {
      chain = chain.then(function () { return injectScript(src); });
    });

    chain.then(function () {
      var pack = window.L2D_PACK;
      if (!pack || !window.PIXI || !window.PIXI.live2d) throw new Error('运行时未就绪');
      if (window.PIXI.live2d.Live2DLoader) {
        window.PIXI.live2d.Live2DLoader.middlewares.unshift(serveFromPack(pack));
      }
      /* 构造时就要求 url 是字符串；纹理换成 data: URL，避免 file:// 下 CORS 拦图 */
      var refs = Object.assign({}, pack.settings.FileReferences, { Textures: pack.textures });
      var json = Object.assign({}, pack.settings, {
        FileReferences: refs,
        url: new URL(RIG_DIR, location.href).href
      });
      var settings = new window.PIXI.live2d.Cubism4ModelSettings(json);

      var host = S.refs.canvas;
      var app = new window.PIXI.Application({
        transparent: true,
        antialias: true,
        autoStart: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        autoDensity: true,
        backgroundAlpha: 0
      });
      app.view.className = 'l2d-cvs';
      host.appendChild(app.view);

      return window.PIXI.live2d.Live2DModel.from(settings, { autoUpdate: false, autoInteract: false })
        .then(function (model) {
          app.stage.addChild(model);
          st.app = app;
          st.model = model;

          /* 口型与嘴形在模型参数更新前写进去，表情/物理算完之后才不会被覆盖；
             顺手留一份参数快照，探针要读「本帧真实参与绘制的值」 */
          model.internalModel.on('beforeModelUpdate', function () {
            var cm = model.internalModel.coreModel;
            cm.setParameterValueById('ParamMouthOpenY', clamp(st.mouth, 0, 1));
            cm.setParameterValueById('ParamMouthForm', clamp(st.mouthForm, -1, 1));
            /* 说话时轻轻点头：叠加在模型自己算出的头部角度上 */
            if (Math.abs(st.nod) > 0.01) {
              var z = cm.getParameterValueById('ParamAngleZ') || 0;
              cm.setParameterValueById('ParamAngleZ', z + st.nod);
            }
            st.snap = {
              mouth: cm.getParameterValueById('ParamMouthOpenY'),
              mouthForm: cm.getParameterValueById('ParamMouthForm'),
              angleX: cm.getParameterValueById('ParamAngleX'),
              angleY: cm.getParameterValueById('ParamAngleY'),
              angleZ: cm.getParameterValueById('ParamAngleZ'),
              breath: cm.getParameterValueById('ParamBreath'),
              eyeL: cm.getParameterValueById('ParamEyeLOpen'),
              browL: cm.getParameterValueById('ParamBrowLForm')
            };
          });

          /* 模型自带的 idle 组名是 Idle，这里换成本项目注册的 idle */
          if (model.internalModel.motionManager) {
            model.internalModel.motionManager.groups.idle = 'idle';
          }

          st.ready = true;
          st.loading = false;
          if (S.refs.rigLoading) S.refs.rigLoading.hidden = true;
          fitRig();
          if (window.ResizeObserver) {
            st.ro = new ResizeObserver(function () { fitRig(); });
            st.ro.observe(host);
          }
          if (st.expr) setRigExpression(st.expr);
        });
    }).catch(function (err) {
      st.loading = false;
      st.error = (err && err.message) || String(err);
      if (S.refs.rigLoading) S.refs.rigLoading.hidden = true;
      if (S.refs.rigErr) {
        S.refs.rigErr.hidden = false;
        var span = S.refs.rigErr.querySelector('span');
        if (span) span.textContent = st.error;
      }
    });
  }

  function fitRig() {
    var st = S.rig;
    if (!st.ready || !st.app || !st.model) return;
    var host = S.refs.canvas;
    var w = host.clientWidth;
    var h = host.clientHeight;
    if (!w || !h) return;
    st.app.renderer.resize(w, h);

    /* internalModel 的宽高就是模型画布尺寸（未乘缩放），先量再缩放 */
    var bw = st.model.internalModel.width || st.model.width;
    var bh = st.model.internalModel.height || st.model.height;
    if (!bw || !bh) return;
    var s = Math.min(w / bw, h / bh) * RIG_FIT;
    st.model.scale.set(s);
    st.model.x = (w - bw * s) / 2;
    st.model.y = h - bh * s;

    /* 视线原点：皮套眼睛的位置（模型高度约 70% 处），供 onPointer 归一化 */
    st.anchorX = st.model.x + bw * s * 0.5;
    st.anchorY = h - bh * s * 0.70;
    /* 头顶位置，给舞台气泡框留位 */
    st.headTop = Math.max(40, st.anchorY - h * 0.17);
    fitSay();
  }

  /* ---------- 动画主循环 ---------- */
  function startLoop() {
    if (S.loopStarted) return;
    S.loopStarted = true;
    requestAnimationFrame(frame);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!S || document.hidden) return;
    var st = S.rig;
    var dt = st.last ? Math.min(0.06, (now - st.last) / 1000) : 0.016;
    st.last = now;

    var win = S.win;
    if (!win || win.classList.contains('hidden') || !win.offsetWidth) return;

    /* 气泡到点自动收起；点击收起与发送前隐藏走 hideSay() */
    if (S.sayUntil && now > S.sayUntil) hideSay();

    st.t += dt;
    var t = st.t;

    /* 鼠标停下几秒后眼神自己飘一飘，别一直死盯着一个点 */
    if (now - st.lastPointerAt > 3200) {
      st.focusTX = Math.sin(t * 0.55) * 0.35;
      st.focusTY = Math.sin(t * 0.74 + 1.1) * 0.22;
    }
    st.focusX += (st.focusTX - st.focusX) * Math.min(1, dt * 5);
    st.focusY += (st.focusTY - st.focusY) * Math.min(1, dt * 5);

    /* 口型：流式文本按字切音节 */
    if (st.speakQ) {
      st.speakAcc += dt * 15.5;
      while (st.speakAcc >= 1 && st.speakQ.length) {
        st.speakAcc -= 1;
        var ch = st.speakQ.charAt(0);
        st.speakQ = st.speakQ.slice(1);
        st.mouthPulse = viseme(ch);
        st.pulseUntil = t + 0.12;
      }
    }
    var ttsOn = t < st.ttsUntil;
    if (ttsOn && t >= (st.ttsTick || 0)) {
      st.mouthPulse = 0.45 + Math.random() * 0.45;
      st.ttsTick = t + 0.12;
    }
    if (!ttsOn) st.ttsTick = 0;

    var mouthTarget = (t < st.pulseUntil || ttsOn) ? st.mouthPulse : 0;
    st.mouth += (mouthTarget - st.mouth) * Math.min(1, dt * 22);

    /* 嘴形：开心/害羞时嘴角上扬，难过/生气时向下 */
    var formTarget = (S.emo === 'happy' || S.emo === 'shy') ? 0.55
      : ((S.emo === 'sad' || S.emo === 'angry') ? -0.5 : 0.15);
    st.mouthForm += (formTarget - st.mouthForm) * Math.min(1, dt * 4);

    /* 说话时点头，停下后回正 */
    st.nod = (t < st.ttsUntil)
      ? Math.sin(t * 7.2) * 1.5
      : st.nod * Math.max(0, 1 - dt * 6);

    /* 呼吸、眨眼、物理、动作都由模型自己算，这里只喂视线与口型。
       ⚠ Live2DModel.update() 吃的是毫秒，不是秒 —— 传秒会让物理慢 1000 倍。 */
    if (st.ready && st.model) {
      var im = st.model.internalModel;
      if (im.focusController) im.focusController.focus(st.focusX, st.focusY);
      st.model.update(dt * 1000);
    }
  }

  /* ---------- 注册 ---------- */
  registerApp({
    id: 'live2d',
    name: '数字人',
    title: '数字人 · Live2D 对话',
    sub: '会眨眼、会看你、会跟着说话的数字人',
    icon: ICON,
    order: 16,
    cls: 'live2d',
    win: 'live2dWin',
    css: ['apps/live2d/app.css'],
    body: BODY_HTML,
    mount: function (body) {
      if (body.dataset.ready === '1' && S && S.body === body) {
        /* 切回来只同步数据，不重建 DOM：动画循环、聊天记录、输入框都保持原样 */
        syncAff();
        syncVoice();
        syncTabs();
        checkConn();
        return;
      }
      boot(body);
    }
  });
})();
