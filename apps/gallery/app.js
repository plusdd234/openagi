/* 图库 / 模型库 —— 两个入口共用一个窗口 #libWin。
 *
 * 为什么合在一个文件：它们的窗口是同一个，只是 `openLibrary(mode)` 传的 mode 不同
 * （image → 生成结果与素材，model → 本机模型文件）。拆成两个目录就会出现
 * 「窗口 body 在两处各写一份、谁先加载谁说了算」的隐式顺序依赖，比放一起更脆。
 * 目录名取主入口 gallery，tools/app-scan.js 校验的是「目录名在注册的 id 里」。
 *
 * body 里的 #libBody 是模块的宿主节点 —— js/library.js 会整块接管它。
 */
(function () {
  'use strict';

  const BODY = '<div class="lib-body" id="libBody"></div>';

  registerApp({
    id: 'gallery',
    name: '图库',
    title: '图库',
    sub: '生成结果与素材',
    glyph: 'gallery',
    order: 5,
    cls: 'lib',
    win: 'libWin',
    body: BODY,
    open: function () {
      if (typeof openLibrary === 'function') openLibrary('image');
    }
  });

  /* 第二个注册时 #libWin 已经存在，registerApp 会复用它、不再写 body ——
     所以这里不重复声明 body（写了也不会生效，纯噪音）。 */
  registerApp({
    id: 'modelLib',
    name: '模型库',
    title: '模型库',
    sub: '本机模型文件',
    glyph: 'modelLib',
    order: 6,
    win: 'libWin',
    open: function () {
      if (typeof openLibrary === 'function') openLibrary('model');
    }
  });
})();
