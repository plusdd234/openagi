/* ======================= 名片 App =======================
 * 一张开发者名片：我是谁、在做什么、在哪能找到我、怎么请我喝咖啡。
 *
 * 设计上只有一条硬规矩：**所有文案集中在下面的 CD 常量里**。
 * 名片这种东西改字比改代码勤，散在 render 函数里就等于每次改都要读一遍 HTML 拼接。
 *
 * 数据来源：B 站公开主页与公开接口（space.bilibili.com/641892012），
 * 2026-10-29 取。粉丝/播放这类数字会变，改的时候只动 CD 即可。
 */
(function(){
  'use strict';

  const CD = {
    name: '虚幻茅场',
    uid: '641892012',
    level: 'LV5',
    /* 主阵地是 B 站，这句话要排在最前面——「虚幻引擎 / AI 建模」是内容标签，
     * 「B 站 UP 主」才是身份标签，顺序错了会让人以为这是随便哪个平台的作者。 */
    tag: '哔哩哔哩 UP 主 · 虚幻引擎 / AI 建模工作流',
    brand: '哔哩哔哩',
    avatar: 'img/avatar.jpg',
    avatarFallback: '虚',
    stats: [
      { k: 'B 站粉丝', v: '7,890' },
      { k: 'B 站投稿', v: '103'   },
      { k: '合集',     v: '7'     },
      { k: '充电',     v: '29 人' }
    ],
    pay: {
      /* 换赞赏码 = 直接换这个文件，不设「换一张」按钮（用户明确不要）。
       * 二维码图请用微信原生那张，别用美化过的——圆点/放射装饰会压识别率。 */
      img: 'img/pay-qr.png',
      title: '请我喝杯咖啡',
      note: '微信扫码赞赏 · 感谢每一份充电',
      missing: '把赞赏码放到 img/pay-qr.png'
    },
    about: [
      '虚幻引擎（UE5）技术 UP 主。做三件事：把蓝图和 C++ 的底层机制讲清楚，拆材质与动效的原理，以及把 AI 接进 3D 建模的整条流水线。',
      '内容偏「能照着做出来」——蓝图笔记一集一个知识点，C++ 系列每期压进 10 分钟。手上还有一个 UE5 独立游戏在写开发日志，从轮盘摇杆做到深度描边。'
    ],
    tracks: [
      { n: '虚幻蓝图', c: '19 集', g: 'flow',
        d: 'actor 类内节点、12 种 get 与 6 种 set 变换函数，按笔记节奏一期一期推' },
      { n: '虚幻 C++', c: '19 集', g: 'code',
        d: 'UE_LOG / DEFINE_LOG / FString / 蓝图继承 C++，每期压到 10 分钟内' },
      { n: 'AI 建模工作流', c: '22 集', g: 'spark',
        d: 'GPT Image 出原画、Meshy 与混元出模，再到消除纹理幻觉的收尾' },
      { n: 'UE5 独立游戏', c: '6 集', g: 'game',
        d: '轮盘、摇杆、骨架重绘蒙皮、仿崩坏3的攻速与后摇，边做边记' }
    ],
    works: [
      { t: '虚幻引擎蓝图系统学习笔记（1）',                    col: '蓝图笔记（重置版）',   n: 19, play: '1.1 万' },
      { t: '第二课：GPT image2 生成原画总参考',                col: 'ai 建模免费教程',      n: 7,  play: '7689'   },
      { t: 'AI 二次元人物模型贴图工作流',                      col: 'AI 工作流迭代合集',    n: 15, play: '6038'   },
      { t: 'UE 虚幻引擎零基础 2D 游戏制作教程（主角移动）',     col: '蓝图新手入门',         n: 6,  play: '6051'   },
      { t: '虚幻引擎动效材质零基础入门教程',                    col: '材质动效教程',         n: 4,  play: '4677'   },
      { t: '虚幻引擎 5 uc++ 入土指南第零期：萌新必看及避雷',    col: 'C++ 入门系列',         n: 19, play: '3796'   },
      { t: '仿英雄联盟手游轮盘及其实现思路',                    col: 'UE5 独立游戏开发日志', n: 6,  play: '1337'   }
    ],
    /* 「技术交流群」不在这里再列一遍——下面有整张群卡（码 + 群号 + 复制），
     * 同一件事在同一栏出现两次，人会先怀疑「这两个是同一个吗」。 */
    links: [
      { k: 'B 站主页', v: '@虚幻茅场', url: 'https://space.bilibili.com/641892012', main: true },
      { k: '直播间',   v: '23635391',  url: 'https://live.bilibili.com/23635391'     }
    ],
    group: {
      /* QQ 群。B 站简介里挂的那串 931374446 是旧群，这里用新的 3 群。 */
      name: '虚幻引擎蓝图笔记3群',
      id: '1108459704',
      img: 'img/qq-group.png',
      missing: '把 QQ 群二维码放到 img/qq-group.png'
    },
    foot: '数据取自 B 站公开主页 · 2026-10-29'
  };

  /* 小图标：全部 24×24 线框，跟桌面 App 图标同一套语言（stroke 1.7、圆头圆角） */
  const G = {
    flow:  '<rect x="3" y="4" width="7" height="5" rx="1.4"/><rect x="14" y="15" width="7" height="5" rx="1.4"/><path d="M10 6.5h3.5a3 3 0 0 1 3 3V15"/>',
    code:  '<path d="m8.6 8.4-4 3.6 4 3.6M15.4 8.4l4 3.6-4 3.6"/>',
    spark: '<path d="M12 3.2 13.9 8l4.8 1.9-4.8 1.9L12 16.6l-1.9-4.8L5.3 9.9 10.1 8 12 3.2Z"/><path d="M18.4 15.2l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z"/>',
    game:  '<rect x="2.6" y="7.4" width="18.8" height="9.2" rx="4.4"/><path d="M6.6 12h3M8.1 10.5v3"/><circle cx="16.4" cy="11.4" r=".9" fill="currentColor" stroke="none"/><circle cx="18.3" cy="13.3" r=".9" fill="currentColor" stroke="none"/>',
    play:  '<path d="M9 7.6 16 12l-7 4.4z"/>',
    link:  '<path d="M10.6 13.4a3.4 3.4 0 0 0 4.8 0l2.4-2.4a3.4 3.4 0 0 0-4.8-4.8l-1 1"/><path d="M13.4 10.6a3.4 3.4 0 0 0-4.8 0l-2.4 2.4a3.4 3.4 0 0 0 4.8 4.8l1-1"/>',
    live:  '<rect x="2.6" y="6.4" width="14" height="11.2" rx="2.2"/><path d="m16.6 11 4.8-2.6v7.2L16.6 13z"/>',
    group: '<circle cx="9" cy="9.4" r="3"/><path d="M3.4 19.2c.5-3 2.8-4.6 5.6-4.6s5.1 1.6 5.6 4.6"/><path d="M16.2 7.2a2.8 2.8 0 0 1 0 5.4"/><path d="M17.4 14.8c1.8.5 3 2 3.3 4.4"/>',
    /* B 站：小电视 + 两根天线 + 两条竖眼。这是它的品牌形状，比一个通用「电视」
     * 图标更能让人一眼认出「主战场在这儿」。 */
    bili:  '<rect x="2.6" y="7.2" width="18.8" height="12.2" rx="3.2"/><path d="m7.7 3.4 2.6 3.4M16.3 3.4l-2.6 3.4"/><path d="M8.8 11v4.4M15.2 11v4.4"/>'
  };
  function svg(kind, cls){
    const p = G[kind] || G.flow;
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  function $(id){ return document.getElementById(id); }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  /* 外链一律 target=_blank + noopener：Electron 侧由 main.js 的
   * setWindowOpenHandler 交给 shell.openExternal。
   * 用 location.href 会把整个应用页导航走（这是踩过的坑）。 */
  function openLink(url){
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const state = { painted: false, tip: '' };

  /* ---------- 渲染 ---------- */

  function renderHero(){
    const name = $('cdName');
    if(name) name.textContent = CD.name;
    const lv = $('cdLv');
    if(lv) lv.textContent = CD.level;
    const tag = $('cdTag');
    /* 小电视图标放在「哔哩哔哩 UP 主」前面：身份是平台给的，内容才是自己的，
     * 先看见平台再看见方向，顺序不能反。 */
    if(tag) tag.innerHTML = svg('bili', 'cd-tag-ico') + '<span>' + esc(CD.tag) + '</span>';
    const uid = $('cdUid');
    if(uid) uid.textContent = 'UID ' + CD.uid;

    const img = $('cdAva');
    if(img){
      img.onerror = () => {
        /* 头像丢了就退回文字头像，别留一个破图框 */
        img.classList.add('hidden');
        const fb = img.parentElement && img.parentElement.querySelector('.cd-ava-fb');
        if(fb) fb.classList.add('show');
      };
      if(img.getAttribute('src') !== CD.avatar) img.src = CD.avatar;
    }
    const fbTxt = document.querySelector('#cardWin .cd-ava-fb');
    if(fbTxt) fbTxt.textContent = CD.avatarFallback;
  }

  function renderStats(){
    const box = $('cdStats');
    if(!box) return;
    box.innerHTML = CD.stats.map(s =>
      '<div class="cd-stat"><span class="cd-stat-v">' + esc(s.v) + '</span>'
      + '<span class="cd-stat-k">' + esc(s.k) + '</span></div>'
    ).join('');
  }

  function renderAbout(){
    const box = $('cdAbout');
    if(!box) return;
    box.innerHTML = CD.about.map(p => '<p class="cd-p">' + esc(p) + '</p>').join('');
  }

  function renderTracks(){
    const box = $('cdTracks');
    if(!box) return;
    box.innerHTML = CD.tracks.map(t =>
      '<div class="cd-track">'
      + '<div class="cd-track-h">' + svg(t.g, 'cd-track-ico')
      + '<span class="cd-track-n">' + esc(t.n) + '</span>'
      + '<span class="cd-track-c">' + esc(t.c) + '</span></div>'
      + '<div class="cd-track-d">' + esc(t.d) + '</div>'
      + '</div>'
    ).join('');
  }

  function renderWorks(){
    const box = $('cdWorks');
    if(!box) return;
    /* 两列：7 个合集单列排要 280px，窗口装不下就会把最后两条推到滚动区外——
     * 那两条恰好是 C++ 和独立游戏，等于把「他还会这些」藏起来了。两列省一半高度。 */
    box.innerHTML = CD.works.map(w =>
      '<button type="button" class="cd-work" data-url="https://space.bilibili.com/' + esc(CD.uid) + '/video" '
      + 'title="' + esc(w.t) + ' · 去 B 站看这个系列">'
      + svg('play', 'cd-work-ico')
      + '<span class="cd-work-main">'
      + '<span class="cd-work-t">' + esc(w.t) + '</span>'
      + '<span class="cd-work-m">' + esc(w.col) + ' · ' + w.n + ' 集</span>'
      + '</span>'
      + '<span class="cd-work-p">' + esc(w.play) + '</span>'
      + '</button>'
    ).join('');
    /* 逐列填充：默认 grid 是逐行排的，视线会左右跳（1→2 换一次列）。
     * 先读完左列再读右列才符合列表的阅读习惯，所以要把行数告诉 CSS。
     * 走 CSS 变量而不是 inline 的 gridTemplateRows —— inline 样式会盖住
     * 窄屏 media query 里的「改回单列」，优先级比媒体查询高。 */
    box.style.setProperty('--cd-work-rows', String(Math.max(1, Math.ceil(CD.works.length / 2))));
    box.querySelectorAll('.cd-work').forEach(b => {
      b.addEventListener('click', () => openLink(b.dataset.url));
    });
  }

  function renderLinks(){
    const box = $('cdLinks');
    if(!box) return;
    const ico = { 'B 站主页': 'bili', '直播间': 'live', '交流群': 'group' };
    box.innerHTML = CD.links.map(l =>
      '<div class="cd-link' + (l.main ? ' is-main' : '') + '" data-url="' + esc(l.url || '') + '" data-copy="' + esc(l.copy || '') + '">'
      + svg(ico[l.k] || 'link', 'cd-link-ico')
      + '<span class="cd-link-k">' + esc(l.k) + '</span>'
      + '<span class="cd-link-v">' + esc(l.v) + '</span>'
      + (l.copy ? '<span class="cd-link-act">复制</span>' : '<span class="cd-link-act">↗</span>')
      + '</div>'
    ).join('');
    box.querySelectorAll('.cd-link').forEach(row => {
      row.addEventListener('click', () => {
        if(row.dataset.copy) copyText(row.dataset.copy, '群号已复制');
        else if(row.dataset.url) openLink(row.dataset.url);
      });
    });
  }

  function renderFoot(){
    const el = $('cdFoot');
    if(el) el.textContent = CD.foot;
  }

  /* ---------- 技术交流群 ---------- */
  function renderGroup(){
    const name = $('cdGroupName');
    if(name) name.textContent = CD.group.name;
    const id = $('cdGroupId');
    if(id) id.textContent = '群号 ' + CD.group.id;
    const cp = $('cdCopyGroup');
    if(cp) cp.dataset.copy = CD.group.id;

    const img = $('cdGroupQr');
    const fb = $('cdGroupFb');
    if(!img) return;
    img.onerror = () => {
      img.classList.add('hidden');
      if(fb){ fb.textContent = CD.group.missing; fb.classList.add('show'); }
    };
    img.onload = () => {
      img.classList.remove('hidden');
      if(fb) fb.classList.remove('show');
    };
    img.src = CD.group.img;
    img.alt = CD.group.name + ' 的 QQ 群二维码';
  }

  /* ---------- 赞赏码 ---------- */

  /* 只显示一张固定的码（不做「换一张」的入口）。
   * 要换码 = 直接替换 img/pay-qr.png 这个文件，改文件比在界面里点五步更省事。
   * 图请用微信原生那张方形赞赏码：圆点/放射状的美化码会压识别率，
   * 中心头像盖住定位图案后，标准解码器基本解不出来。 */
  function loadPay(){
    const img = $('cdQr');
    const fb = $('cdQrFb');
    if(!img) return;
    img.onerror = () => {
      /* 图丢了（漏打包 / 改过文件名）就给一块说明，别留一个破图框 */
      img.classList.add('hidden');
      if(fb){ fb.textContent = CD.pay.missing; fb.classList.add('show'); }
    };
    img.onload = () => {
      img.classList.remove('hidden');
      if(fb) fb.classList.remove('show');
    };
    img.src = CD.pay.img;
    img.alt = CD.pay.title + '的微信赞赏码';
    const t = $('cdPayTitle');
    if(t) t.textContent = CD.pay.title;
    const s = $('cdPayS');
    if(s) s.textContent = CD.pay.note;
  }

  /* ---------- 小交互 ---------- */

  let toastTimer = 0;
  function toast(msg){
    let el = document.getElementById('cdToast');
    if(!el){
      el = document.createElement('div');
      el.id = 'cdToast';
      el.className = 'cd-toast';
      const win = $('cardWin');
      (win || document.body).appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
  }

  function copyText(text, okMsg){
    const done = () => toast(okMsg || '已复制');
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    }else{
      fallbackCopy(text, done);
    }
  }
  function fallbackCopy(text, done){
    /* clipboard API 在 file:// 下常常被拒（非安全上下文），退到老办法 */
    try{
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    }catch(e){ toast('复制失败，手动选一下：' + text); }
  }

  /* ---------- 生命周期 ---------- */

  let bound = false;
  function ensureBind(){
    if(bound) return;
    bound = true;

    const close = $('btnCardWinClose');
    if(close) close.addEventListener('click', () => closeCard());

    const cp = $('cdCopyUid');
    if(cp) cp.addEventListener('click', e => {
      e.stopPropagation();
      copyText(cp.dataset.copy || CD.uid, 'UID 已复制');
    });

    /* 群号也能点一下复制：二维码扫不了的时候（比如在手机上看到这个页面），
     * 复制群号去 QQ 里搜是唯一的路。 */
    const gcopy = $('cdCopyGroup');
    if(gcopy) gcopy.addEventListener('click', e => {
      e.stopPropagation();
      copyText(gcopy.dataset.copy || CD.group.id, '群号已复制');
    });
  }

  function paint(force){
    if(state.painted && !force) return;
    state.painted = true;
    renderHero();
    renderStats();
    renderAbout();
    renderTracks();
    renderWorks();
    renderLinks();
    renderFoot();
    renderGroup();
    loadPay();
  }

  function open(){
    const win = $('cardWin');
    if(!win) return false;
    ensureBind();
    const meta = (typeof DESK_APP_META !== 'undefined' && DESK_APP_META.card) || { title: '名片', sub: '开发者名片' };

    /* 名片是纯静态内容，不需要骨架屏：渲染是同步的，一帧就画完。
     * 但翻页动效还是走统一入口，否则 << 返回会拿不到窗口归属。 */
    if(typeof deskMountApp === 'function') deskMountApp(win, meta.title, meta.sub);
    else win.classList.remove('hidden');
    paint();
    return true;
  }

  function closeCard(){
    const win = $('cardWin');
    if(!win) return;
    if(typeof deskAppLeave === 'function' && win.parentElement && win.parentElement.id === 'deskAppHost'){
      deskAppLeave();
    }else{
      win.classList.add('hidden');
    }
  }

  window.devCard = {
    open,
    close: closeCard,
    /* 换文案/换码不用改代码：控制台里 devCard.data.name = 'xxx'; devCard.refresh()。
     * 二维码是文件（img/pay-qr.png、img/qq-group.png），换图直接换文件，没有换图按钮。 */
    data: CD,
    refresh: () => paint(true),
    _pure: { esc }
  };
})();
