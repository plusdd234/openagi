# AGENTS.md — 工程总规范

> 适用范围：所有在本仓库工作的 AI 与人类开发者。
> 本文件是根目录核心规范。与 `README.md`、`apps/README.md` 冲突时，以本文件为准；
> App 开发细节以 `apps/README.md` 为补充，但不得违反本文件。
> 修改本文件必须同时说明影响范围，并在提交信息中注明 `[规范]`。

一句话：**一个 App 一个目录；共享文件不并行改；测试默认无头、断言不靠截图；产物只进临时目录。**

---

## 1. 文档地图

| 位置 | 性质 | 用途 |
|---|---|---|
| `README.md` | 对外介绍 | 项目能力、快速开始、架构概览 |
| `AGENTS.md` | **现行总规范** | App 开发、测试、文件管理、并行协作 |
| `apps/README.md` | **现行 App 细则** | 新增 App 的流程、六条禁令、worktree 说明 |
| `docs/决策AI-宪法.md` / `docs/决策AI-章程.md` | 决策 AI 体系规则 | 决策 AI 与工作 AI 的职责边界，不覆盖本文件 |
| `docs/建模App-*.md/.html/.csv` | 方案 / 计划 / 审计记录 | 建模 App 的历史与进行中材料，以代码和测试为准 |
| `docs/提案-*.md` | 提案 | 未生效的改动建议 |
| `docs/纹理系统-*.html` | 方案报告 | 技术方案记录 |
| `docs/*.png` | 现有文档配图 | 不再新增散落图片，新配图放 `docs/assets/` |

文档规则：

1. `docs/` 是记录区，**不是规范区**。只有本文件和 `apps/README.md` 里的规则算现行规范。
2. 新建 `docs/` 文档时，正文开头必须写清：`状态`（提案 / 进行中 / 已生效 / 已废弃）、`日期`、`适用范围`。
3. 方案文档必须区分「已实现」与「计划目标」，并给出可执行的验收路径。
4. 行为变更必须同步更新对应文档；只改代码不改文档视为未完成。
5. 不再新建根目录 Markdown，除非是 `README.md`、`AGENTS.md` 这类全仓入口文件。

---

## 2. 文件所有权

| 路径 | 归属 | 规则 |
|---|---|---|
| `apps/<id>/` | 单个 App | 一个 App 只能改自己的目录 |
| `apps/manifest.js` | 生成物 | 只能由 `node tools/app-scan.js` 重写，禁止手改 |
| `js/`、`css/`、`index.html` | 共享层 | 一次只允许一个改动方；并行开发时走 worktree 合并审查 |
| `tools/` | 测试与工具 | 新增探针放这里；一次性脚本以下划线开头 |
| `docs/` | 文档与方案 | 不作为运行时依赖 |
| `assets/`、`media/` | 用户数据 | 已在 `.gitignore`，不入库 |
| `.workbuddy/runs/` | 测试产物 | 每次运行独立目录，不入库 |
| `dist*`、`release/`、`out/` | 打包产物 | 不入库 |

硬规则：

- 不允许在 `apps/<id>/` 之外新增该 App 的专属文件。
- 不允许把测试截图、日志、临时脚本写进根目录。
- 不允许在 App 代码里读取 `localStorage` 的 `llmKey` 或直接摸 `window.openagiDesktop`。
- 模型调用统一走 `LLMRouter` / `llmConn()`；存储统一走资产库或 `blob-store`。

---

## 3. App 开发规范

### 3.1 新建 App

```bash
cp -r apps/hello apps/<id>        # Windows: xcopy /E /I apps\hello apps\<id>
node tools/app-scan.js            # 生成 apps/manifest.js
node tools/app-registry.js        # 注册表体检
```

`<id>` 必须满足：

- 正则：`^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`
- 与目录名、`registerApp({ id })` 完全一致
- 不再新增第二个真实来源；`DESK_APPS` / `DESK_APP_META` 保持空数组 / 空对象

### 3.2 代码结构

- 整个 `app.js` 必须包在 `(function(){ … })();` 里，避免污染全局作用域。
- `mount(body)` 必须幂等：用 `body.dataset.ready` 判断，画过一次后只刷新数据，不重建 `innerHTML`。
- DOM 很长时放 `apps/<id>/body.js`，只导出 `window.XXX_BODY` 字符串；`app-scan` 会自动排在 `app.js` 前。
- `file://` 下不能 `fetch('app.html')`；窗口 DOM 必须内联在 JS 里。
- 图标用 24×24 SVG，描边色用 `currentColor`；`order` 取间隔 10 的整数，插入空档即可。
- 可选样式放 `apps/<id>/app.css`，通过 `registerApp({ css: [...] })` 按需注入。

### 3.3 CSS 禁令

1. 不写 `#<winId> { width / height }`，尺寸交给 `.dapp-host .os-win`。
2. 不再给 `.os-win-body` 加一层大 padding。
3. 不覆盖 `.os-win` / `.os-win-body` / `.desk-app` 等公共类。
4. 选择器统一用 `.<app>-*` 或 `#<app>Win` 前缀，避免注入后波及别的 App。
5. 竖版 / 响应式规则必须带选择器前缀，并放在样式表末尾，确保优先级。

### 3.4 数据与能力

- 语言模型：`LLMRouter.complete()` 或 `LLMRouter.postChat()`；需要连接时用 `llmConn()`。
- 不允许在 App 内自己拼接多 Key 选择、重试、超时逻辑。
- 资产：图片 / 模型 / 视频走资产库接口；本地持久化用项目已有的存储封装。
- 不允许 App 私自启动固定端口的 HTTP 服务。

### 3.5 App 完成判据

- 桌面能打开，窗口铺满，关闭 / 切回后状态保留。
- `mount()` 重复调用不丢输入、不丢滚动位置。
- `node tools/app-scan.js --check` 通过。
- `node tools/app-registry.js` 通过。
- 目标 App 的 `probe-*.js` 通过。

---

## 4. 测试规范

### 4.1 默认形态

- 默认**无头**：`playwright-core` 驱动 Edge，`chromium.launch({ channel: 'msedge' })`。
- 页面统一加载 `file:///.../index.html?nostore=1`；`?nostore=1` 只禁写、不禁读。
- 断言优先走 `page.evaluate()`、`locator.isVisible()`、`boundingBox()`、DOM 状态，不靠截图判断。
- 测试脚本必须自己退出：成功 `exit 0`，失败 `exit 1`；不允许长时间挂起。
- 默认测试不允许访问真实模型 / ComfyUI / Tripo；需要联网或真实引擎的测试必须用环境变量显式开启。
- 统一入口：`node tools/test-headless.js <app>` 或 `npm run test:headless -- <app>`；不直接拼多个裸命令。

### 4.2 截图规范

截图只作为**调试产物**，不作为测试断言。

- 禁止写固定文件名，例如 `tools/_x.png`、`tools/shots/x.png`、`.workbuddy/shots/x.png`。
- 每次运行使用唯一目录：

```text
.workbuddy/runs/<yyyyMMdd-HHmmss>-<pid>-<tool>/
  result.json
  step-01.png
  step-02.png
```

- 未设置 `PROBE_RUN_DIR` 时，默认写入仓库内 `.workbuddy/runs/<runId>/`（已忽略）；需要写到仓库外时用 `PROBE_RUN_DIR` 指定。
- 默认不截图；`node tools/test-headless.js` 默认传 `PROBE_SHOTS=0`，需要截图时加 `--shots`。
- `samples/`、`docs/` 只放需要长期保留的参考图，不放测试运行产物。
- 新探针统一使用 `tools/probe-run.js` 的 `createRun(tool)`：`run.dir`、`run.artifact(name)`、`run.shot(target, name)`、`run.finish(errors)`。
- 禁止再新增 `path.join(__dirname, '_xxx.png')`、`tools/shots/`、`tmp-shots/` 这类固定路径；历史工具已迁到运行目录。
- 环境变量：`PROBE_RUN_DIR` 指定本次运行目录，`PROBE_SHOTS=0` 关闭截图，`PROBE_SHOTS=1` 开启截图。

### 4.3 端口与并发

- 测试服务必须 `listen(0)`，从 `server.address().port` 取真实端口，不允许写死 8148 / 8154 / 8972 / 9333 这类测试端口。
- Electron 测试必须使用独立 `--user-data-dir` 和独立调试端口。
- 8749 / 8787 / 8791 / 8794 / 8188 属于外部或共享服务，测试只能探测健康状态，不能假设自己独占。
- 多个 AI 同时跑测试时，不能共用同一个浏览器 profile、同一个 CDP 端口、同一个输出目录。

### 4.4 测试分层

| 类型 | 文件 | 运行方式 |
|---|---|---|
| 统一入口 | `tools/test-headless.js` | `node tools/test-headless.js <app>`，串行跑静态守卫 + 目标探针 |
| 运行沙箱 | `tools/probe-run.js` | 探针 `require('./probe-run')`，产物只进本次运行目录 |
| 静态守卫 | `tools/app-scan.js`、`ns-guard.js`、`conf-guard.js`、`css-links.js` | `node tools/<name>.js` |
| 注册表 / 桌面 | `app-registry.js`、`apps-all.js`、`desk-tabs.js` | 无头浏览器 |
| 单 App 探针 | `tools/probe-<app>.js` | 无头浏览器，优先 `--json` |
| 纯逻辑单测 | `tools/<module>.js` | Node / vm，不启浏览器 |
| Electron 集成 | `tools/electron-*.js`、`tools/e2e-*-electron.js` | 独立 `--user-data-dir` + 动态调试端口 |
| 视觉 / 性能 | `tools/shot-*.js`、`*-perf.js` | 唯一输出目录，产物不入库 |

### 4.5 提交前必跑

```bash
node tools/test-headless.js <app>
node tools/test-headless.js --all          # 涉及共享层 / 全量 App 时
node tools/test-headless.js --full         # 额外跑注册表与全量打开
```

等价的手动拆分：

```bash
node tools/app-scan.js --check
node tools/ns-guard.js
node tools/conf-guard.js
node tools/css-links.js
```

按改动范围追加：

- 改了 `registerApp` / 注册表 / App 列表：`node tools/app-registry.js`、`node tools/apps-all.js`
- 改了单个 App：`node tools/probe-<app>.js`
- 改了桌面外壳 / 标签条：`node tools/desk-tabs.js`
- 改了共享 JS / CSS：至少跑一次全量 App 打开与对应模块单测

测试结果统一写入 `.workbuddy/runs/<时间>-<pid>/summary.json`；失败时先看对应子目录的 `run.json` 与截图，不要重新跑一遍靠肉眼猜。

---

## 5. 文件管理规范

### 5.1 三类文件

| 类型 | 例子 | 处理 |
|---|---|---|
| 源码 | `apps/`、`js/`、`css/`、`electron/`、`server/`、`plugins/` | 正常提交 |
| 生成物 | `apps/manifest.js`、`dist*`、`release/`、`out/` | 不手改；按需重新生成；不入库 |
| 临时产物 | 截图、日志、一次性脚本、备份 | 只进忽略目录，完成后删除 |

### 5.2 不入库清单

以下内容禁止提交：

- `openagi-store.json`、`*.env`、任何 API Key / token / 证书
- `node_modules/`、`dist/`、`dist-*`、`release/`、`out/`
- `tools/shots/`、`.workbuddy/`、`tmp-shots/`、`tools/_*`
- `samples/`、`assets/`、`media/`、`server/data/`
- `.tripo-profile*`、浏览器登录态、用户数据
- 根目录的 `*.png`、`*.log`、`*.bak-*`、`_*` 一次性文件

### 5.3 命名约定

- App id：小写 kebab-case，例如 `modeldesk`、`img-lab`
- App 文件：`app.js`、`app.css`、`body.js`
- 探针：`tools/probe-<app>.js`
- 纯逻辑测试：`tools/<module>.js`
- 视觉工具：`tools/shot-<target>.js`
- 一次性脚本 / 截图 / 草稿：`tools/_<name>.js` 或 `.workbuddy/runs/...`，并在完成时删除
- 文档：`docs/<主题>.md`，新配图放 `docs/assets/`

### 5.4 生成物规则

- `apps/manifest.js` 永远由 `node tools/app-scan.js` 重写。
- 日常测试只跑 `node tools/app-scan.js --check`，不要生成。
- 多个 AI 并行时，**生成 manifest 只在集成合入阶段执行一次**，避免互相覆盖。
- 修改 `.gitignore` 的例外规则（例如 `!vendor/GLTFExporter.js`）必须说明原因。

---

## 6. 并行开发

### 6.1 一个 AI 一个 worktree

```bash
node tools/wt.js new <appId>
node tools/wt.js list
node tools/wt.js status <appId>
node tools/wt.js merge <appId>
node tools/wt.js rm <appId>
```

- worktree 默认建在仓库外：`<仓库上级目录>/openagi-wt/<appId>`。
- 分支只允许改 `apps/<appId>/` 和 `apps/manifest.js`。
- 动 `js/`、`css/`、`index.html` 必须加 `--allow-shared` 并逐条人工过目。
- 合并门禁：`app-scan --check` + `ns-guard` + `css-links`，任一失败整体回滚。
- 不要在多个 worktree 同时 `npm start`；Electron 单实例锁会让后启动的实例静默退出。

### 6.2 不使用 worktree 时

- 开工前先声明本次要改的文件范围。
- 不允许两个 AI 同时改同一个 `apps/<id>/` 或同一个共享文件。
- 发现越界立即停止，先对齐再继续。

---

## 7. 交付检查清单

- [ ] 只改了自己负责的目录 / 文件
- [ ] 新 App 已跑 `app-scan`，`manifest.js` 是生成结果
- [ ] `app-scan --check`、`ns-guard`、`conf-guard`、`css-links` 全绿
- [ ] 目标 App 的探针通过，且没有固定端口 / 固定截图路径
- [ ] 没有提交密钥、截图、日志、临时脚本、备份
- [ ] 行为变更已同步文档
- [ ] 结果里写清：改了什么、跑了什么测试、哪些没跑

---

## 8. 规范维护

- 新增全仓约定，写进本文件，不要只留在对话里。
- `docs/` 里的旧方案不自动升级为规范；需要生效时，先提炼进本文件或 `apps/README.md`。
- 规则被证明不可执行时，修改规则本身，并说明替代方案；不要留下“尽量”“适当”这类无法判定的条款。
