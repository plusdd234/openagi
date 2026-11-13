/* 模板 App：你好
 *
 * 复制这个目录改名就是新 App 的全部工作：
 *   1. 改 id / name / title（id 必须全项目唯一，它是标签和注册表的键）
 *   2. 改 mount() 里的界面
 *   3. 跑一次 node tools/app-scan.js 生成清单
 * index.html、desk-shell.js 一行都不用碰。
 *
 * ⚠ 三条最容易踩的（都不是语法问题，是「看着能跑但会坏」的那种）：
 * ① 整个文件包在 IIFE 里。不然这里的顶层函数会挂到那个 1165 个名字共享的 window 作用域上，
 *    和别的 App 撞名时 git 不报错、运行时时静默覆盖（用 node tools/ns-guard.js 能查出来）。
 * ② mount() 必须幂等。openDeskApp 每次翻到这个 App 都会调 open() → mount()，
 *    不是只调第一次。直接重建 innerHTML 会把用户刚输入的、刚滚动到的位置全冲掉。
 *    判据用 body.dataset.ready，画过一次就只做「刷新」不做「重建」。
 * ③ 不许写盘、不许碰 window.openagiDesktop。第三方的 App 将来会跑在同一个渲染进程里，
 *    这条线现在靠自觉，以后再收紧到能力白名单。
 */
(function () {
  'use strict';

  let openCount = 0;

  function stat(text) {
    const lines = text.length ? text.split('\n').length : 0;
    return { chars: text.length, lines: lines };
  }

  function render(body) {
    const ta = body.querySelector('.hello-in');
    const out = body.querySelector('.hello-out');
    const meta = body.querySelector('.hello-meta');
    const text = ta.value;

    /* 演示「一次能力调用」的位置：真正接 AI 时这里换成 llmConn() + 流式写 out */
    out.textContent = text ? text.split('').reverse().join('') : '（上面输入点什么）';

    const s = stat(text);
    meta.textContent = s.chars + ' 字 · ' + s.lines + ' 行 · 本会话打开 ' + openCount + ' 次';
  }

  registerApp({
    id: 'hello',
    name: '你好',
    title: '你好 · 模板 App',
    sub: '新 App 的骨架，复制即用',
    icon: deskSvg('hello'),
    css: ['apps/hello/app.css'],

    mount: function (body) {
      openCount++;

      /* 已经画过：只刷新数据，不重建 DOM（否则用户输入和滚动位置全丢） */
      if (body.dataset.ready === '1') {
        render(body);
        return;
      }

      body.innerHTML =
        '<div class="hello-wrap">' +
          '<div class="hello-head">' +
            '<div class="hello-h">你好</div>' +
            '<div class="hello-p">这是一个模板 App：窗口、样式、脚本、图标全由它自己声明，index.html 里没有它的任何代码。</div>' +
          '</div>' +
          '<textarea class="hello-in" spellcheck="false" placeholder="在这里输入，右边会把它倒过来。"></textarea>' +
          '<div class="hello-out" aria-live="polite"></div>' +
          '<div class="hello-foot">' +
            '<span class="hello-meta"></span>' +
            '<button type="button" class="hello-btn">清空</button>' +
          '</div>' +
        '</div>';

      const ta = body.querySelector('.hello-in');
      ta.addEventListener('input', () => render(body));
      body.querySelector('.hello-btn').addEventListener('click', () => { ta.value = ''; render(body); ta.focus(); });

      body.dataset.ready = '1';
      render(body);
      setTimeout(() => ta.focus(), 60);
    }
  });
})();
