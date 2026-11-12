/* ============================================================
 * 自动生成，别手改 —— node tools/app-scan.js
 * App 清单：bare , card , chat , code , comfy , gallery , hello , img2svg , imglab , modeldesk , models , multiview , player , store
 *
 * 加一个 App = 建 apps/<id>/app.js（参考 apps/hello）+ 跑一次 app-scan。
 * index.html 与 desk-shell.js 都不用碰，所以多路 AI 并行时不会互相踩。
 * ============================================================ */
/* ---- apps/bare/app.js ---- */
/* 裸聊 —— 同一条链路的最小对照组。
 *
 * 它不带 system、不带上下文、不带历史，输入 token ≈ 你打的字。
 * 单独成 App 而不是给对话条加开关，就是为了「测出的差值干净」：
 * 混在主链路里会带上 IMG_SYS / contextText / 全量历史，差值就没意义了。
 * 界面里的气泡只是本地显示，从不回传（见 js/bare-chat.js）。
 *
 * 它的 open() **不调 deskMountApp** —— openDeskApp 已经翻页挂载过了，
 * 这里只负责聚焦输入框。
 */
(function () {
  'use strict';

  registerApp({
    id: 'bare',
    name: '裸聊',
    title: '裸聊',
    sub: '无 system / 无上下文 / 无历史',
    glyph: 'bare',
    order: 1,
    cls: 'bare',
    win: 'bareWin',
    body: `
        <div class="bchat-meta" id="bareMeta"></div>
        <div class="dchat-log" id="bareLog"></div>
        <div class="bchat-bar" id="bareBar">
          <textarea class="bchat-text" id="bareText" rows="1" placeholder="只发这一句，不带任何上下文…（Enter 发送，Shift+Enter 换行）"></textarea>
          <button type="button" class="bchat-tplbtn" id="bareTplBtn" title="展开为 OpenAI 兼容的请求体（可编辑）">{ }</button>
          <button type="button" class="dai-send" id="bareSend" title="发送（Enter）">Send</button>
        </div>
        <!-- OpenAI 兼容模板：把这一句展开成可直接编辑的请求体。
             messages 里有什么就发什么，system 可自行加；model 可覆盖本次模型。 -->
        <div class="bchat-tpl hidden" id="bareTpl">
          <div class="bchat-tpl-head">
            <span>OpenAI 兼容请求体（可编辑后直接发送）</span>
            <button type="button" class="bchat-tpl-back" id="bareTplBack">收起</button>
          </div>
          <textarea class="bchat-tpl-text" id="bareTplText" spellcheck="false" wrap="off"></textarea>
          <div class="bchat-tpl-foot">
            <span class="bchat-tpl-note" id="bareTplNote">temperature 0.3 / stream true 由运行时固定</span>
            <button type="button" class="dai-send" id="bareTplSend">Send</button>
          </div>
        </div>`,
    open: function () {
      if (typeof window.bareChatApp !== 'undefined' && typeof window.bareChatApp.focus === 'function') window.bareChatApp.focus();
    }
  });
})();

/* ---- apps/card/app.js ---- */
/* 名片 —— 「我是谁」这件事在桌面上有个正经去处。
 *
 * 内容全部由 js/dev-card.js 的 CD 常量渲染，改文案只改那一处；
 * 这里只有骨架（头图、几块 section、右侧赞赏码 / 群 / 链接）。
 *
 * 一张图兜底一处：头像和两张二维码都带 fb 占位（图没放时显示一块说明，
 * 而不是一个破图裂图标）——放图的位置写在 fb 文案里，用户自己就能补。
 */
(function () {
  'use strict';

  registerApp({
    id: 'card',
    name: '名片',
    title: '名片',
    sub: '作者与联系方式',
    glyph: 'card',
    order: 13,
    cls: 'card',
    win: 'cardWin',
    body: `
        <div class="cd-wrap">
          <div class="cd-main">
            <div class="cd-hero">
              <div class="cd-ava">
                <img id="cdAva" src="img/avatar.jpg" alt="虚幻茅场 的头像" draggable="false">
                <span class="cd-ava-fb" aria-hidden="true">虚</span>
              </div>
              <div class="cd-id">
                <div class="cd-name-row">
                  <h1 class="cd-name" id="cdName">虚幻茅场</h1>
                  <span class="cd-lv" id="cdLv">LV5</span>
                </div>
                <div class="cd-tag" id="cdTag"></div>
                <div class="cd-uid">
                  <span class="cd-uid-v" id="cdUid">UID 641892012</span>
                  <button type="button" class="cd-copy" id="cdCopyUid" data-copy="641892012" title="复制 UID">复制</button>
                </div>
              </div>
            </div>

            <div class="cd-stats" id="cdStats"></div>

            <section class="cd-sec">
              <h2 class="cd-h2">关于我</h2>
              <div class="cd-about" id="cdAbout"></div>
            </section>

            <section class="cd-sec">
              <h2 class="cd-h2">在做的四条线</h2>
              <div class="cd-tracks" id="cdTracks"></div>
            </section>

            <section class="cd-sec">
              <h2 class="cd-h2">合集与代表作<span class="cd-h2-note">右侧为该集播放量</span></h2>
              <div class="cd-works" id="cdWorks"></div>
            </section>
          </div>

          <aside class="cd-side">
            <div class="cd-pay">
              <div class="cd-pay-h" id="cdPayTitle">请我喝杯咖啡</div>
              <div class="cd-qr" id="cdQrBox">
                <img id="cdQr" src="img/pay-qr.png" alt="微信赞赏码" draggable="false">
                <div class="cd-qr-fb" id="cdQrFb">把赞赏码放到 img/pay-qr.png</div>
              </div>
              <div class="cd-pay-s" id="cdPayS">微信扫码赞赏 · 感谢每一份充电</div>
            </div>

            <!-- 技术交流群：和赞赏码是同一类动作（扫码 / 找号码），所以并排放在一起 -->
            <div class="cd-group">
              <div class="cd-group-h" id="cdGroupName">虚幻引擎蓝图笔记3群</div>
              <div class="cd-qr cd-qr-sm">
                <img id="cdGroupQr" src="img/qq-group.png" alt="技术交流群 QQ 二维码" draggable="false">
                <div class="cd-qr-fb" id="cdGroupFb">把 QQ 群二维码放到 img/qq-group.png</div>
              </div>
              <div class="cd-group-foot">
                <span class="cd-group-id" id="cdGroupId">群号 1108459704</span>
                <button type="button" class="cd-copy" id="cdCopyGroup" data-copy="1108459704" title="复制群号">复制</button>
              </div>
            </div>

            <div class="cd-links" id="cdLinks"></div>

            <div class="cd-foot" id="cdFoot"></div>
          </aside>
        </div>`,
    open: function () {
      if (typeof window.devCard !== 'undefined' && typeof window.devCard.open === 'function') window.devCard.open();
    }
  });
})();

/* ---- apps/chat/app.js ---- */
/* AI 对话 —— 和其他 App 一样双击图标翻到 App 页，不再是独立的「第二页」。
 *
 * 原来它有一套自己的翻页规则（.desk-wall.chat-open + .desk-page-2），
 * 返回按钮、动效、页头全和别的 App 对不上 —— 统一成 App 之后全都同一套。
 *
 * ⚠ 底部那条输入 (#deskAiWrap) **不在这个 body 里**。它由 desk-chat-send.js 创建，
 *   按「窗口归属」在桌面底部 ↔ 对话窗口底部之间搬运（监听 openagi:app-mounted /
 *   app-restored）。所以别把输入条写进这里，否则会出现两条。
 */
(function () {
  'use strict';

  registerApp({
    id: 'chat',
    name: 'AI 对话',
    title: 'AI 对话',
    sub: '问点什么，或让它画一张',
    glyph: 'chat',
    order: 0,
    cls: 'chat',
    win: 'chatWin',
    body: `
        <!-- 模型 / 上下文 / 生图来源：原来是第二页页头的一排角标。
             页头删掉后，这三个角标留在对话区顶部——视觉上仍是一眼可扫的信息条。 -->
        <div class="dchat-meta">
          <span class="dchat-model" id="deskChatModel"></span>
          <span class="dchat-ctx" id="deskChatCtx" title="当前对话上下文"></span>
          <span class="dchat-imgsrc" id="deskChatImg" title="当前生图来源（点一下去设置）"></span>
        </div>
        <div class="dchat-log" id="deskChatLog"></div>
        <!-- 把这一轮探索压成流程的入口。只在「跑通了且有可固化步骤」时出现，
             不做弹窗强推 —— 它是筛选器，不是广告位。 -->
        <div class="dchat-saveflow hidden" id="deskChatSaveFlow">
          <span class="dcsf-text" id="deskChatSaveFlowText"></span>
          <button type="button" class="btn sm" id="btnChatSaveFlow">存成流程</button>
          <button type="button" class="dcsf-x" id="btnChatSaveFlowX" aria-label="这次不存" title="这次不存">×</button>
        </div>
        <div class="dchat-foot" id="deskChatFoot"></div>`,
    open: function () {
      if (typeof window.deskChat !== 'undefined' && typeof window.deskChat.open === 'function') window.deskChat.open();
    }
  });
})();

/* ---- apps/code/app.js ---- */
/* 编码 —— 工作台里唯一一个「改别处东西」的 App。
 *
 * 和别的 App 的根本区别是：它的作用对象在工作区里、不归应用所有，
 * 所以它的第一条设计约束是沙箱（见 electron/code-workspace.js），不是界面。
 *
 * 位置放名片之前：名片是收尾，不该有 App 排在它后面。
 * open() 返回 promise（等文件树真画出来），骨架会等它落定才撤。
 */
(function () {
  'use strict';

  registerApp({
    id: 'code',
    name: '编码',
    title: '编码',
    sub: '选定文件夹 · 浏览与改写代码',
    glyph: 'code',
    order: 12,
    cls: 'code',
    win: 'codeWin',
    body: '<div class="ca-app" id="codeApp"></div>',
    open: function () {
      if (typeof window.codeApp !== 'undefined' && typeof window.codeApp.open === 'function') return window.codeApp.open();
    }
  });
})();

/* ---- apps/comfy/app.js ---- */
/* 本地生图 —— ComfyUI 引擎。
 *
 * 单独成 App 而不是塞进模型控制台的小方块：它自带安装 / 启动 / 端口 / 网页界面，
 * 塞进控制台里用户既不知道点哪里也看不清状态。装生图模型前先把它跑起来是最自然的顺序。
 *
 * body 里的 #cfApp 是宿主节点，界面由 js/comfy-app.js 铺开。
 */
(function () {
  'use strict';

  registerApp({
    id: 'comfy',
    name: '本地生图',
    title: '本地生图',
    /* 标签要短（切换条上塞不下「本地生图 · ComfyUI」），窗口标题栏保留完整名字 */
    barTitle: '本地生图 · ComfyUI',
    sub: 'ComfyUI 引擎',
    glyph: 'comfy',
    order: 4,
    cls: 'comfy',
    win: 'comfyWin',
    body: '<div class="cf-app" id="cfApp"></div>',
    open: function () {
      if (typeof openComfyApp === 'function') openComfyApp();
    }
  });
})();

/* ---- apps/gallery/app.js ---- */
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

/* ---- apps/hello/app.js ---- */
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
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M4 6.5h16v9.5H9.5L4 19.5z"/><path d="M8 10.5h8"/><path d="M8 13h5"/>' +
          '</svg>',
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

/* ---- apps/img2svg/app.js ---- */
/* 图像转 SVG —— 模型只看得到工具摘要，SVG 草稿留在本地。
 *
 * 摆在裸聊旁边，因为两者是同一条链路的两端：裸聊测「一句话能返回什么」，
 * 这里测「模型能不能靠工具把图还原成分层矢量」。
 *
 * ⚠ body 上有额外的 class `isvg-body`（别的 App 都是裸的 os-win-body）。
 *   那不是装饰：这块里画布要吃掉剩余高度、日志收成底部一条，
 *   布局规则全挂在 .isvg-body 上，漏了它整块就退回普通流式排布。
 */
(function () {
  'use strict';

  registerApp({
    id: 'img2svg',
    name: '图像转 SVG',
    title: '图像转 SVG',
    sub: '工具调用 + 本地分层草稿',
    glyph: 'i2s',
    order: 2,
    cls: 'isvg',
    win: 'img2svgWin',
    bodyCls: 'isvg-body',
    body: `
        <div class="isvg-meta" id="img2svgMeta"></div>
        <div class="isvg-src">
          <button type="button" class="btn sm" id="img2svgPick">选择图片</button>
          <img class="isvg-thumb hidden" id="img2svgThumb" alt="">
          <div class="isvg-srcinfo" id="img2svgSrcInfo">未选择图片（也可以把图拖进窗口）</div>
          <button type="button" class="btn sm isvg-clear hidden" id="img2svgClear">清除</button>
          <input type="file" id="img2svgFile" accept="image/*" hidden>
        </div>
        <!-- 画布与图层面板并排：横屏时画布吃满剩余高度，面板跟着变高；
             执行日志收成底部一条，不和画布抢纵向空间。 -->
        <div class="isvg-work">
          <!-- 实时画布：AI 每次写路径后立刻重绘，SVG 直接盖在原图上看「正在画什么」。
               状态条常驻左上角：阶段 / 轮次 / 当前工具 / 分数 / 用时。 -->
          <div class="isvg-stage" id="img2svgStage">
            <div class="isvg-stage-status">
              <span class="isvg-stage-badge idle" id="img2svgStageBadge">待开始</span>
              <span class="isvg-stage-round" id="img2svgStageRound">—</span>
              <span class="isvg-stage-tool" id="img2svgStageTool">选一张图，按 Send 开始</span>
              <span class="isvg-stage-score hidden" id="img2svgStageScore"></span>
              <span class="isvg-stage-time hidden" id="img2svgStageTime">00:00</span>
            </div>
            <div class="isvg-stage-stack">
              <img class="isvg-stage-src" id="img2svgStageSrc" alt="">
              <img class="isvg-stage-svg" id="img2svgStageSvg" alt="">
              <div class="isvg-stage-empty" id="img2svgStageEmpty">选一张图，按 Send 开始</div>
            </div>
          </div>
          <!-- 图层面板：四层可见性 / 隔离预览 / 每层统计 / 导出 / 消融。
               内容全部由 img2svg-app.js 的 refreshLayers 生成，这里只放骨架。 -->
          <aside class="isvg-layers" id="img2svgLayers">
            <div class="isvg-layers-head">
              <span class="isvg-layers-title">图层</span>
              <button type="button" class="isvg-layers-toggle" id="img2svgUndo"
                      disabled title="撤销上一次工具写入（每次调用一步）">撤销</button>
              <button type="button" class="isvg-layers-toggle" id="img2svgLayersToggle"
                      aria-pressed="false" title="收起 / 展开图层面板">收起</button>
            </div>
            <div class="isvg-layers-body" id="img2svgLayersBody"></div>
          </aside>
        </div>
        <div class="dchat-log isvg-log" id="img2svgLog"></div>
        <div class="bchat-bar" id="img2svgBar">
          <textarea class="bchat-text" id="img2svgText" rows="1" placeholder="描述要求（可留空），Enter 发送，Shift+Enter 换行"></textarea>
          <button type="button" class="dai-send" id="img2svgSend" title="发送（Enter）">Send</button>
        </div>`,
    open: function () {
      if (typeof window.img2svgApp !== 'undefined' && typeof window.img2svgApp.open === 'function') window.img2svgApp.open();
    }
  });
})();

/* ---- apps/imglab/app.js ---- */
/* 图像工坊 —— 对标 Photoshop 的多图层图像工作站。
 *
 * 图库负责收，它负责改：多图层、选区、滤镜和大尺寸瓦片渲染。
 * 和上一代只做快速修正的图片编辑器（#imgEditWin，那个是弹窗不是 App）分工不同。
 *
 * body 里只有 #psHost 一个宿主，界面与像素逻辑由 js/ps-app.js / ps-core.js 铺开。
 */
(function () {
  'use strict';

  registerApp({
    id: 'imglab',
    name: '图像工坊',
    title: '图像工坊',
    sub: '图层 · 选区 · 滤镜 · 瓦片大图',
    glyph: 'ps',
    order: 7,
    cls: 'imglab',
    win: 'imgLabWin',
    body: '<div class="ps-host" id="psHost"></div>',
    open: function () {
      if (typeof window.psLab !== 'undefined' && typeof window.psLab.open === 'function') window.psLab.open();
    }
  });
})();

/* ---- apps/modeldesk/app.js ---- */
/* 建模 —— 网格资产工作站。摆在模型库旁边：一个是「造」，一个是「存」。
 *
 * MVP-1 用可编辑 face-vertex 网格；点线面工具随后续里程碑接入。
 * body 里只有 #modelDeskHost 一个宿主，整个三维工作台由 js/model-desk.js 铺开。
 *
 * ⚠ 这个 App 被切走时会主动 pause()（见 js/model-desk.js），这是它自己的生命周期决策，
 *   别在注册层替它改 —— 迁移只搬 DOM，不碰行为。
 */
(function () {
  'use strict';

  registerApp({
    id: 'modeldesk',
    name: '建模',
    title: '建模',
    sub: '网格资产工作站 · 变换 · 材质槽',
    glyph: 'modeler',
    order: 8,
    cls: 'modeldesk',
    win: 'modelDeskWin',
    body: '<div id="modelDeskHost" class="md-host"></div>',
    open: function () {
      if (typeof window.modelDesk !== 'undefined' && typeof window.modelDesk.open === 'function') window.modelDesk.open();
    }
  });
})();

/* ---- apps/models/app.js ---- */
/* 模型 —— 引擎与 Provider 的控制台。
 *
 * 它和别的 App 有一处不同：`open()` 里**自己再调一次 deskMountApp**。
 * 这不是多余的 —— models 这个入口原来就绕过了 openDeskApp 的通用路径
 * （见 desk-shell.js 里那句 `deskMountApp($('modelsWin'), m.title, m.sub)`），
 * 因为它要保证「先切页面，再渲染控制台」，而 renderModelsConsole 会重画整棵树。
 * 迁移时原样保留这条，否则会出现「翻过去了但内容还是上一轮的状态」。
 *
 * 四个宿主节点：硬件 / 引擎 / ComfyUI / 模型种类。
 */
(function () {
  'use strict';

  registerApp({
    id: 'models',
    name: '模型',
    title: '模型',
    barTitle: '模型控制台',
    sub: '引擎与 Provider',
    glyph: 'model',
    order: 10,
    win: 'modelsWin',
    body:
      '<div class="mc-hard" id="mcHard"></div>' +
      '<div class="mc-eng" id="mcEng"></div>' +
      '<div class="mc-eng" id="mcComfy"></div>' +
      '<div class="mc-kinds" id="mcKinds"></div>',
    open: function (win) {
      /* 用传进来的 win，不再按 id 反查 —— 少一次 getElementById，也避免名字改了两处不一致 */
      deskMountApp(win, '模型', '引擎与 Provider');
      if (typeof renderModelsConsole === 'function') renderModelsConsole();
    }
  });
})();

/* ---- apps/multiview/body.js ---- */
/* 多视图 App 的窗口 DOM —— 桌面 App 与独立页 multiview.html **共用这一份**。
 *
 * 为什么单独放一个文件：这个 App 是唯一同时有独立页的（multiview.html，双击就能用、
 * 不需要桌面）。以前 index.html 和 multiview.html 里各抄了一份 .mv-wrap（209 / 220 行、
 * 96 个 id），改一个控件要改两处，漏一处就是「桌面能用、独立页少个按钮」。
 * 现在两边都从这里取，**只有一份**。
 *
 * ⚠ 两份原来只差空态的两句文案（独立页写「点左上「＋ 文件」」，但那个按钮其实在左侧栏里，
 *   文案是错的）。统一成桌面版的说法：左边选一个 -> ＋ 文件 -> 拖进来，三种入口都覆盖到。
 *
 * ⚠ 桌面侧由 apps/multiview/app.js 的 registerApp() 取用（tools/app-scan.js 会把本文件
 *   先内联进 manifest）；独立页自己 <script src="apps/multiview/body.js"> 再赋给宿主。
 *   所以这里**只定义常量，不调 registerApp** —— 独立页没有那个函数。
 *
 * 全篇没有反引号 / ${ / 反斜杠（生成时校验过），所以能直接放进模板字符串。
 */
window.MV_BODY = `
<div class="mv-wrap">

          <aside class="mv-side">
            <div class="mv-side-head">
              <span class="mv-side-t">模型</span>
              <button type="button" class="mv-mini" id="mvOpenFile" title="打开本机的 glb / gltf / obj">＋ 文件</button>
            </div>
            <div class="mv-list" id="mvList"></div>
            <div class="mv-side-foot">
              <button type="button" class="mv-mini wide" id="mvOpenLib">打开模型库</button>
            </div>
            <input type="file" id="mvFile" class="hidden" accept=".glb,.gltf,.obj">
          </aside>

          <section class="mv-main">
            <div class="mv-ctl">
              <div class="mv-row">
                <span class="mv-lab">视图</span>
                <div class="mv-chips" id="mvPresets"></div>
                <div class="mv-chips" id="mvViews"></div>
              </div>
              <div class="mv-row">
                <span class="mv-lab">模式</span>
                <div class="mv-seg" id="mvModes"></div>
                <span class="mv-lab">相机</span>
                <div class="mv-seg" id="mvCams"></div>
                <span class="mv-lab">画布</span>
                <div class="mv-seg" id="mvSizes"></div>
              </div>
            </div>

            <details class="mv-more" id="mvMore">
              <summary title="画布级参数：列数、间距、留白、线宽——它们不属于任何一层">画布</summary>
              <div class="mv-more-body">
                <div class="mv-field"><span>列数</span><div class="mv-seg" id="mvCols"></div></div>
                <div class="mv-field"><span>铺满</span><div class="mv-seg" id="mvCompacts"></div></div>
                <div class="mv-field"><span>间距</span><input type="range" id="mvGap" min="0" max="48" step="2"><b id="mvGapV">0</b></div>
                <div class="mv-field"><span>留白</span><input type="range" id="mvMargin" min="100" max="160" step="2"><b id="mvMarginV">108</b></div>
                <div class="mv-field"><span>线宽</span><input type="range" id="mvLineW" min="4" max="60" step="2"><b id="mvLineWV">14</b></div>
              </div>
            </details>

            <div class="mv-stage-wrap" id="mvStageHost">
              <div class="mv-stage" id="mvStage">
                <div class="mv-empty" id="mvEmpty">
                  <div class="mv-empty-t">左边选一个模型，或拖一个 glb / obj 进来</div>
                  <div class="mv-empty-s">OBJ 的四边形面按原始拓扑画线框，不会出现三角化的对角线。</div>
                </div>
                <img id="mvOut" alt="多视图结果" draggable="false" class="hidden">
                <div class="mv-pick hidden" id="mvPick"></div>
              </div>
            </div>

            <div class="mv-bar">
              <span class="mv-info" id="mvInfo"></span>
              <button type="button" class="btn sm" id="mvPreview">3D 预览</button>
              <button type="button" class="btn sm" id="mvSplit" disabled>AI 拆件</button>
              <button type="button" class="btn sm" id="mvSaveLib">存入图库</button>
              <button type="button" class="btn sm" id="mvDlCell" disabled>下载这格</button>
              <button type="button" class="btn sm" id="mvDlAll" disabled>下载整图</button>
              <button type="button" class="btn sm primary" id="mvRender">重新渲染</button>
            </div>
          </section>

          <!-- 右：导出面板（竖排）。画布固定正方形 2K/4K，深度 / 遮罩供 AI 回流 -->
      <aside class="mv-right">
        <div class="mv-layers">
          <div class="mv-ly-head">图层<span class="mv-ly-hint" title="点一行展开它自己的属性面板；拖动可以任意换序，3D 和 2D 之间也能互换">点行调属性 · 随便拖</span></div>
          <div class="mv-ly-list" id="mvLayerList"></div>
        </div>
        <!-- 图层的眼睛驱动这些 input；留在这里是为了「state 只有一条写入口」 -->
        <div class="mv-hidden-checks">
  <input type="checkbox" id="mvWire">
  <input type="checkbox" id="mvAngleWire">
  <input type="checkbox" id="mvUvEdge">
  <input type="checkbox" id="mvUvIsland">
  <input type="checkbox" id="mvOutline">
  <input type="checkbox" id="mvDepthEdge">
  <input type="checkbox" id="mvDepthGray">
  <input type="checkbox" id="mvLabels">
  <input type="checkbox" id="mvBg">
  <input type="checkbox" id="mvGrade">
        </div>
        <!-- 层参数的控件都住在这里，被选中/展开的那一层才搬进它自己的面板。
             不另建一套 input：id 仍是 FIELDS 认的那一个，写入口只有一条。 -->
        <div class="mv-prop-pool" id="mvPropPool">
      <div class="mv-field"><span>背景色</span><input type="color" id="mvBgColor" value="#ffffff"></div>
      <div class="mv-field"><span>折角</span><input type="range" id="mvWireAngle" min="0" max="90" step="1"><b id="mvWireAngleV">30°</b></div>
      <div class="mv-field" title="角度线框的整体粗细（相对「线宽」的倍率）。只想让结构线更醒目、又不想把普通线框一起加粗时用它"><span>角度粗细</span><input type="range" id="mvCreaseWidth" min="20" max="300" step="10"><b id="mvCreaseWidthV">1.0×</b></div>
      <div class="mv-field" title="随折角的粗细梯度：0% 所有结构线等宽；100% 折得越狠越粗（90° 硬边最粗，刚过阈值的平缓边约 1/4 宽）"><span>随角度</span><input type="range" id="mvCreaseTaper" min="0" max="100" step="5"><b id="mvCreaseTaperV">50%</b></div>
      <div class="mv-field" title="角度线框的颜色：换个颜色才分得清「哪几条是结构线、哪几条是普通线框」"><span>角度线色</span><input type="color" id="mvCreaseColor" value="#2b2b2b"></div>
      <div class="mv-field" title="相邻像素的深度差阈值（占整个视锥深度的百分比）：往左描得更多，往右只留最强的边。分辨率变了会自动补偿，换单格尺寸不用重调"><span>深度差</span><input type="range" id="mvDepthThresh" min="0" max="100" step="1"><b id="mvDepthThreshV">1.1%</b></div>
      <div class="mv-field" title="深度灰的映射窗口：100% 用模型完整的前后跨度，调小只保留靠近相机的一段（远处压成黑）。模型前后差得小、灰图看不出一层一层时，把它调小"><span>深度范围</span><input type="range" id="mvDepthGrayRange" min="10" max="100" step="5"><b id="mvDepthGrayRangeV">100%</b></div>
      <div class="mv-field" title="「无限远」的颜色：背景（没有表面）和格间距都填它。默认黑，跟「近白远黑」接得上；改成白就得到反过来的那一版（近黑远白）"><span>远景色</span><input type="color" id="mvDepthGrayBg" value="#000000"></div>
      <div class="mv-field" title="饱和度：0 是黑白，100% 是原样，200% 是色彩更艳。后期处理层调的是最终输出图像"><span>饱和度</span><input type="range" id="mvGradeSat" min="0" max="200" step="5"><b id="mvGradeSatV">100%</b></div>
      <div class="mv-field" title="对比度：100% 是原样，往上更硬朗、往下更灰雾"><span>对比度</span><input type="range" id="mvGradeContrast" min="0" max="200" step="5"><b id="mvGradeContrastV">100%</b></div>
      <div class="mv-field" title="亮度：正值提亮、负值压暗，范围 ±100"><span>亮度</span><input type="range" id="mvGradeBright" min="-100" max="100" step="5"><b id="mvGradeBrightV">0</b></div>
        </div>
          <aside class="mv-export">
            <div class="mv-ex-head">导出</div>
            <div class="mv-ex-row">
              <select class="mv-sel" id="mvExSize" title="画布尺寸（正方形）· 预览与导出一致">
                <option value="2048">2K · 2048</option>
                <option value="4096">4K · 4096</option>
              </select>
              <select class="mv-sel" id="mvExGap" title="格间距">
                <option value="0">无间距</option>
                <option value="16">16 px</option>
                <option value="32">32 px</option>
                <option value="64">64 px</option>
              </select>
            </div>
            <div class="mv-ex-info" id="mvExInfo"></div>
            <div class="mv-ex-stats" id="mvExStats"></div>
            <button type="button" class="btn sm primary" id="mvExPreview" disabled>预览导出结果</button>
            <button type="button" class="btn sm" id="mvExColor" disabled>导出视图 PNG</button>
            <button type="button" class="btn sm" id="mvExDepth" disabled>导出深度图</button>
            <button type="button" class="btn sm" id="mvExMask" disabled>导出遮罩图</button>
            <!-- 投射纹理：工作流闭环（轮廓 → AI 生图 → 逐格反投回模型 UV） -->
            <div class="mv-ex-head">投射纹理</div>
            <div class="mv-ex-info">AI 生成的网格图逐格反投回模型，按 UV 岛归类采样，烘成一张贴图</div>
            <div class="mv-ex-row">
              <select class="mv-sel" id="mvProjSize" title="贴图分辨率（UV 空间）">
                <option value="1024">1K · 1024</option>
                <option value="2048" selected>2K · 2048</option>
                <option value="4096">4K · 4096</option>
              </select>
              <button type="button" class="btn sm" id="mvProj" disabled title="选一张 AI 生成的网格图（或直接 Ctrl+V 粘贴截图）">导入生图投射</button>
            </div>
            <input type="file" id="mvProjFile" class="hidden" accept="image/*">
          </aside>
      </aside>

          <!-- AI 拆件弹层：遮住整个 .mv-wrap。里面的控件 id 与 multiview.html 必须完全一致 -->
          <div class="mv-split hidden" id="mvSplitPanel">
            <div class="mv-split-card">
              <div class="mv-split-head">
                <span class="mv-split-title">AI 拆件</span>
                <span class="mv-split-sub" id="mvSplitSub"></span>
                <button type="button" class="mv-split-x" id="mvSplitClose" aria-label="关闭">×</button>
              </div>
              <div class="mv-split-body">
                <div class="mv-split-row">
                  <span class="mv-split-lab">分成</span>
                  <input type="text" id="mvSplitParts" class="mv-split-in" placeholder="面部和脖子、头发和头饰、身体">
                  <span class="mv-split-lab">候选岛</span>
                  <input type="range" id="mvSplitMax" min="20" max="240" step="10" value="120">
                  <b id="mvSplitMaxV">120</b>
                  <button type="button" class="btn sm primary" id="mvSplitRun">开始拆件</button>
                </div>
                <div class="mv-split-note" id="mvSplitInfo"></div>
                <div class="mv-split-imgs">
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">候选 UV 岛（编号给 AI 寻址）</span>
                    <img id="mvSplitAtlas" alt="候选 UV 岛图" class="hidden">
                  </div>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">拆件结果（颜色对应部件）</span>
                    <img id="mvSplitViews" alt="拆件结果预览" class="hidden">
                  </div>
                </div>
                <div class="mv-split-list" id="mvSplitList"></div>
                <div class="mv-split-foot">
                  <button type="button" class="btn sm" id="mvSplitDlGlb" disabled>下载整件 GLB</button>
                  <button type="button" class="btn sm" id="mvSplitSaveLib" disabled>存入模型库</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 投射纹理弹层：遮住整个 .mv-wrap。里面的控件 id 与 multiview.html 必须完全一致 -->
          <div class="mv-split hidden" id="mvProjPanel">
            <div class="mv-split-card">
              <div class="mv-split-head">
                <span class="mv-split-title">投射纹理</span>
                <span class="mv-split-sub" id="mvProjSub"></span>
                <button type="button" class="mv-split-x" id="mvProjClose" aria-label="关闭">×</button>
              </div>
              <div class="mv-split-body">
                <div class="mv-split-note" id="mvProjInfo"></div>
                <div class="mv-split-imgs">
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">UV 贴图（透明 = 未投射的区域）</span>
                    <img id="mvProjOut" alt="投射纹理结果" class="hidden">
                  </div>
                  <div class="mv-split-pane">
                    <span class="mv-split-cap">上色预览（材质模式 · 自动生成）</span>
                    <img id="mvProjPrev" alt="投射上色预览" class="hidden">
                  </div>
                </div>
                <div class="mv-split-foot">
                  <button type="button" class="btn sm primary" id="mvProjDl" disabled>下载贴图 PNG</button>
                  <button type="button" class="btn sm" id="mvProjGlb" disabled>下载上色 GLB</button>
                  <button type="button" class="btn sm" id="mvProjLib" disabled>存入图库</button>
                </div>
              </div>
            </div>
          </div>
          </div>
`;

/* ---- apps/multiview/app.js ---- */
/* 多视图 —— 模型转三视图 / 六视图 / 八视图。
 *
 * 它同时是**桌面 App** 和**独立工具页**（multiview.html，双击就能用、不需要桌面）。
 * 所以它的窗口 DOM 单独放在 apps/multiview/body.js 里，两边共用同一份 ——
 * 以前是两份拷贝（209 + 220 行、96 个 id），改一个控件要改两处。
 *
 * 窗口本身仍由 registerApp 生成（os-win-bar 在 App 页是隐藏的），
 * body 直接取 window.MV_BODY。tools/app-scan.js 会把 body.js 先内联进 manifest，
 * 所以这里执行时它一定已经定义好了。
 */
(function () {
  'use strict';

  registerApp({
    id: 'multiview',
    name: '多视图',
    title: '多视图',
    sub: '模型转三视图 / 六视图 / 八视图',
    glyph: 'mv',
    order: 11,
    cls: 'mv',
    win: 'mvWin',
    body: window.MV_BODY,
    open: function () {
      if (typeof window.multiview !== 'undefined' && typeof window.multiview.open === 'function') window.multiview.open();
    }
  });
})();

/* ---- apps/player/app.js ---- */
/* 播放器 —— 播「已经攒到本地」的东西。
 *
 * 文件不进浏览器存储（一集就几个 G），而是落在 userData/media，
 * 由主进程的 openagi-media:// 协议流式读——这样进度条能拖，内存也不涨。
 *
 * 和图库配对：图库里是「造出来的图」，播放器里是「攒下来的影音」。
 * 它只播本地已有的文件（媒体库目录），不负责去网上抓内容 —— 那个「直链下载」
 * 是给人下自己有权保存的东西的入口，不是搜索器。
 *
 * ⚠ 它被切走时会 stopPlayback()（见 js/player.js）：那是它自己的生命周期决策，
 *   迁移只搬 DOM，不碰行为。
 */
(function () {
  'use strict';

  registerApp({
    id: 'player',
    name: '播放器',
    title: '播放器',
    sub: '本地的视频与音频',
    glyph: 'video',
    order: 9,
    cls: 'player',
    win: 'playerWin',
    body: `
        <div class="pl-wrap">
          <div class="pl-stage">
            <div class="pl-screen" id="plScreen">
              <video id="plVideo" playsinline preload="metadata"></video>
              <div class="pl-empty" id="plEmpty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.6"/><path d="m10 9.4 5 2.6-5 2.6V9.4Z"/></svg>
                <div class="pl-empty-t">还没有可播的东西</div>
                <div class="pl-empty-s">用右边「导入文件夹」加一整部，或「＋ 直链」下一集进来</div>
              </div>
            </div>
            <div class="pl-ctrl" id="plCtrl">
              <button class="pl-btn" id="plPrev" title="上一集（PgUp）" aria-label="上一集">
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7 5h2.2v14H7zM19 5.6v12.8L9.6 12z"/></svg>
              </button>
              <button class="pl-btn pl-btn-main" id="plPlay" title="播放 / 暂停（空格）" aria-label="播放">
                <svg class="pl-ico-play" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M8 5.4 19 12 8 18.6z"/></svg>
                <svg class="pl-ico-pause hidden" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7.5 5h3.2v14H7.5zM13.3 5h3.2v14h-3.2z"/></svg>
              </button>
              <button class="pl-btn" id="plNext" title="下一集（PgDn）" aria-label="下一集">
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M14.8 5H17v14h-2.2zM5 5.6 14.4 12 5 18.4z"/></svg>
              </button>
              <span class="pl-time" id="plTime">0:00 / 0:00</span>
              <input type="range" class="pl-seek" id="plSeek" min="0" max="1000" value="0" step="1" aria-label="播放进度">
              <button class="pl-btn" id="plMute" title="静音（M）" aria-label="静音">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.5h3L11 6v12L7 14.5H4z"/><path class="pl-ico-wave" d="M14.5 9.2a4 4 0 0 1 0 5.6M17.2 6.8a7.4 7.4 0 0 1 0 10.4"/><path class="pl-ico-mute hidden" d="m15 10 4 4m0-4-4 4"/></svg>
              </button>
              <input type="range" class="pl-vol" id="plVol" min="0" max="100" value="100" step="1" aria-label="音量">
              <button class="pl-btn pl-rate" id="plRate" title="播放速度">1×</button>
              <button class="pl-btn" id="plFull" title="全屏（F）" aria-label="全屏">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
              </button>
            </div>
          </div>
          <aside class="pl-side">
            <div class="pl-side-head">
              <div class="pl-folders" id="plFolders" role="tablist" aria-label="分组"></div>
              <span class="pl-count" id="plCount"></span>
            </div>
            <div class="pl-list" id="plList" aria-label="播放列表"></div>
            <div class="pl-dl hidden" id="plDl">
              <input type="url" id="plDlUrl" class="pl-in" placeholder="粘贴视频直链（http/https，自己有权下载的）" aria-label="下载地址">
              <input type="text" id="plDlName" class="pl-in" placeholder="保存名（可留空，自动取链接末尾）" aria-label="保存名">
              <div class="pl-dl-row">
                <button class="btn sm primary" id="plDlGo">下载到本地</button>
                <button class="btn sm" id="plDlCancel">关闭</button>
                <span class="pl-dl-hint">只下你有权保存的内容</span>
              </div>
            </div>
            <div class="pl-prog hidden" id="plProg">
              <div class="pl-prog-bar"><i id="plProgBar"></i></div>
              <span class="pl-prog-txt" id="plProgTxt"></span>
              <button class="pl-prog-x" id="plProgX" title="取消下载">取消</button>
            </div>
            <div class="pl-foot">
              <button class="btn sm" id="plImport" title="从磁盘选文件（可多选）">导入文件</button>
              <button class="btn sm" id="plImportDir" title="选一个文件夹，按子文件夹分组成剧集">导入文件夹</button>
              <button class="btn sm" id="plDlOpen" title="粘贴直链下载">＋ 直链</button>
              <button class="btn sm" id="plDir" title="在资源管理器里打开媒体库目录">目录</button>
            </div>
          </aside>
        </div>
        <!-- 浏览器里打开（没有 Electron 媒体库）时的降级入口：只能临时播内存里的文件 -->
        <input type="file" id="plFile" class="hidden" multiple accept="video/*,audio/*">`,
    open: function () {
      if (typeof window.playerApp !== 'undefined' && typeof window.playerApp.open === 'function') window.playerApp.open();
    }
  });
})();

/* ---- apps/store/app.js ---- */
/* 模型商店 —— 用 Ollama 的羊驼头做图标。
 *
 * 那张 png 是「本地模型」这件事的通用符号，比再画一个抽象图标更容易一眼认出来，
 * 所以这里用 icon（整段 HTML）而不是 glyph（内置 SVG 图形）。
 *
 * body 里的 #mcStore 是宿主节点，卡片由 js/model-store.js 渲染。
 */
(function () {
  'use strict';

  registerApp({
    id: 'store',
    name: '模型商店',
    title: '模型商店',
    sub: '安装 / 删除本地模型',
    icon: '<img class="desk-app-img" src="vendor/ollama-llama.png" alt="" draggable="false">',
    order: 3,
    cls: 'store',
    win: 'storeWin',
    body: '<div class="mc-store" id="mcStore"></div>',
    open: function () {
      if (typeof openModelStore === 'function') openModelStore();
    }
  });
})();
