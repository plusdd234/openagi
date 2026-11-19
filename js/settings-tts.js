/* ============================================================
 * 设置 · 语音合成
 *
 * 为什么单独一份：
 *   音色清单不是静态写死的，而是「系统语音（异步填充）+ 磁盘上已下载的本地模型」
 *   两路拼出来的；切换分组时才需要重算，塞进 workbench.js 会把那个文件撑大。
 *
 * 三条约束：
 *   ① 默认音色只存 localStorage.hf_ttsVoice，与模型商店「设为默认」同源。
 *      ⚠ 不要加进 config.js 的 CFG：页面加载时下拉里还没有选项，saveAll()
 *      会把已存的音色覆盖成空值。
 *   ② 试听语速存 hf_ttsRate，只作用于本页试听；数字人朗读的语速在人设里。
 *   ③ 本地音色（piper: / kokoro: / melo: / vits: / zipvoice: / param:）不在系统语音列表里，
 *      必须交给本地引擎桥合成；zipvoice 还依赖「声音克隆」小节里的参考录音，
 *      param（参数合成）依赖离线蒸馏好的音库。
 * ============================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var audio = null;
  var audioUrl = '';
  var bound = false;
  var busy = false;
  var status = { sys: 0, piper: false, kokoro: false, melo: false, vits: false, zipvoice: false, param: false, clone: false, probed: false };

  var FALLBACK_TEXT = '你好，这是当前默认音色的试听。';

  /* ---------------- 读写默认音色 ---------------- */

  function readVoice() {
    try { return String(localStorage.getItem('hf_ttsVoice') || ''); } catch (e) { return ''; }
  }
  function writeVoice(v) {
    try {
      if (v) localStorage.setItem('hf_ttsVoice', String(v));
      else localStorage.removeItem('hf_ttsVoice');
    } catch (e) { /* nostore / 隐私模式 */ }
  }

  function readRate() {
    var n = 1;
    try { n = Number(localStorage.getItem('hf_ttsRate')); } catch (e) { n = 1; }
    if (!isFinite(n) || n <= 0) n = 1;
    return Math.min(1.4, Math.max(0.7, n));
  }
  function writeRate(n) {
    try { localStorage.setItem('hf_ttsRate', String(n)); } catch (e) { /* 同上 */ }
  }

  /* AI 语音控制方式：ai = 模型用 [[p]]/[[r]]/[[f]]/[[e]]/[[t]] 控制节奏与音调；
   * direct = 原样整句朗读。 */
  function readAiMode() {
    try { return localStorage.getItem('hf_ttsAiMode') === 'direct' ? 'direct' : 'ai'; }
    catch (e) { return 'ai'; }
  }
  function writeAiMode(m) {
    try { localStorage.setItem('hf_ttsAiMode', m === 'direct' ? 'direct' : 'ai'); } catch (e) { /* 同上 */ }
    emitChanged();
  }
  function stripProsody(s) {
    return String(s || '').replace(/\[\[[^\]]*\]\]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
  }

  /* AI 控制没现成标记时给一句带节奏的示例，否则试听听不出和直接朗读的区别 */
  var FAST_SAMPLE = '[[p=0.25]]你好，我是快速合成。[[r=0.92]]今天的回答会很快。[[e=1.15]]重点在这里。[[t=0.2]]';
  var FAST_SAMPLE_PLAIN = '你好，我是快速合成。今天的回答会很快。重点在这里。';

  /* ---------------- 音色描述 ---------------- */

  function systemVoices() {
    try {
      if (!window.speechSynthesis || typeof window.speechSynthesis.getVoices !== 'function') return [];
      return window.speechSynthesis.getVoices() || [];
    } catch (e) { return []; }
  }

  function catalogTts() {
    return (typeof catalogOf === 'function') ? (catalogOf('tts') || []) : [];
  }

  /* piper:<catalog id> / kokoro:<sid> / melo:zh_en / vits:theresa / zipvoice:clone → 可读名字 */
  function localLabel(value) {
    var s = String(value || '');
    if (s.indexOf('piper:') === 0) {
      var it = (typeof catalogGet === 'function') ? catalogGet(s.slice(6)) : null;
      return it ? ('Piper · ' + it.name) : 'Piper';
    }
    if (s.indexOf('kokoro:') === 0) {
      var sid = Number(s.slice(7));
      var list = catalogTts();
      for (var i = 0; i < list.length; i++) {
        if (list[i].engine === 'kokoro' && Number(list[i].sid) === sid) return 'Kokoro · ' + list[i].name;
      }
      return 'Kokoro';
    }
    if (s.indexOf('melo:') === 0) {
      var m = (typeof catalogGet === 'function') ? catalogGet('melo-zh-en') : null;
      return 'MeloTTS · ' + (m ? m.name : '中英混读女声');
    }
    if (s.indexOf('vits:') === 0) {
      var v = (typeof catalogGet === 'function') ? catalogGet('vits-theresa') : null;
      return v ? ('VITS · ' + v.name) : '角色音色';
    }
    if (s.indexOf('zipvoice:') === 0) return 'ZipVoice · 我的克隆声音';
    if (s.indexOf('param:') === 0) return '参数合成 · 快问快答';
    if (s.indexOf('sys:') === 0) return '系统机械音 · SAPI';
    return '';
  }

  /* 与数字人朗读同一套取值：piper 用 voiceFile，kokoro 用 sid，
   * melo / vits / zipvoice 是单一份共享模型，不需要额外参数 */
  function localSpec(value) {
    var s = String(value || '');
    if (s.indexOf('piper:') === 0 && typeof catalogGet === 'function') {
      var it = catalogGet(s.slice(6));
      return it && it.engine === 'piper' && it.voiceFile ? { engine: 'piper', voice: it.voiceFile } : null;
    }
    if (s.indexOf('kokoro:') === 0) {
      var sid = Number(s.slice(7));
      return isFinite(sid) ? { engine: 'kokoro', sid: sid } : null;
    }
    if (s.indexOf('melo:') === 0) return { engine: 'melo' };
    if (s.indexOf('vits:') === 0) return { engine: 'vits' };
    if (s.indexOf('zipvoice:') === 0) return { engine: 'zipvoice' };
    /* 参数合成不吃权重：运行时只查蒸馏音库，所以没有额外参数 */
    if (s.indexOf('param:') === 0) return { engine: 'param' };
    /* 系统机械音走 Windows SAPI，语速/音调/停顿由 SSML 控制 */
    if (s.indexOf('sys:') === 0) return { engine: 'sys' };
    return null;
  }

  function pickSystemVoice(want) {
    var list = systemVoices();
    if (!list.length) return null;
    var w = String(want || '');
    if (w) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].name === w || list[i].voiceURI === w) return list[i];
      }
    }
    var zh = list.filter(function (v) {
      return /zh|chinese|中文|普通话/i.test(String(v.lang || '') + ' ' + String(v.name || ''));
    });
    var female = zh.filter(function (v) {
      return /female|xiaoxiao|huihui|tingting|yaoyao|女/i.test(String(v.name || ''));
    });
    return female[0] || zh[0] || list[0];
  }

  /* ---------------- 本地引擎状态 ---------------- */

  function bridgeStatus() {
    if (typeof rtBase !== 'function' || typeof fetch !== 'function') return Promise.resolve(null);
    var base = rtBase();
    if (!base) return Promise.resolve(null);
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 2500) : 0;
    return fetch(base + '/tts/status', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (timer) clearTimeout(timer);
        return j ? {
          sys: systemVoices().length,
          piper: !!j.engine,
          kokoro: !!j.kokoro,
          melo: !!j.melo,
          vits: !!j.vits,
          zipvoice: !!j.zipvoice,
          param: !!j.param,
          clone: !!j.clone,
          refText: String(j.refText || ''),
          probed: true
        } : null;
      })
      .catch(function () { if (timer) clearTimeout(timer); return null; });
  }

  /* 浏览器模式下没有 /tts/status，桌面端可以走 IPC 读磁盘 */
  function desktopStatus() {
    var d = window.openagiDesktop;
    if (!d) return Promise.resolve(null);
    var out = {
      sys: systemVoices().length, piper: false, kokoro: false,
      melo: false, vits: false, zipvoice: false, param: false, clone: false, refText: '', probed: true
    };
    var jobs = [];
    if (typeof d.storeTtsList === 'function') {
      jobs.push(d.storeTtsList().then(function (r) {
        out.piper = !!(r && r.ok && (r.voices || []).length);
      }).catch(function () {}));
    }
    if (typeof d.storeKokoroStatus === 'function') {
      jobs.push(d.storeKokoroStatus().then(function (r) {
        out.kokoro = !!(r && r.ok && r.installed);
      }).catch(function () {}));
    }
    if (typeof d.storeMeloStatus === 'function') {
      jobs.push(d.storeMeloStatus().then(function (r) {
        out.melo = !!(r && r.ok && r.installed);
      }).catch(function () {}));
    }
    if (typeof d.storeVitsStatus === 'function') {
      jobs.push(d.storeVitsStatus().then(function (r) {
        out.vits = !!(r && r.ok && r.installed);
      }).catch(function () {}));
    }
    /* ZipVoice 同时带回「模型是否装好」与「参考录音是否就绪」 */
    if (typeof d.storeZipvoiceStatus === 'function') {
      jobs.push(d.storeZipvoiceStatus().then(function (r) {
        out.zipvoice = !!(r && r.ok && r.installed);
        out.clone = !!(r && r.ok && r.clone);
        out.refText = String((r && r.referenceText) || '');
      }).catch(function () {}));
    }
    return Promise.all(jobs).then(function () { return out; }).catch(function () { return null; });
  }

  function refreshStatus() {
    return bridgeStatus().then(function (s) { return s || desktopStatus(); }).then(function (s) {
      status = s || {
        sys: systemVoices().length, piper: false, kokoro: false,
        melo: false, vits: false, zipvoice: false, param: false, clone: false, refText: '', probed: false
      };
      paintStatus();
      fillVoices();
      paintClone();
      /* 其它 App 的语音面板靠这个事件知道「本地引擎刚探测完」 */
      try { window.dispatchEvent(new CustomEvent('hf-tts-status')); } catch (e) { /* 老环境 */ }
    });
  }

  function paintStatus() {
    var el = $('ttsStatus');
    if (!el) return;
    var parts = ['系统语音 ' + status.sys + ' 个'];
    parts.push('Piper ' + (status.piper ? '就绪' : '未安装'));
    parts.push('Kokoro ' + (status.kokoro ? '就绪' : '未安装'));
    parts.push('MeloTTS ' + (status.melo ? '就绪' : '未安装'));
    parts.push('角色音色 ' + (status.vits ? '就绪' : '未安装'));
    parts.push('ZipVoice ' + (status.zipvoice ? (status.clone ? '就绪' : '缺参考录音') : '未安装'));
    parts.push('参数合成 ' + (status.param ? '就绪' : '未蒸馏'));
    el.textContent = parts.join(' · ');
    el.classList.toggle('is-err', !status.probed);
    paintFast();
  }

  /* ---------------- 快速合成 ---------------- */

  function fastMsg(text) {
    var el = $('ttsParamMsg');
    if (el) el.textContent = text || '';
  }

  function fastTextFor(typed, mode) {
    var s = String(typed || '').trim().slice(0, 80);
    if (mode === 'direct') return stripProsody(s) || FAST_SAMPLE_PLAIN;
    if (!s) return FAST_SAMPLE;
    /* 用户自己写了标记就照着读；没写就套一层最轻的停顿 + 重音，保证听得出差异 */
    return /\[\[/.test(s) ? s : ('[[p=0.25]]' + s + '[[e=1.12]]');
  }

  function fastText() {
    var el = $('ttsText');
    return fastTextFor(el && el.value ? el.value : '', readAiMode());
  }

  /* 设置面板与数字人同处一个 document，选择器限定 .settings2 免得互相串台 */
  function ttsScope() {
    return document.querySelector('.settings2') || document;
  }

  function paintFast() {
    var stateEl = $('ttsParamState');
    var useBtn = $('ttsParamUse');
    var playBtn = $('ttsParamPlay');
    if (!stateEl && !useBtn) return;
    var mode = readAiMode();
    var active = readVoice() === 'param:fast';
    var ready = !!status.param;

    if (stateEl) {
      stateEl.textContent = ready ? '已蒸馏' : '未蒸馏';
      stateEl.classList.toggle('is-on', ready);
    }

    var btns = ttsScope().querySelectorAll('[data-ai-mode]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-ai-mode') === mode;
      btns[i].classList.toggle('on', on);
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }

    if (useBtn) {
      useBtn.textContent = active ? '使用中' : (ready ? '使用快速合成' : '去蒸馏');
      useBtn.classList.toggle('primary', !active);
      useBtn.disabled = active;
    }
    if (playBtn) playBtn.disabled = !ready;

    if (!ready) {
      fastMsg(status.vits
        ? '音库还没生成：在项目目录运行 node tools/distill-voice.js，完成后再点「检测」。'
        : '先到模型商店安装「角色音色」，再用 node tools/distill-voice.js 蒸馏音库。');
    } else if (active) {
      fastMsg(mode === 'ai' ? '当前默认音色：模型用 [[r]]/[[p]]/[[f]]/[[e]]/[[t]] 控制语速、停顿、音调与重音。'
        : '当前默认音色：原样朗读，不解析任何节奏标记。');
    } else {
      fastMsg(mode === 'ai' ? 'AI 控制：运行时不加载语音模型，由 LLM 的参数直接驱动波形。'
        : '直接朗读：整句原样读出，不处理标记。');
    }
  }

  function paintTabs(which) {
    var root = ttsScope();
    var tabs = root.querySelectorAll('[data-tts-tab]');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tts-tab') === which;
      tabs[i].classList.toggle('on', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var panes = root.querySelectorAll('[data-tts-pane]');
    for (var j = 0; j < panes.length; j++) {
      panes[j].classList.toggle('hidden', panes[j].getAttribute('data-tts-pane') !== which);
    }
  }

  /* ---------------- 声音克隆 ---------------- */

  function cloneMsg(text) {
    var el = $('ttsCloneStatus');
    if (el) el.textContent = text || '';
  }

  function paintClone() {
    var pick = $('ttsClonePick');
    var playBtn = $('ttsClonePlay');
    var clearBtn = $('ttsCloneClear');
    var textEl = $('ttsCloneText');
    if (!pick) return;
    var d = window.openagiDesktop;
    var desk = !!(d && typeof d.ttsClonePick === 'function');
    /* 参考文本只在本地有模型时才有意义：还没下载时输入框不可用，避免填完发现白填 */
    if (textEl && document.activeElement !== textEl) {
      if (!textEl.value && status.refText) textEl.value = status.refText;
    }
    pick.disabled = !desk || !status.zipvoice;
    if (playBtn) playBtn.disabled = !status.clone;
    if (clearBtn) clearBtn.disabled = !desk || !status.zipvoice;
    if (textEl) textEl.disabled = !desk || !status.zipvoice;
    if (!desk) cloneMsg('声音克隆需要桌面端：请用桌面应用打开设置。');
    else if (!status.zipvoice) cloneMsg('先在模型商店下载「ZipVoice · 我的声音克隆」（约 160 MB）。');
    else if (!status.clone) cloneMsg('模型已就绪：填写参考文本，再选择一段 5-15 秒的清晰 WAV 录音。');
    else cloneMsg('参考录音已就绪：在默认音色里选「ZipVoice · 我的克隆声音」即可朗读。');
  }

  function applyClone(r) {
    if (r && typeof r === 'object') {
      if (typeof r.installed === 'boolean') status.zipvoice = r.installed;
      if (typeof r.clone === 'boolean') status.clone = r.clone;
      if (r.referenceText != null) status.refText = String(r.referenceText || '');
    }
    paintStatus();
    fillVoices();
    paintClone();
    emitChanged();
  }

  function clonePick() {
    var d = window.openagiDesktop;
    if (!d || typeof d.ttsClonePick !== 'function') { cloneMsg('声音克隆需要桌面端。'); return; }
    var textEl = $('ttsCloneText');
    var text = String(textEl && textEl.value ? textEl.value : '').trim();
    if (!text) { cloneMsg('请先填写参考文本：也就是这段录音里说的话。'); return; }
    cloneMsg('正在保存参考录音…');
    d.ttsClonePick(text).then(function (r) {
      if (r && r.cancelled) { paintClone(); return; }
      if (!r || !r.ok) { cloneMsg('保存失败：' + ((r && r.message) || '未知错误')); return; }
      applyClone(r);
      if (r.clone) msg('克隆音色已就绪，可以试听');
    }).catch(function (e) {
      cloneMsg('保存失败：' + ((e && e.message) || e));
    });
  }

  function cloneClear() {
    var d = window.openagiDesktop;
    if (!d || typeof d.ttsCloneClear !== 'function') { cloneMsg('声音克隆需要桌面端。'); return; }
    d.ttsCloneClear().then(function (r) {
      applyClone(r);
      cloneMsg('已清除参考录音。');
    }).catch(function (e) {
      cloneMsg('清除失败：' + ((e && e.message) || e));
    });
  }

  /* 参考文本改完就落盘：下次打开设置不用重填；没有录音时写文本也不会让 clone 变 true */
  function cloneTextCommit() {
    var d = window.openagiDesktop;
    var textEl = $('ttsCloneText');
    if (!d || typeof d.ttsCloneText !== 'function' || !textEl || !status.zipvoice) return;
    d.ttsCloneText(String(textEl.value || '').trim()).then(function (r) {
      applyClone(r);
    }).catch(function () {});
  }

  function clonePlay() {
    stop();
    var textEl = $('ttsText');
    var text = String(textEl && textEl.value ? textEl.value : '').trim().slice(0, 120) || FALLBACK_TEXT;
    playLocal(text, { engine: 'zipvoice' }, 1);
  }

  /* ---------------- 下拉 ---------------- */

  function fillVoices() {
    var sel = $('ttsVoiceSel');
    if (!sel) return;
    var cur = readVoice();
    var list = systemVoices();
    var local = [];
    catalogTts().forEach(function (it) {
      if (it.engine === 'piper' && status.piper) {
        local.push({ value: 'piper:' + it.id, name: 'Piper · ' + it.name });
      } else if (it.engine === 'kokoro' && status.kokoro) {
        local.push({ value: 'kokoro:' + it.sid, name: 'Kokoro · ' + it.name });
      } else if (it.engine === 'melo' && status.melo) {
        local.push({ value: 'melo:zh_en', name: 'MeloTTS · ' + it.name });
      } else if (it.engine === 'vits' && status.vits) {
        local.push({ value: 'vits:theresa', name: 'VITS · ' + it.name });
      } else if (it.engine === 'zipvoice' && status.clone) {
        /* 只有参考录音齐了才允许选：否则选了也只会合成失败 */
        local.push({ value: 'zipvoice:clone', name: 'ZipVoice · 我的克隆声音' });
      }
    });
    /* 参数合成音库是蒸馏产物，不在模型商店的下载清单里；有就自动出现 */
    if (status.param) {
      local.push({ value: 'param:fast', name: '参数合成 · 快问快答' });
    }
    /* 系统机械音：不依赖任何下载，Windows 上始终可用 */
    if (status.sapi) {
      local.push({ value: 'sys:std', name: '系统机械音 · SAPI' });
    }

    sel.innerHTML = '';
    var def = document.createElement('option');
    def.value = '';
    def.textContent = list.length ? '系统默认（自动挑中文音色）' : '系统默认（未检测到系统语音）';
    sel.appendChild(def);

    if (list.length) {
      var g1 = document.createElement('optgroup');
      g1.label = '系统语音';
      list.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.name;
        o.textContent = v.name + (v.lang ? ' · ' + v.lang : '');
        g1.appendChild(o);
      });
      sel.appendChild(g1);
    }
    if (local.length) {
      var g2 = document.createElement('optgroup');
      g2.label = '本地模型';
      local.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.value;
        o.textContent = v.name;
        g2.appendChild(o);
      });
      sel.appendChild(g2);
    }

    /* 已选的本地音色可能还没被状态探测到（模型刚下完 / 引擎刚重启）：
     * 补一项占位，别让下拉悄悄退回「系统默认」并覆盖用户的选择。 */
    if (cur && !local.some(function (v) { return v.value === cur; }) && cur.indexOf(':') !== -1) {
      var keep = document.createElement('option');
      keep.value = cur;
      keep.textContent = (localLabel(cur) || cur) + (status.probed ? '（未就绪）' : '');
      sel.appendChild(keep);
    }

    sel.value = cur;
    if (sel.value !== cur) {
      sel.value = '';
      writeVoice('');
    }

    var hint = $('ttsVoiceHint');
    if (hint) {
      hint.textContent = '系统语音 ' + list.length + ' 个 · 本地音色 ' + local.length +
        ' 个。本地音色在模型商店下载后会自动出现在这里；Piper / Kokoro / MeloTTS / 角色音色 / 参数合成支持 AI 语音控制。';
    }
  }

  /* ---------------- 试听 ---------------- */

  function msg(text) {
    var el = $('ttsPlayMsg');
    if (el) el.textContent = text || '';
  }

  function stop() {
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* 没有语音引擎 */ }
    if (audio) {
      try { audio.pause(); } catch (e) { /* 已结束 */ }
      audio = null;
    }
    if (audioUrl) {
      try { URL.revokeObjectURL(audioUrl); } catch (e) { /* 已释放 */ }
      audioUrl = '';
    }
    busy = false;
  }

  function playSystem(text, voiceName, rate) {
    var ss = window.speechSynthesis;
    var Utter = window.SpeechSynthesisUtterance;
    if (!ss || typeof ss.speak !== 'function' || typeof Utter !== 'function') {
      msg('当前环境没有系统语音');
      return;
    }
    var v = pickSystemVoice(voiceName);
    if (!v) {
      msg('没有可用音色，去模型商店下载本地语音');
      return;
    }
    try {
      var u = new Utter(text);
      u.voice = v;
      u.lang = v.lang || 'zh-CN';
      u.rate = rate;
      u.onend = u.onerror = function () { busy = false; msg(''); };
      busy = true;
      msg('播放中…');
      ss.speak(u);
    } catch (e) {
      busy = false;
      msg('播放失败：' + ((e && e.message) || e));
    }
  }

  function playLocal(text, spec, rate) {
    var base = (typeof rtBase === 'function') ? rtBase() : '';
    if (!base || typeof fetch !== 'function' || typeof Audio !== 'function') {
      msg('本地语音需要桌面端引擎');
      return;
    }
    var payload = { text: text, engine: spec.engine, rate: rate };
    if (spec.engine === 'kokoro') payload.sid = spec.sid;
    else if (spec.engine === 'piper') payload.voice = spec.voice;
    busy = true;
    msg('合成中…');
    fetch(base + '/tts/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res || !res.ok) {
        return (res && typeof res.json === 'function' ? res.json() : Promise.resolve({}))
          .catch(function () { return {}; })
          .then(function (j) {
            throw new Error((j && j.error) || ('HTTP ' + (res && res.status)));
          });
      }
      return res.blob();
    }).then(function (blob) {
      if (!blob || !blob.size) throw new Error('没有返回音频');
      audioUrl = URL.createObjectURL(blob);
      audio = new Audio(audioUrl);
      audio.onended = audio.onerror = function () {
        stop();
        msg('');
      };
      var p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
      msg('播放中…');
    }).catch(function (e) {
      busy = false;
      msg('试听失败：' + ((e && e.message) || e));
    });
  }

  function play() {
    stop();
    var textEl = $('ttsText');
    var text = String(textEl && textEl.value ? textEl.value : '').trim().slice(0, 80) || FALLBACK_TEXT;
    var rateEl = $('ttsRate');
    var rate = Number(rateEl && rateEl.value) || 1;
    rate = Math.min(1.4, Math.max(0.7, rate));
    writeRate(rate);
    var cur = readVoice();
    var spec = localSpec(cur);
    if (spec) {
      /* 快速合成按所选方式处理：直接朗读剥掉标记；AI 控制没标记时补一层示范节奏 */
      if (spec.engine === 'param') text = fastTextFor(text, readAiMode());
      playLocal(text, spec, rate);
    } else playSystem(text, cur, rate);
  }

  function fastUse() {
    if (!status.param) {
      fastMsg(status.vits
        ? '音库还没生成：在项目目录运行 node tools/distill-voice.js。'
        : '先安装角色音色，再运行 node tools/distill-voice.js 蒸馏音库。');
      return;
    }
    writeVoice('param:fast');
    emitChanged();
    fillVoices();
    paintFast();
    fastMsg('已设为默认音色：试听与数字人朗读都会使用快速合成。');
  }

  function fastPlay() {
    stop();
    var rateEl = $('ttsRate');
    var rate = Number(rateEl && rateEl.value) || 1;
    rate = Math.min(1.4, Math.max(0.7, rate));
    playLocal(fastText(), { engine: 'param' }, rate);
  }

  /* ---------------- 渲染与绑定 ---------------- */

  function bindOnce() {
    if (bound) return;
    bound = true;

    var sel = $('ttsVoiceSel');
    if (sel) {
      sel.addEventListener('change', function () {
        writeVoice(sel.value);
        emitChanged();
      });
    }
    var reload = $('ttsVoiceReload');
    if (reload) reload.addEventListener('click', function () { refreshStatus(); });

    var store = $('ttsStore');
    if (store) {
      store.addEventListener('click', function () {
        if (typeof closeSettings === 'function') closeSettings();
        if (typeof openDeskApp === 'function') openDeskApp('store');
      });
    }

    /* 音色分类页签 + 快速合成的朗读方式 */
    var tabs = ttsScope().querySelectorAll('[data-tts-tab]');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        paintTabs(this.getAttribute('data-tts-tab'));
      });
    }
    var modeBtns = ttsScope().querySelectorAll('[data-ai-mode]');
    for (var j = 0; j < modeBtns.length; j++) {
      modeBtns[j].addEventListener('click', function () {
        writeAiMode(this.getAttribute('data-ai-mode'));
        paintFast();
      });
    }
    var fastUseBtn = $('ttsParamUse');
    if (fastUseBtn) fastUseBtn.addEventListener('click', fastUse);
    var fastPlayBtn = $('ttsParamPlay');
    if (fastPlayBtn) fastPlayBtn.addEventListener('click', fastPlay);

    var rate = $('ttsRate');
    if (rate) {
      rate.addEventListener('input', function () {
        var v = Number(rate.value) || 1;
        var label = $('ttsRateVal');
        if (label) label.textContent = v.toFixed(2);
        writeRate(v);
      });
    }

    var playBtn = $('ttsPlay');
    if (playBtn) playBtn.addEventListener('click', play);
    var stopBtn = $('ttsStop');
    if (stopBtn) stopBtn.addEventListener('click', function () { stop(); msg(''); });

    /* 声音克隆：选录音走主进程文件对话框，文本改动即时落盘 */
    var clonePickBtn = $('ttsClonePick');
    if (clonePickBtn) clonePickBtn.addEventListener('click', clonePick);
    var cloneClearBtn = $('ttsCloneClear');
    if (cloneClearBtn) cloneClearBtn.addEventListener('click', cloneClear);
    var clonePlayBtn = $('ttsClonePlay');
    if (clonePlayBtn) clonePlayBtn.addEventListener('click', clonePlay);
    var cloneTextEl = $('ttsCloneText');
    if (cloneTextEl) cloneTextEl.addEventListener('change', cloneTextCommit);

    var closeBtn = $('btnCloseSettings');
    if (closeBtn) closeBtn.addEventListener('click', stop);

    /* Chromium 的语音列表是异步填充的：不监听这个事件，第一次打开设置
     * 可能只看到「未检测到系统语音」。 */
    try {
      if (window.speechSynthesis && typeof window.speechSynthesis.addEventListener === 'function') {
        window.speechSynthesis.addEventListener('voiceschanged', function () {
          status.sys = systemVoices().length;
          paintStatus();
          fillVoices();
        });
      }
    } catch (e) { /* 没有语音合成能力 */ }
  }

  function ttsPaneRender() {
    if (!$('ttsVoiceSel')) return;
    bindOnce();
    var rate = $('ttsRate');
    if (rate) {
      var r = readRate();
      rate.value = String(r);
      var label = $('ttsRateVal');
      if (label) label.textContent = Number(r).toFixed(2);
    }
    status.sys = systemVoices().length;
    paintStatus();
    fillVoices();
    paintClone();
    /* 默认音色是快速合成时直接落在对应页签，省得用户以为自己选丢了 */
    paintTabs(readVoice() === 'param:fast' ? 'fast' : 'human');
    refreshStatus();
  }

  window.ttsPaneRender = ttsPaneRender;
  window.ttsPaneStop = stop;

  function emitChanged() {
    try { window.dispatchEvent(new CustomEvent('hf-tts-changed')); } catch (e) { /* 老环境没有 CustomEvent */ }
  }

  /* 音色清单快照：系统语音 + 本地模型（含未就绪标记）。
   * 其它 App 的下拉框直接用这份数据渲染，避免各写一套筛选规则。 */
  function buildCatalog() {
    var sys = systemVoices().map(function (v) {
      return { value: v.name, name: v.name, lang: v.lang || '', local: false, ready: true };
    });
    var local = [];
    catalogTts().forEach(function (it) {
      if (it.engine === 'piper') {
        local.push({ value: 'piper:' + it.id, name: 'Piper · ' + it.name, engine: 'piper', local: true, ready: !!status.piper });
      } else if (it.engine === 'kokoro') {
        local.push({ value: 'kokoro:' + it.sid, name: 'Kokoro · ' + it.name, engine: 'kokoro', local: true, ready: !!status.kokoro });
      } else if (it.engine === 'melo') {
        local.push({ value: 'melo:zh_en', name: 'MeloTTS · ' + it.name, engine: 'melo', local: true, ready: !!status.melo });
      } else if (it.engine === 'vits') {
        local.push({
          value: 'vits:theresa', name: 'VITS · ' + it.name,
          engine: 'vits', local: true, ready: !!status.vits
        });
      } else if (it.engine === 'zipvoice') {
        local.push({
          value: 'zipvoice:clone', name: 'ZipVoice · 我的克隆声音', engine: 'zipvoice', local: true,
          ready: !!(status.zipvoice && status.clone),
          needRef: !!(status.zipvoice && !status.clone)
        });
      }
    });
    /* 参数合成不是下载项：音库蒸馏完成后直接进清单，供数字人等 App 选用 */
    if (status.param) {
      local.push({ value: 'param:fast', name: '参数合成 · 快问快答', engine: 'param', local: true, ready: true });
    }
    /* 系统机械音不是下载项：Windows 自带 SAPI，用来做参数控制的对照实验 */
    if (status.sapi) {
      local.push({ value: 'sys:std', name: '系统机械音 · SAPI', engine: 'sys', local: true, ready: true });
    }
    return {
      system: sys,
      local: local,
      status: {
        sys: sys.length, piper: !!status.piper, kokoro: !!status.kokoro, melo: !!status.melo,
        vits: !!status.vits, zipvoice: !!status.zipvoice, param: !!status.param, clone: !!status.clone,
        sapi: !!status.sapi, refText: status.refText, probed: !!status.probed
      },
      defaultVoice: readVoice(),
      rate: readRate(),
      probed: !!status.probed
    };
  }

  /* 给其它 App（剪辑台等）复用的合成入口。
   * 系统语音无法捕获成音频文件，只有本地音色（piper / kokoro）能落成素材；
   * 调用方拿 blob URL 即可播放 / 导出，是否持久化由调用方决定。 */
  window.ttsBridge = {
    defaultVoice: readVoice,
    defaultRate: readRate,
    /* 音色清单：同步返回当前快照；传 { refresh:true } 会先探测本地引擎再 resolve */
    catalog: function (opt) {
      var o = opt || {};
      if (!o.refresh) return buildCatalog();
      return refreshStatus().then(buildCatalog, buildCatalog);
    },
    label: function (value) {
      var v = (value == null ? readVoice() : String(value));
      var local = localLabel(v);
      if (local) return local;
      return v || '系统默认';
    },
    spec: function (value) { return localSpec(value == null ? readVoice() : value); },
    /* 音调只有系统语音生效，本地模型由权重决定 */
    supportsPitch: function (value) { return !localSpec(value == null ? readVoice() : value); },
    openSettings: function () {
      if (typeof window.openSettings === 'function') window.openSettings('tts');
    },
    isLocal: function (value) { return !!localSpec(value == null ? readVoice() : value); },
    speak: function (text, opt) {
      var o = opt || {};
      var value = (o.voice == null ? readVoice() : String(o.voice));
      var spec = localSpec(value);
      if (!spec) {
        return Promise.reject(new Error('当前音色是系统语音，无法导出音频；请先在模型商店下载本地音色'));
      }
      var base = (typeof rtBase === 'function') ? rtBase() : '';
      if (!base || typeof fetch !== 'function') {
        return Promise.reject(new Error('本地语音需要桌面端引擎'));
      }
      var rate = Math.min(1.4, Math.max(0.7, Number(o.rate) || 1));
      var payload = { text: String(text || '').slice(0, 2000), rate: rate };
      if (spec.engine === 'kokoro') { payload.engine = 'kokoro'; payload.sid = spec.sid; }
      else if (spec.engine === 'melo') payload.engine = 'melo';
      else if (spec.engine === 'vits') payload.engine = 'vits';
      else if (spec.engine === 'zipvoice') payload.engine = 'zipvoice';
      else if (spec.engine === 'param') {
        payload.engine = 'param';
        payload.pitch = Math.min(1.5, Math.max(0.7, Number(o.pitch) || 1));
      }
      else if (spec.engine === 'sys') { payload.engine = 'sys'; }
      else { payload.engine = 'piper'; payload.voice = spec.voice; }
      return fetch(base + '/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (res) {
        if (!res || !res.ok) {
          return (res && typeof res.json === 'function' ? res.json() : Promise.resolve({}))
            .catch(function () { return {}; })
            .then(function (j) {
              throw new Error((j && j.error) || ('HTTP ' + (res && res.status)));
            });
        }
        return res.blob();
      }).then(function (blob) {
        if (!blob || !blob.size) throw new Error('本地语音合成没有返回音频');
        return { url: URL.createObjectURL(blob), blob: blob, voice: value, rate: rate };
      });
    }
  };
})();
