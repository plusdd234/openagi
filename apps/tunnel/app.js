/* 分享与反馈 —— 一键把本机变成「可上传、可反馈」的公网入口。
 *
 * 服务本身在 plugins/tunnel/tunnel.js（主进程按 plugins/manifest.json 拉起），
 * 这里只是控制面板：启动 / 停止隧道、看公网地址、管口令与上限、看收到的文件和反馈。
 *
 * 端口来源：桌面壳通过 ?tunnel=http://127.0.0.1:<port> 注入（被占用时端口会顺延）。
 * 用 file:// 直接打开时没有这个参数，退回默认 8796。
 */
(function () {
  'use strict';

  const BASE = (function () {
    try {
      const v = new URLSearchParams(location.search).get('tunnel');
      return v ? decodeURIComponent(v).replace(/\/+$/, '') : 'http://127.0.0.1:8796';
    } catch (e) { return 'http://127.0.0.1:8796'; }
  })();

  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 16V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"/></svg>';

  const BODY =
    '<div class="tn-wrap">' +
      '<div class="tn-head">' +
        '<div class="tn-title">' +
          '<div class="tn-h">分享与反馈</div>' +
          '<div class="tn-sub">启动后，任何拿到链接的人都能上传资源、提交意见，文件直接落在你这台机器上。</div>' +
        '</div>' +
        '<div class="tn-badge" id="tnBadge"><i></i><span>服务未连接</span></div>' +
      '</div>' +

      '<section class="tn-hero">' +
        '<div class="tn-url-line">' +
          '<div class="tn-url" id="tnUrl">尚未生成公网地址</div>' +
          '<button type="button" class="tn-btn" id="tnCopy" disabled>复制</button>' +
          '<button type="button" class="tn-btn" id="tnOpen" disabled>打开</button>' +
        '</div>' +
        '<div class="tn-actions">' +
          '<button type="button" class="tn-btn tn-primary" id="tnToggle">启动分享</button>' +
          '<span class="tn-state" id="tnState">未启动</span>' +
        '</div>' +
        '<div class="tn-meta" id="tnMeta"></div>' +
        '<div class="tn-warn">公网地址每次启动都会变；链接相当于门钥匙，请只发给信任的人。</div>' +
      '</section>' +

      '<div class="tn-grid">' +
        '<section class="tn-card">' +
          '<div class="tn-card-h">访问口令</div>' +
          '<label class="tn-switch"><input type="checkbox" id="tnKeyOn"><span>启用口令保护</span></label>' +
          '<div class="tn-key-row">' +
            '<input type="text" id="tnKey" readonly spellcheck="false">' +
            '<button type="button" class="tn-btn tn-mini" id="tnRegen">换一个</button>' +
          '</div>' +
          '<div class="tn-tip">分享链接会自动带上口令。关掉口令后，任何人只要有链接就能上传。</div>' +
        '</section>' +

        '<section class="tn-card">' +
          '<div class="tn-card-h">接收设置</div>' +
          '<label class="tn-field"><span>单文件上限</span>' +
            '<input type="number" id="tnMax" min="1" max="2048" step="10"> <em>MB</em></label>' +
          '<label class="tn-switch"><input type="checkbox" id="tnFbOn"><span>开放意见反馈</span></label>' +
          '<label class="tn-field tn-field-col"><span>页面说明</span>' +
            '<input type="text" id="tnNote" maxlength="300" placeholder="写给访问者的一句话"></label>' +
          '<div class="tn-save-row"><button type="button" class="tn-btn tn-primary tn-mini" id="tnSave">保存设置</button>' +
          '<button type="button" class="tn-btn tn-mini" id="tnReveal">打开上传目录</button></div>' +
        '</section>' +
      '</div>' +

      '<div class="tn-tabs">' +
        '<button type="button" class="tn-tab on" data-tab="up">收到的文件 <b id="tnUpCount">0</b></button>' +
        '<button type="button" class="tn-tab" data-tab="fb">意见反馈 <b id="tnFbCount">0</b></button>' +
      '</div>' +
      '<div class="tn-panel" id="tnPanel"><div class="tn-empty">还没有内容。</div></div>' +

      '<details class="tn-log">' +
        '<summary>运行日志</summary>' +
        '<pre id="tnLogs">—</pre>' +
      '</details>' +
    '</div>';

  let timer = null;
  let busy = false;
  let tab = 'up';
  let lastList = { up: '', fb: '' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(n) {
    const v = Number(n || 0);
    if (v < 1024) return v + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
    return (v / 1073741824).toFixed(2) + ' GB';
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  async function api(path, opts) {
    const r = await fetch(BASE + path, Object.assign({ cache: 'no-store' }, opts || {}));
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }

  function shareUrl(st) {
    if (!st || !st.tunnel || !st.tunnel.url) return '';
    const k = st.config && st.config.keyOn && st.config.key ? ('?k=' + encodeURIComponent(st.config.key)) : '';
    return st.tunnel.url + '/' + k;
  }

  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function setState(body, st) {
    body._st = st;
    const url = shareUrl(st);
    const urlEl = body.querySelector('#tnUrl');
    const copyBtn = body.querySelector('#tnCopy');
    const openBtn = body.querySelector('#tnOpen');
    const badge = body.querySelector('#tnBadge');
    const stateEl = body.querySelector('#tnState');
    const metaEl = body.querySelector('#tnMeta');
    const toggle = body.querySelector('#tnToggle');

    urlEl.textContent = url || '尚未生成公网地址';
    urlEl.classList.toggle('on', !!url);
    copyBtn.disabled = !url;
    openBtn.disabled = !url;

    const t = st.tunnel || {};
    const running = t.status === 'running';
    const starting = t.status === 'starting';
    badge.className = 'tn-badge' + (running ? ' ok' : starting ? ' wait' : t.status === 'error' ? ' err' : '');
    badge.querySelector('span').textContent = running ? '公网可访问' : starting ? '正在启动' : t.status === 'error' ? '启动失败' : '未启动';

    toggle.textContent = running || starting ? '停止分享' : '启动分享';
    toggle.classList.toggle('tn-stop', running || starting);

    if (st.download && st.download.running) {
      stateEl.textContent = '正在下载 cloudflared ' + (st.download.pct || 0) + '%' +
        (st.download.bytesPerSec ? ' · ' + Math.max(1, Math.round(st.download.bytesPerSec / 1024)) + ' KB/s' : '') +
        (st.download.source ? ' · ' + st.download.source : '');
    } else if (starting) {
      stateEl.textContent = '正在协商公网地址…';
    } else if (running) {
      stateEl.textContent = '已连接 Cloudflare';
    } else if (t.status === 'error') {
      stateEl.textContent = t.error || '启动失败';
    } else {
      stateEl.textContent = '未启动';
    }
    stateEl.classList.toggle('bad', t.status === 'error');

    const c = st.config || {};
    metaEl.textContent = '本地服务 ' + (st.local || '') + ' · 上传文件 ' +
      ((st.counts && st.counts.uploads) || 0) + ' 份 · 反馈 ' + ((st.counts && st.counts.feedback) || 0) + ' 条';

    const keyOn = body.querySelector('#tnKeyOn');
    if (document.activeElement !== keyOn) keyOn.checked = c.keyOn !== false;
    const keyEl = body.querySelector('#tnKey');
    if (document.activeElement !== keyEl) keyEl.value = c.key || '';
    const maxEl = body.querySelector('#tnMax');
    if (document.activeElement !== maxEl) maxEl.value = c.maxMB || 200;
    const fbEl = body.querySelector('#tnFbOn');
    if (document.activeElement !== fbEl) fbEl.checked = c.feedbackOn !== false;
    const noteEl = body.querySelector('#tnNote');
    if (document.activeElement !== noteEl) noteEl.value = c.note || '';

    body.querySelector('#tnUpCount').textContent = String((st.counts && st.counts.uploads) || 0);
    body.querySelector('#tnFbCount').textContent = String((st.counts && st.counts.feedback) || 0);

    const logEl = body.querySelector('#tnLogs');
    const logs = (st.logs || []).map(x => fmtTime(x.at) + '  ' + x.text).join('\n');
    if (logEl.textContent !== logs) logEl.textContent = logs || '—';
  }

  function offline(body, err) {
    body._st = null;
    const badge = body.querySelector('#tnBadge');
    badge.className = 'tn-badge err';
    badge.querySelector('span').textContent = '服务未连接';
    body.querySelector('#tnState').textContent = '无法连接本地服务（' + BASE + '）';
    body.querySelector('#tnState').classList.add('bad');
    body.querySelector('#tnMeta').textContent = '桌面端启动时会自动拉起该服务；浏览器直开 index.html 时没有它。';
    body.querySelector('#tnUrl').textContent = '尚未生成公网地址';
    body.querySelector('#tnCopy').disabled = true;
    body.querySelector('#tnOpen').disabled = true;
    body.querySelector('#tnToggle').textContent = '启动分享';
    body.querySelector('#tnLogs').textContent = err ? String(err.message || err) : '—';
  }

  function renderList(body, st, up, fb) {
    const panel = body.querySelector('#tnPanel');
    if (tab === 'up') {
      const items = (up && up.items) || [];
      const key = 'u' + items.length + '|' + items.map(x => x.name + x.size + x.at).join(',');
      if (lastList.up === key) return;
      lastList.up = key;
      if (!items.length) {
        panel.innerHTML = '<div class="tn-empty">还没有收到文件。把链接发给朋友后，这里会出现他们的上传。</div>';
        return;
      }
      panel.innerHTML = items.map(x =>
        '<div class="tn-item">' +
          '<div class="tn-item-main">' +
            '<div class="tn-item-name" title="' + esc(x.name) + '">' + esc(x.name) + '</div>' +
            '<div class="tn-item-sub">' + fmtSize(x.size) + ' · ' + fmtTime(x.at) +
              (x.note ? ' · ' + esc(x.note) : '') + '</div>' +
          '</div>' +
        '</div>'
      ).join('');
    } else {
      const items = (fb && fb.items) || [];
      const key = 'f' + items.length + '|' + items.map(x => x.at + x.text.length).join(',');
      if (lastList.fb === key) return;
      lastList.fb = key;
      if (!items.length) {
        panel.innerHTML = '<div class="tn-empty">还没有收到反馈。</div>';
        return;
      }
      panel.innerHTML = items.map(x =>
        '<div class="tn-item">' +
          '<div class="tn-item-main">' +
            '<div class="tn-item-sub">' + esc(x.name || '匿名') +
              (x.contact ? ' · ' + esc(x.contact) : '') + ' · ' + fmtTime(x.at) + '</div>' +
            '<div class="tn-item-text">' + esc(x.text) + '</div>' +
          '</div>' +
        '</div>'
      ).join('');
    }
  }

  async function refresh(body, opts) {
    try {
      const st = await api('/api/status');
      setState(body, st);
      if (opts && opts.list) {
        const [up, fb] = await Promise.all([
          api('/api/uploads').catch(() => ({ items: [] })),
          api('/api/feedback').catch(() => ({ items: [] }))
        ]);
        renderList(body, st, up, fb);
      } else if (st.counts) {
        // 计数变化时才拉列表，避免每 3 秒重建 DOM
        const changed = Number(body.dataset.upN || 0) !== Number(st.counts.uploads || 0) ||
          Number(body.dataset.fbN || 0) !== Number(st.counts.feedback || 0);
        if (changed) {
          body.dataset.upN = String(st.counts.uploads || 0);
          body.dataset.fbN = String(st.counts.feedback || 0);
          const [up, fb] = await Promise.all([
            api('/api/uploads').catch(() => ({ items: [] })),
            api('/api/feedback').catch(() => ({ items: [] }))
          ]);
          renderList(body, st, up, fb);
        }
      }
    } catch (e) {
      offline(body, e);
    }
  }

  async function withBusy(body, fn) {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) {
      body.querySelector('#tnState').textContent = e.message || String(e);
      body.querySelector('#tnState').classList.add('bad');
    }
    busy = false;
  }

  function bind(body) {
    body.querySelector('#tnToggle').addEventListener('click', () => withBusy(body, async () => {
      const st = body._st;
      const on = st && st.tunnel && (st.tunnel.status === 'running' || st.tunnel.status === 'starting');
      await api(on ? '/api/tunnel/stop' : '/api/tunnel/start', { method: 'POST' });
      await new Promise(r => setTimeout(r, 400));
      await refresh(body, { list: true });
    }));

    body.querySelector('#tnCopy').addEventListener('click', async () => {
      const st = body._st;
      const url = shareUrl(st);
      if (!url) return;
      const ok = await copyText(url);
      const el = body.querySelector('#tnState');
      el.textContent = ok ? '链接已复制' : '复制失败，请手动选中地址';
      el.classList.toggle('bad', !ok);
      setTimeout(() => refresh(body), 1600);
    });

    body.querySelector('#tnOpen').addEventListener('click', () => {
      const url = shareUrl(body._st);
      if (url) window.open(url, '_blank');
    });

    body.querySelector('#tnRegen').addEventListener('click', () => withBusy(body, async () => {
      await api('/api/key/regen', { method: 'POST' });
      await refresh(body);
    }));

    body.querySelector('#tnSave').addEventListener('click', () => withBusy(body, async () => {
      await api('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          keyOn: body.querySelector('#tnKeyOn').checked,
          feedbackOn: body.querySelector('#tnFbOn').checked,
          maxMB: Number(body.querySelector('#tnMax').value) || 200,
          note: body.querySelector('#tnNote').value
        })
      });
      const el = body.querySelector('#tnState');
      el.textContent = '设置已保存';
      el.classList.remove('bad');
      setTimeout(() => refresh(body), 1400);
    }));

    body.querySelector('#tnReveal').addEventListener('click', () => {
      api('/api/reveal', { method: 'POST' }).catch(() => {});
    });

    body.querySelectorAll('.tn-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        tab = btn.dataset.tab;
        body.querySelectorAll('.tn-tab').forEach(b => b.classList.toggle('on', b === btn));
        lastList.up = '';
        lastList.fb = '';
        refresh(body, { list: true });
      });
    });
  }

  registerApp({
    id: 'tunnel',
    name: '分享与反馈',
    title: '分享与反馈',
    barTitle: '分享与反馈 · 免费内网穿透',
    sub: '把本机变成上传与反馈入口',
    icon: ICON,
    order: 62,
    css: ['apps/tunnel/app.css'],

    mount: function (body) {
      if (body.dataset.ready === '1') {
        refresh(body, { list: true });
        return;
      }
      body.innerHTML = BODY;
      bind(body);
      body.dataset.ready = '1';
      refresh(body, { list: true });
      if (!timer) {
        timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return;
          if (body.isConnected) refresh(body);
        }, 3000);
      }
    }
  });
})();
