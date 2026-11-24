# apps/ —— 一个目录就是一个 App

> 总规范见根目录 [`AGENTS.md`](../AGENTS.md)：App 开发、测试、文件管理、并行协作以那里为准。
> 本文件只补充 App 目录层面的细则。

**给并行开发的 AI 看的三句话**：只写你自己的 `apps/<id>/` 目录；不要碰 `index.html`、`js/`、`css/`；
写完跑 `node tools/app-scan.js`，再跑 `node tools/app-registry.js` 确认没踩坑。

---

## 加一个 App 的完整流程

```bash
cp -r apps/hello apps/<你的id>     # 1. 复制模板（Windows: xcopy /E /I apps\hello apps\<id>）
# 2. 改 app.js 里的 id / name / title / icon / mount，改 app.css
node tools/app-scan.js             # 3. 生成清单
node tools/app-registry.js         # 4. 体检（36 条，含「切回后用户输入还在」）
```

第 3 步是必须的：`apps/manifest.js` 是**生成物**，把所有 `apps/*/app.js` 内联进去。
不跑它，你写的 App 不会出现在桌面上。

---

## 两个 AI 同时干活：一个 AI 一个 worktree

上面那套解决了「**文件**不重叠」，但两个人改同一个 `apps/<id>/` 时改的仍是**同一份文件**。
要真并行，就得各写各的工作区（`tools/wt.js`，2026-11-13 落地）：

```bash
# 在主仓：给这个 App 开一块独立工作区（分支 app/<id>，目录在仓库**外面**）
node tools/wt.js new search

# 它会打印一张「任务卡」，整段贴给那个 AI —— 那张卡自带边界说明，不用你再解释

node tools/wt.js list            # 谁在干什么、改了哪些文件、有没有越界
node tools/wt.js status search   # 只看一个
node tools/wt.js merge search    # 合回主仓（自动重算 manifest + 跑守卫，失败整体回滚）
node tools/wt.js rm search       # 拆掉工作区
```

**合并时的三道闸**，全自动：

1. **越界拦截** —— 分支只许改 `apps/<id>/` 和 `apps/manifest.js`。
   动了 `js/` `index.html` `css/` 一律拒绝（确实要合加 `--allow-shared`，并逐条人工过目）。
   这是「文件不重叠」那套机制的运行时兜底：光有目录约定，AI 不会自己遵守。
2. **manifest 冲突自动解** —— 每个分支都重算过 `apps/manifest.js`，合并必然撞。
   它是生成物，所以冲突只做「挑一边 → 按磁盘上的 apps/ 重新生成」，不让人手工解。
3. **门禁** —— `app-scan --check` + `ns-guard` + `css-links`，纯 node 秒级。
   任何一条红就 `git merge --abort`，主仓回到合并前，不会留下半吊子状态。

几条**已经踩过**的坑（脚本里都处理了，但你要知道为什么）：

- **worktree 放在仓库外面**（默认 `<仓库上级目录>/openagi-wt/<id>`）。
  放里面会让 `grep -r`、文件树、打包白名单全看见两份代码。
- **`node_modules` 用 junction 共享**，不重复 `npm install`（electron 一个就 200MB+）。
  ⚠ 拆工作区前脚本会**先摘掉链接**：直接删目录时 rmdir 会顺着链接把主仓的
  `node_modules` 一起端掉 —— 这是整个流程里唯一有破坏性的地方。
- **`vendor/` 被 `.gitignore` 挡着**，worktree 从提交里长出来 → 天然没有
  `three.min.js` / 三个 loader / fflate / 模型商店的羊驼头。不补就是满屏
  `ERR_FILE_NOT_FOUND`（图标丢、模型加载器 undefined）。脚本建的时候会补「主仓有、这边缺」的。
- **别在主仓和 worktree 里同时 `npm run dev`**：Electron 有单实例锁，后起的会静默退出。

---

### 示例

```js
(function () {
  registerApp({
    id: 'myapp',                       // 唯一，等于目录名；是标签和注册表的键
    name: '我的应用',                   // 桌面图标下的字
    title: '我的应用',                  // 窗口标题
    sub: '一句话说明',
    icon: '<svg viewBox="0 0 24 24">…</svg>',   // 24×24，描边色用 currentColor
    css: ['apps/myapp/app.css'],        // 可选，打开时才注入
    mount: function (body) {            // 在这里画界面
      if (body.dataset.ready === '1') return;   // ← 必须幂等，见下
      body.innerHTML = '…';
      body.dataset.ready = '1';
    }
  });
})();
```

---

## 六条禁令（都是「能跑但会坏」的那种）

1. **整个 `app.js` 包在 `(function(){ … })();` 里。**
   不包的话你的顶层函数会落到和 1175 个名字同一个 window 作用域上。两个 App 各写一个
   `openViewer()` 时，git 合并**零冲突**，运行时后者静默覆盖前者 —— 不报错、不警告。
   这就是并行开发里唯一版本控制不会告诉你的错误。`node tools/ns-guard.js` 能查出来。

2. **`mount()` 必须幂等。**
   `openDeskApp` 每次翻到你都会调 `open()` → `mount()`，不是只调第一次。
   每次都重建 `innerHTML` 会把用户的输入、滚动位置、展开状态全冲掉。
   判据用 `body.dataset.ready`，画过一次就只刷新数据。

3. **不要写 `#<winId> { width / height }`。**
   App 页铺满靠的是 `.dapp-host .os-win { position:absolute; inset:0; width:auto }`，
   而 id 选择器的特异性高于它 —— 你一写尺寸，窗口就缩成一个小卡片浮在左上角。
   尺寸交给外层，内容用 flex 自适应。

4. **不要再加一层大 padding。**
   `.dapp-host .os-win-body` 已经有 `16px 18px 18px`，这里再来一遍就是双重留白。

5. **不要覆盖 `.os-win` / `.os-win-body` / `.desk-app` 这类公共类。**
   你的 CSS 只在这个 App 打开时注入，但注入之后就是全局生效的，会波及别的 App。
   选择器统一用 `.myapp-*` 前缀或 `#myappWin`。

6. **不许碰 `window.openagiDesktop`，不许读 localStorage 里的 `llmKey`。**
   那是桌面桥（88 个方法：fs 读写、命令执行、引擎控制）。现在所有 App 都是自己写的所以能接受，
   一旦有第三方代码进来就是漏洞。要调模型用 `llmConn()`，要存东西用 `blob-store`。

---

## 为什么是「内联」而不是 `<script src>`

`file://` 下 `fetch('app.html')` 会直接 `Failed to fetch`（opaque origin，实测过），
所以窗口 DOM 只能写在 JS 里；`document.write` 插脚本又容易被浏览器干预机制挡、且依赖解析时机。
内联是 `file://` 和 `app://` 下都确定可行的唯一形式。

代价是 `manifest.js` 里行号会偏移 —— 所以每块前面都写了 `/* ---- apps/<id>/app.js ---- */`，
报错时按注释找回去。

---

## 窗口 DOM 很长怎么办：`body.js`

`registerApp` 的 `body` 是个字符串，几百行 DOM 塞在 `app.js` 里会读不下去。
把它单独放 `apps/<id>/body.js`，里面只做一件事：

```js
window.MV_BODY = `<div class="mv-wrap"> … </div>`;
```

然后 `app.js` 里写 `body: window.MV_BODY`。`app-scan` 会**自动把它排在 `app.js` 之前**内联进清单，
不用改 `index.html`。

好处不止是整齐：这个字符串是**全站唯一一份**。多视图以前在 `index.html` 和 `multiview.html` 里各存一份
同样的 204 行 DOM，靠测试比对 30 个 id 来「保证一致」—— 那只能保证当下一致，改一处漏一处就散架。
现在 `multiview.html` 也 `insertAdjacentHTML('beforeend', window.MV_BODY)`，两处引用同一个变量。

⚠ `body.js` 不是一个 App，不要给它写 `registerApp`；`app-scan` 只扫 `app.js`。

---

## 相关文件

| 文件 | 作用 |
| --- | --- |
| `js/app-registry.js` | `registerApp()`：造窗口、按需注入 css/scripts、写进三张表 |
| `apps/manifest.js` | **生成物**，别手改 |
| `tools/app-scan.js` | 扫描 `apps/*/app.js` 生成清单；`--check` 只校验不写盘 |
| `tools/app-registry.js` | 体检 36 条：注册 / 打开 / 幂等 / 关闭 / 防护 / 清单一致 |
| `tools/apps-all.js` | 逐个打开全部 App：宿主真有内容、骨架撤除、铺满、标签高亮、零报错 |
| `tools/desk-tabs.js` | 顶栏切换条：返回桌面后标签仍在、切标签不重跑 `open()` |
| `tools/ns-guard.js` | 跨文件重名、重复 id、未接线脚本（并行开发必跑） |
| `tools/wt.js` | 一个 AI 一个 worktree：`new / list / status / merge / rm` |

---

## 迁移状态：全部 App 都在 `apps/` 里了（2026-11-12）

老写法是「`index.html` 里一段 `.os-win` 块 + `desk-shell.js` 里三张表各加一行」，
两处都是**所有 App 共用的同一段文本**，两路 AI 同时加 App 必冲突。现在：

| App id | 目录 | 备注 |
| --- | --- | --- |
| `chat` | `apps/chat/` | 输入条 `#deskAiWrap` 跟着窗口归属搬进 `#chatWin` |
| `store` | `apps/store/` | |
| `comfy` | `apps/comfy/` | |
| `gallery` | `apps/gallery/` | 同时注册 `modelLib`，两者共用 `#libWin` |
| `imglab` | `apps/imglab/` | 壳在 App 目录，编辑器在 `js/ps-*.js`；位图 / 矢量 / 3D 绘制三工作区（F2 / F3 / F4）。3D 仍是 PS 界面：工具箱、选项栏、图层面板与文档标签都保留，只把中间画布换成 three.js 视口；`js/ps-3d.js` 支持「生成遮罩」（UV 空间单图）与「添加遮罩」（按当前视角正交投影，每个可见 UV 岛生成一个带蒙版的图层，收进图层组，可到位图模式逐层绘制）。「文件 → AI 绘制 SVG…」由语言模型直接产出矢量 SVG 并保存（对外 `psLab.aiDraw / saveSvg / aiSvg`）。右侧「历史记录 / 色板 / 助手」标签里的「助手」是图像处理助手：对话调用 `draw_svg`（生成 SVG）、`save_svg`（保存）、`paint_svg`（分图层 / 分组 / 分步骤画进画布，每步单独入历史，Ctrl+Z 逐步撤回）、`place_svg`（单图层放入画布）四个工具，模型回复走「一轮一个 JSON」协议；图层名优先取 SVG 元素的 `data-name / aria-label / <title> / id / class` 并翻成中文（eye-left → 左眼、tentacle-1 → 触手 1），`path1 / layer2` 这类机器 id 退回形状兜底；助手面板底部显示 token 消耗（提示 / 输出、对话 / 绘制次数，接口未返回 usage 时标注估算）；模型不可用（断网 / CORS / 未配置）时整轮降级到本地模板绘制（鱼 / 企鹅 / 猫 / 风景 / 树 / 花 / 房子 / 星空 / 抽象）并自动分步绘制到画布，只提示一次原因、不再连环报错；编排调用 `max_tokens` 600，`paint_svg` 成功后不再多问一轮，用户说「画到画布 / 分图层 / 分步骤」时 draw 完直接绘制；对外 `psLab.assistant.ask / open / localDraw / paint / script / usage / state` |
| `modeldesk` | `apps/modeldesk/` | 属性面板「纹理生成」页按三步流程排：① 渲染模型结构（多视图预览，视图组 / 画布 / 显示 / 图层 / 导出等参数折叠段默认收起）→ ② AI 生成上色（Tripo 生图）→ ③ 纹理生成（导出当前对象或本地模型 → 助手 `/tex` 上传 Tripo「纹理生成」→ 抓回贴图）。**① 预览与 ③ 上传的目标对象以「选中的对象」为准**（单选即刚点的那一个；多选时退回激活对象），进入页面时若激活对象与单选不一致会先对齐，①②③ 标题都写明当前对象名，避免「选衣服却渲染头发」。③ 默认**保留原 UV**（先校验 GLB 有 `TEXCOORD_n`）；拉回的贴图作为最上层**纹理图层**叠加到当前对象所用材质槽（MIX `addLayer` + `flipY:false` 的 glTF 原生朝向），并**按当前对象自动生成 UV 覆盖遮罩**挂到该层（对象 UV 面片铺成白色 / 透明底，白=显示、透明=隐藏；UV 越界时自动跳过遮罩），贴图只落在该对象自己的 UV 岛上；合成后视口模型立即更新，材质页里还能隐藏 / 调不透明度 / 烘焙。生成等待期间，只在**本次生成的那个对象**表面注入**世界空间滚动条带**（`onBeforeCompile` 注入，按对象 id 限定作用域，场景里其它模型不受影响；busy 结束原样还原，不进文档 / 历史）；取消保留时按 Tripo 重排 UV 拉回带贴图 GLB 并作为新对象导入。参考图支持多视图（最多 4 张，按 前 / 左侧 / 右侧 / 后 各写一个槽位；助手 `findTexRefSlots` 按槽位文字+面积/坐标识别，只填部分时从「前」开始；参考图除文件选择外还支持 **Ctrl+V 直接粘贴**剪贴板图片，只在纹理生成页可见时接管，**② 的「＋ 参考图」与 ③ 的多视图槽位都支持**（按最后一次点击的区域判定；没有点击记录时默认 ③）；① 的预览图与 ② 的结果图**右键即复制为 PNG 到剪贴板**（Electron 走 `openagiDesktop.copyImage`，浏览器走 `ClipboardItem`），复制后可直接粘到 ② / ③ 当参考图。「绘画工具箱 > 图层」同时列出**绘画产生的笔迹 / 投射 / 模糊层**（TexStack ops）：笔迹 / 模糊排在贴图图层之上、投射层排在混合层与底层之间（与合成顺序一致），标题层数含绘制层；每层可单独显隐（`on:false` 也按 v4 `ops` 落盘，全部隐藏时回到白模 / 底座，重开页面不丢层）、双击改名、↑/↓ 调序、× 删除，显隐与删除都进撤销历史。遮罩生成走「整张并集一次 fill + 同色细描边」，相邻面共享边不留缝，贴图上不会出现白色线框。绘制按 **PS 口径的「当前绘制层」**：笔迹并进当前选中的笔迹层，不再一笔一层；点列表里的笔迹行即可切换目标层（高亮红框 + 「· 当前绘制层」标注），「＋ 绘制层」显式新建空层；橡皮 / 模糊按同参数并入最上方的同类层，不会连续擦 / 糊出一堆层。合并时生成一张新 canvas（旧层对象留给撤销），空层不落盘，隐藏当前层会自动取消选择、回落到最上面的普通笔迹层。**橡皮 / 模糊笔拖动只做脏块增量合成**：`rec.underCv` 缓存「底座 + 混合层」，每帧只按笔刷包围盒重建该块笔迹层并叠加（模糊同样只重算外扩后的包围盒，`blurMasked(cv,mask,r,box)`），整图重算只在图层 / 可见性 / 显隐等状态变化时发生；`TB.compose` 的临时画布改为复用，`cfg` 变更签名不再把 `ops` 算进去（否则每抬一次笔都会重解码图层、让下一笔第一帧整图重算）。`mixStats()` 的 `compose` 是整图重算次数、`live` 是脏块增量次数，探针直接断言拖动期间 `compose` 不增长且擦除像素确实减少。**OBJ 包导出**按「对象 × 材质槽」收集导出根上实际挂着的贴图（节点 AI 贴图 / 组件表面如头模的脸也会进包，不再只拷材质槽里的身体和头发），每个对象写一条 `o`、每个材质分组写 `g` + `usemtl`，面直接取文档网格的原始多边形（四边面不被三角化）；OBJ 没有形态键字段，形态键（名字 / 权重 / 相对位移 base64）另存为 `<文件名>.shapes.json`，需要可编辑形态键请导出 GLB |
| `tripostudio` | `apps/tripostudio/` | Tripo 工坊：复用工作流 `tripoImg` / `tripoModel` 节点（`wfTripoWebImage` / `wfTripoWebModel`），专业三栏编辑器 —— 生图、单图 / 多视图生模型、生成并应用纹理、URL 拉回 / 本地导入结果；DOM 在 `body.js`，2D / 3D 视口在 `viewport.js`（按需注入）；桌面版支持**内嵌 Tripo 网页**（`partition=persist:tripo-embed` 的 `<webview>`，登录与生成都由 `plugins/tripo` 经 `embed-cdp.js` 驱动，外部 Edge 保留为兜底），浏览器环境自动退回外部登录；切 App 时窗口节点会被搬进 / 搬出 `#deskAppHost`，所以 webview 挂在 `#deskAppCanvas` 下的固定坞 `.tps-embed-dock` 里（跟着窗口换父节点会被 Electron 重建、页面重载），坞按 `.tps-embed-host` 的位置铺上去，窗口不在 App 页时移到屏幕外并保持整屏视口；探针 `tools/probe-tripostudio.js` 顶替节点函数与 `/status`，用 data URL 资源跑通全链路 |
| `player` | `apps/player/` | |
| `studio` | `apps/studio/` | 时间线剪辑；菜单栏 / 选择·剃刀工具 / 循环与逐帧 / 动态轨道 / 关键帧 / 四种精细剪辑 / 标记 / 片段右键菜单（含分离音频、文字转语音）/ `.hfstudio` 导入导出；素材可读视频库与图库（图库经 `window.assetBridge`，项目只存 `assetId`）；图库删除前会检查剪辑台项目引用 |
| `models` | `apps/models/` | `open()` 里先 `deskMountApp` 再渲染控制台，顺序不能反 |
| `multiview` | `apps/multiview/` | DOM 在 `body.js`，独立页共用 |
| `code` | `apps/code/` | |
| `card` | `apps/card/` | |
| `featlab` | `apps/featlab/` | 特征提取台：框选 + 边界精确微调（四边 ±1/5/10px、外扩 / 内缩、1:1、锁比例、方向键与 Alt+方向键）、AI 定位 / 复核 / 命名、3×3 图集、**逐格标注**（区域行下直接写那一句，整段标注由这些句子自动拼出）、右键把区域小图 / 整张源图 / 图集复制进剪贴板（`ClipboardItem` 写 `image/png`，失败降级下载并如实提示）、填表式提示词（中文自然语言 / 英文关键词 / 双语，含负面词）。右栏是 提取 / 图集 / 提示词 / 标注 四页，DOM 在 `body.js`，探针 `tools/probe-featlab.js` |
| `hello` | `apps/hello/` | 模板，留着当参照 |

`js/desk-shell.js` 里的 `DESK_APPS` / `DESK_APP_META` 现在是**空数组 / 空对象**，
而且必须保持为空 —— 它们由 `registerApp` 写入。手写一条进去就是「一个 App 两个真源」。

图标顺序**不靠中央表**：每个 App 自己声明 `order`（间隔 10 的整数），`registerApp` 之后做一次稳定排序。
加新 App 时挑个空档插进去就行，不用改别人的文件。

