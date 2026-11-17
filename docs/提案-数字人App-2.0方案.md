# 数字人 App 2.0 开发方案（语音陪伴 · 长期记忆）

- 状态：已生效（2026-11-13 当日开发并验收，PASS 5/5）
- 日期：2026-11-13
- 适用范围：`apps/live2d/`（数字人 App）、`tools/probe-live2d.js`
- 依据：`AGENTS.md`（一 App 一目录；`apps/manifest.js` 只由 `node tools/app-scan.js` 生成；测试默认无头、断言不靠截图；产物只进 `.workbuddy/runs/`）

## 0. 基线：1.x 已完成

| 能力 | 实现位置 | 状态 |
|---|---|---|
| Cubism 4 皮套渲染（moc3 + 2 张 2048 纹理） | `apps/live2d/model/` + `vendor/` | 已上线 |
| `file://` 加载（moc3 base64 + Live2DLoader 中间件 + 纹理 data URL） | `app.js` `usePack()` / `tools/pack-live2d.js` | 已上线 |
| 呼吸 / 眨眼 / 物理 / 视线跟随 | 模型自带 + `focusController` | 已上线 |
| 7 种情绪映射 exp3、44 表情中 6 个可手动试演 | `EXPR` | 已上线 |
| 8 组 motion3 动作条 | `ACT_LINES` | 已上线 |
| 流式回复按字符驱动 `ParamMouthOpenY` | `frame()` / `speechFeed()` | 已上线 |
| 人设、聊天记录、亲密度本地持久化 | `hf_live2d_state` | 已上线 |

## 1. 设计点枚举与本期取舍

| 编号 | 设计点 | 现状 | 本期 | 取舍理由 |
|---|---|---|---|---|
| D01 | 多皮套切换 | 无 | **做**（架构） | 先落地「一目录一套 + 运行时换装」；第二套素材另加，不随仓库内置 |
| D02 | 皮套缩放 / 位置拖拽 | 固定 0.97 居中贴底 | 不做 | 已有 ResizeObserver 自适应，收益低 |
| D03 | 语音输入 ASR | 无 | 不做 | Web Speech 识别依赖联网，`file://` 与无头环境都不可靠、不可测 |
| D04 | TTS 音色 / 语速 / 音调 | 硬编码 1.04 / 1.12 | **做** | 系统语音即可，零依赖、可持久化 |
| D05 | 口型与朗读对齐 | 字符节拍 | **做** | 优先吃 `onboundary` 词边界，节拍兜底 |
| D06 | 打断 | 只有按钮 | **做** | Esc 全局中止朗读与生成 |
| D07 | 情绪映射 | 7 种 | 维持 | 与 44 表情中的 7 个一一对应，够用 |
| D08 | 说话点头 | 无 | **做** | `ParamAngleZ` 叠加轻微点头，幅度 ≤2° |
| D09 | 待机随机小动作 | 无（只有视线漂移） | 不做 | 无人在意时自说自话易打扰 |
| D10 | 长期记忆摘要 | 无 | **做** | 手动「整理记忆」+ 每 12 条自动 |
| D11 | 记忆注入提示词 | 无 | **做** | 摘要拼进 system，跨会话记得住 |
| D12 | 亲密度分层口吻 | 只有等级文案 | **做** | 提示词加分层行为准则 |
| D13 | 快捷话题 | 无 | **做** | 3 个 chips，降低冷启动门槛 |
| D14 | 导出对话 | 无 | **做** | Markdown，本地 Blob 下载 |
| D15 | 清空记忆 | 无 | **做** | 与清空对话区分开 |
| D16 | 隐藏窗口省电 | 靠窗口 hidden 判断 | **补** | 再加 `document.hidden` 保护 |
| D17 | 探针覆盖 | 32 项 | **扩** | 新增语音、记忆、导出、快捷话题断言 |
| D18 | 桌宠透明置顶窗 | 无 | 不做 | 要改 `js/` 桌面外壳共享层，超出单 App 边界 |

## 2. 本期方案

### S1 语音（D04–D06、D08）
- 角色面板新增「朗读声音」：音色下拉（系统中文 voice + 「系统默认」）、语速 0.7–1.4、音调 0.7–1.5、试听一句。
- 设置存进 `persona.tts = {voice, rate, pitch}`，随 `hf_live2d_state` 持久化；`STORE_VER` 升到 2，兼容读 v1。
- `speakAloud()` 读设置；`utterance.onboundary` 触发口型脉冲，`onstart/onend` 维护 `rig.speaking`；没有 boundary 事件时保留字符节拍兜底。
- Esc：停止朗读；正在生成时同时中止请求。
- 点头：朗读期间把 `sin(t*6)*1.6` 叠加到 `ParamAngleZ`，在 `beforeModelUpdate` 里写。

### S2 记忆（D10–D12）
- `S.mem = {summary, at, count}`，`count` 记录摘要时已覆盖的消息条数。
- `summarizeNow()`：取最近 40 条消息，用独立提示词调 `llmStreamRequest`，产出 ≤120 字中文备忘；不占 `S.busy`、不渲染气泡、失败静默。
- 触发：角色面板「整理记忆」手动；`msgs.length - mem.count >= 12` 时自动（不并发）。
- `buildSystem()` 追加：`长期记忆备忘：…` 与亲密度分层准则（初识/熟悉/亲近/默契/心照不宣各自的称呼与主动程度）。
- 「清空记忆」只清摘要，不动对话。

### S3 快捷话题与导出（D13–D15）
- 输入框上方 3 个 chips：夸夸我 / 陪我聊聊 / 讲个笑话；点击等价于把文案作为用户消息发送。
- 「导出对话」生成 Markdown：标题、亲密度与条数、按时间分段的双向消息；Blob + `a[download]` 落地。

### S4 工程（D16、D17）
- `frame()` 增加 `document.hidden` 早退，窗口隐藏时彻底不更新模型。
- 探针新增只读钩子：`window.__l2dDiag()`（speaking / tts / mem / aff / msgs / busy）与 `window.__l2dExportText()`；`__l2dRig()` 增加 `angleZ`。
- 探针新增断言 11 项，覆盖 S1–S3 与持久化。

### S5 多皮套装载（2026-11-15 追加）

皮套本身是标准 Cubism 3/4（`*.model3.json` + `moc3` + 纹理 + exp3/motion3），
不是画出来的假人；此前只有一套数据包，所以换装要改代码。现在拆成「目录约定 + 运行时切换」：

- 目录：`apps/live2d/model/<id>/` 放一整套标准文件，可选 `meta.json`（`name` / `author` / `license`）。
  源码里的 `model/` 不再平铺模型文件。
- 打包：`node tools/pack-live2d.js` 扫描全部 `model/<id>/`，给每套生成 `pack.js`
  （moc3 → base64、纹理 → data URL（`file://` 下 `<img>` 会被 CORS 拦）、json → 对象），
  并生成 `model/models.js` 清单；`node tools/pack-live2d.js <id>` 只重打一套。
- 加载：运行时先注入 `models.js`，再按选中项注入对应 `pack.js`；
  `Live2DLoader` 中间件只装一次，换装时替换 hook 里的包，不堆旧中间件。
- 切换：角色面板「皮套」下拉，选择即 `dispose → 重新加载`，销毁旧 PIXI 应用与 canvas，
  加载代数 `rig.gen` 防止并发叠模型；选择写入 `hf_live2d_state.modelId`。
- 兼容：第二套皮套可能没有 `excited/blush/...` 表情或 `selfie/bubble/...` 动作组，
  缺失时静默跳过（表情 try/catch、动作 Promise catch），idle 组有 `idle` 优先、否则用模型自带 `Idle`。
- 默认：没有存档时用清单第一套；存档里的皮套被删掉时自动退回第一套。

### S6 语音合成配置对齐系统能力（2026-11-16 追加）

角色面板的朗读声音不再只列中文系统语音，而是与 `js/settings-tts.js` 共用一份音色清单：

- `window.ttsBridge` 加法扩展：`catalog({refresh})`（系统语音 + 本地模型 + 引擎状态快照）、
  `label(value)`、`spec(value)`、`supportsPitch(value)`、`openSettings()`；设置页改默认音色、
  探测完成、克隆声音就绪时分别派发 `hf-tts-changed` / `hf-tts-status`。
- 下拉分组：`系统语音`（全量，带 `lang`）+ `本地模型`（Piper / Kokoro / MeloTTS / 角色音色 / ZipVoice，
  未就绪与缺参考录音都带后缀）；已存音色不在清单时补一项「（未就绪）」，避免悄悄退回系统默认。
- 引擎标签与状态行：`系统语音` / `本地模型` 徽标；状态行改为能力芯片（`系统语音 N` + Piper / Kokoro / MeloTTS / 角色音色 / ZipVoice，就绪绿点、未装灰点，悬停看具体状态）。整块做成带分隔线的卡片，检测 / 设置收进卡头。
- 音调：本地模型由权重决定，选中本地音色时 `#l2dPitch` 禁用、`#l2dPitchRow` 置灰并标注「仅系统语音」。
- 入口：「检测」重新探测本地引擎（首次进角色页也会探测一次）；「语音设置」直接跳到
  `openSettings('tts')`，ZipVoice 缺参考录音时在提示里指路到「声音克隆」。
- 音色优先级不变：人设 `persona.tts.voice` 优先，未选时跟随 `hf_ttsVoice` 默认音色，提示行会写明正在跟随谁。

### S7 音色分「超拟人 / 机械音」，机械音可选朗读方式（2026-11-16 追加，2026-11-17 已废弃）

> 2026-11-17 更新：深海机娘机械音、`tts-mecha.js` 效果器与 `vits:mecha` 启用值已删除，
> 该页签由 S9「快速合成」替代；下面的机械音描述只作历史记录。

- 设置页「语音合成 → 音色」拆成两个页签：
  - **超拟人**：系统语音 + 本地自然音色（Piper / Kokoro / MeloTTS / 角色音色原声 / ZipVoice）。
  - **机械音**：深海机娘 · 二次元机械音，复用「海星」VITS 共享模型（不额外占磁盘），卡片显示安装状态、
    「使用机械音」（未安装则跳模型商店）与试听。默认音色是机械音时，打开设置直接落在机械音页签。
- 机械音的两种朗读方式存在 `hf_ttsMechaMode`（`ai` 默认 / `direct`），设置页与数字人共用同一份状态：
  - `ai`：系统提示词才下发 `[[p]]/[[r]]/[[t]]` 规则，由模型按语义控制停顿 / 变速 / 拖音；试听文本没有标记时自动套一句示范节奏。
  - `direct`：合成前剥离全部标记，整句原样读出。
- 数字人语音面板：本地音色分成「超拟人 · 本地模型」与「机械音」两组；选中机械音时出现「AI 控制 / 直接朗读」切换
  （S8 已把这一行扩展到全部支持韵律的本地音色）；直接朗读下 `speakAloud()` 先剥标记，避免标记被断句念出。
- 气泡、聊天记录、长期记忆仍只存剥离后的文本；标记只影响朗读链路。

### S8 AI 语音控制扩展到全部可韵律音色（2026-11-17 追加）

- 触发条件从「机械音 + AI 控制」放宽为「**支持韵律的本地音色 + AI 控制**」：
  Piper / Kokoro / MeloTTS / VITS 角色音色都会在系统提示词里拿到 `[[p]]/[[r]]/[[t]]` 规则；
  系统语音、ZipVoice 克隆音色不注入，直接朗读模式下也不注入。
- 数字人语音面板的「AI 控制 / 直接朗读」行不再只在机械音下出现，选中上述任一本地音色即可切换；
  状态键后来改为 `hf_ttsAiMode`（设置页与数字人共用），旧键不再读取。
- 桥接层 `/tts/speak` 的韵律分段从 VITS 专用改为通用：
  - `PROSODY_ENGINES = piper / kokoro / melo / vits`，逐段按 `[[r]]` 设置该引擎的 `length_scale`；
  - 段间按 `[[p]]` 插静音，段尾按 `[[t]]` 补拖音，最后拼成一个 WAV；
  - 没有标记时仍走原单次合成，不增加开销；ZipVoice 的语速参数不同，暂不参与。
- 角色音色（含机械音）默认开启 AI 控制；关闭后 `speakAloud()` 先剥标记，气泡 / 记忆始终只存干净文本。
- 验证：`tools/probe-live2d.js` 增加角色音色显示切换、直接朗读、提示文案、系统提示注入 4 项断言（共 65 项）；
  `tools/tts-prosody.js` 35/35、`tools/tts-mecha.js` 12/12、`tools/settings.js` 全绿。
  真实引擎的逐段合成需在装好模型后的桌面端试听确认；本机未安装本地语音模型，未跑端到端音频合成。

### S9 参数合成 · 快问快答（2026-11-17 追加）

目标不是给声音加机械音色，而是**运行时不再加载大语音模型**：老师模型只在离线蒸馏时用一次，
之后由 LLM 的语速 / 停顿 / 音调 / 重音参数直接驱动波形，适合数字人短问答。

- 离线蒸馏：`tools/distill-voice.js` 用已安装的 VITS Theresa 作为老师，从 `lexicon.txt`
  取「单字 → 带调音节」，每个音节合成一次，裁静音、估基频、统一成 16 kHz 单声道 PCM。
- 内置音库：产物已随仓库放在 `plugins/runtime/param-bank/{bank.json,units.bin}`
  （1220 个带调音节 / 20649 个单字 / PCM 14 MB），不装老师模型也能直接用「快速合成」。
  运行时按「用户目录 `<TTS_DIR>/param` → 内置目录」的顺序取音库；重新蒸馏可用
  `node tools/distill-voice.js --out plugins/runtime/param-bank --force` 覆盖内置音库。
- 蒸馏细节：`lexicon.txt` 里同一音节的字按「生僻 → 常用」排，且 sherpa 会把**单字**输入
  误判成 GB2312，所以每个音节收集最多 40 个候选字并补一个句号（强制 UTF-8 分支）逐个重试；
  支持 `--jobs N` 并发与 `--out <dir>`。实测覆盖 1220/1379 个音节、20649/20901 个单字，
  剩余缺失集中在只有生僻字可用的轻声音节。
- 运行时：`plugins/runtime/tts-param.js` 纯 JS 合成，不启动子进程、不加载 onnx：
  - 文字按「单字 → 音节」查音库，TD-PSOLA 同时控制时长与音调；
  - 标点自带基础停顿，段落按 LLM 标记叠加 `[[r]]/[[p]]/[[t]]`，并支持 `[[f]]` 音调、`[[e]]` 重音；
  - 相同请求走 LRU 缓存；音库缺失返回 404 由前端提示蒸馏，损坏才报 500。
- 桥接层：`/tts/speak` 新增 `engine=param`；`/tts/status` 回报 `param/paramUnits/paramChars`。
- 数字人：音色清单在音库就绪后出现「参数合成 · 快问快答」，与其它本地音色一样支持
  「AI 控制 / 直接朗读」；系统提示只在参数音色下额外注入 `[[f]]/[[e]]` 规则。
- 入口替换：删除「深海机娘 · 二次元机械音」目录项、`vits:mecha`、`tts-mecha.js` 与 DSP 效果器；
  设置页第二页签与数字人快照都改为「快速合成」（`param:fast`），音库未蒸馏时显示引导文案。
  数字人的 AI 控制开关改用中性命名 `l2dAiCtrl` / `data-l2d-ai`，状态键统一为 `hf_ttsAiMode`。
- 验证：`tools/tts-param.js` 21/21（状态、拼接、语速、停顿、PSOLA 变调、重音、缓存、坏索引）、
  `tools/tts-prosody.js` 45/45。本机已用 VITS Theresa 全量蒸馏出内置音库；
  另在本机用空的 `TTS_DIR` 起 runtime 验证：`/tts/status` 返回 `param:true`（1220 单元 / 20649 字），
  `/tts/speak`（`engine=param`）返回合法 WAV，证明内置回退生效。

## 3. 多 AI 分工（文件所有权）

| 角色 | 文件 | 任务 | 约束 |
|---|---|---|---|
| 主编排 | `apps/live2d/app.js`、本方案文档 | 全部逻辑、集成、验收 | 不碰 body.js / app.css / probe |
| AI-A（界面） | `apps/live2d/body.js`、`apps/live2d/app.css` | 新增朗读/记忆/快捷话题 DOM 与样式 | 只加不改；不跑 app-scan 与测试 |
| AI-B（测试） | `tools/probe-live2d.js` | 扩 11 项断言，保持原有 32 项 | 只写不跑（功能未就绪） |

合并门禁（集成阶段串行执行一次）：
`node tools/app-scan.js` → `node tools/test-headless.js live2d`（内含 app-scan --check、ns-guard、conf-guard、css-links、probe）。

## 4. 验收标准

1. 角色面板可调语速到 1.2，`localStorage` 的 `persona.tts.rate === 1.2`，重开窗口保持。
2. 试听时 `SpeechSynthesisUtterance.rate` 等于当前设置，文本含角色名。
3. 朗读期间 `__l2dRig().mouth > 0.08`（boundary 驱动），`__l2dDiag().speaking === true`。
4. Esc 后 `speaking === false`。
5. 点「整理记忆」后 `#l2dMemText` 与 `diag.mem.summary` 出现摘要文本。
6. 下一次对话的 system prompt 包含该摘要。
7. `__l2dExportText()` 含用户原话与「共 N 条」。
8. 点快捷话题后出现对应用户气泡。
9. 清空记忆后文案回到「还没有整理过记忆。」
10. `node tools/test-headless.js live2d` 全绿；900×760 无横向溢出。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 无头环境没有系统语音，`speak()` 不产生声音 | 探针覆盖 `speechSynthesis.speak/cancel` 并手动派发 `onboundary`，只验证调用链与口型 |
| 部分引擎不派发 `onboundary` | 保留字符节拍兜底；`ttsUntil` 仍按字数估算 |
| 摘要请求与对话共用 `llmStreamRequest` | 独立 opts 标记、独立 Promise，不占用 `S.busy`；stub 按 system 文本分流 |
| v1 存档没有 `tts` / `mem` | `loadState()` 逐字段兜底并夹取范围 |

## 6. 验收记录

- `node tools/test-headless.js live2d` → **PASS 5/5**（app-scan / ns-guard / conf-guard / css-links / probe），最近一次产物 `.workbuddy/runs/20261115-165433-19768`。
- 探针共 51 项断言，新增 13 项：音色下拉、语速落盘与文案、试听 utterance 语速与角色名、boundary 口型、说话态与 Esc 归零、记忆写入面板与 diag、摘要请求分流、记忆注入下一次对话、导出 Markdown、快捷话题、清空记忆、鼠标在头顶上方时抬头。
- 舞台气泡：51 项中含 3 项气泡断言——最新回复同步到头顶气泡、气泡落在舞台可见范围内、点击可收起；另有窄窗「不压名牌、不出舞台」1 项。
- 多皮套：2 项断言——皮套下拉可见且列出 `c_0120`、署名跟随模型。
- 换装实测（临时第二套皮套，验证后删除）：切换后旧 canvas 销毁、舞台上仅 1 份 canvas、选择与 `hf_live2d_state.modelId` 落盘、切回原皮套正常，无脚本错误。
- 视线修正：原点从「舞台中心」改为「模型眼睛的屏幕位置」，纵向按 `focusController` 的上正坐标取反；舞台比皮套宽时不再出现「鼠标停在脸上却低头」。
- 视觉复验：1440×900 角色面板三块新 UI 排列整齐；900×760 切上下布局，侧栏与 App 横向溢出均为 0，角色面板内部滚动正常。
- 视觉复验（气泡）：宽窗气泡贴头顶、尾巴朝下，与名牌/亲密度条不重叠；窄窗头顶空间不足时退到底部浮层（`is-tight`，隐藏尾巴），避开 HUD 与动作条；顺带把 toast 挪到左上，避免压住气泡。
- 已知：`SpeechSynthesisUtterance.rate` 是 float32（1.2 → 1.200000047），探针用 0.01 容差比较。
- 已知：`?nostore=1` 只阻断中转回写，不阻断原生 `localStorage`，本地中转仍会把上次的 `hf_*` 回填进来；探针在打开窗口后先点 App 的「恢复默认」，保证起点确定。默认音色可能来自 `hf_ttsVoice` 的本地模型，语音断言里显式先选一项系统语音，避免依赖机器状态。
- 2026-11-16 语音配置：探针共 59 项，新增 8 项——音色下拉分组数量、状态行「系统语音 N 个」、检测 / 语音设置入口可见、选系统语音后引擎标签与音调同步、本地音色（melo）时音调禁用与引擎标签、本地音色提示音调不生效、切回系统语音后音调恢复。
- 2026-11-16 回归：`node tools/probe-live2d.js` 全绿；`node tools/probe-wardrobe.js` 23 项全绿；`node tools/test-headless.js --all` PASS 10/10；`--full` PASS 6/6（含 app-registry / apps-all）。

## 7. 变更记录

- 2026-11-13：方案建立，D01–D18 设计点枚举，S1–S4 开工。
- 2026-11-13：S1–S4 全部落地；`apps/live2d/app.js`、`body.js`、`app.css`、`tools/probe-live2d.js` 更新；验收通过，状态转「已生效」。
- 2026-11-13：修正视线跟随——原点改为模型眼睛位置，纵向符号取反；探针补「鼠标在头顶上方时抬头」断言（46 项）。
- 2026-11-13：对话气泡框——舞台新增 `#l2dSay`（流式实时同步、超时/点击自动收起、发送与清空时隐藏），宽窗贴头顶、窄窗退到底部浮层；`__l2dRig()` 增加 `anchorX/anchorY/headTop` 诊断；探针补 3 项气泡断言，共 49 项。
- 2026-11-15：皮套装载改成标准 Cubism 目录——`model/<id>/`（model3.json + moc3 + 纹理 + exp3/motion3 + `meta.json`），`tools/pack-live2d.js` 逐套打包并生成 `model/models.js` 清单；`app.js` 去掉写死的单包，改为清单驱动 + 运行时换装（`usePack/mountModel/disposeRig/switchModel`，`rig.gen` 防并发）；角色面板加「皮套」下拉，选择写入存档；表情/动作缺失时静默降级；探针补 2 项断言，共 51 项。
- 2026-11-15：衣柜联动——启动读 `hf_wardrobe_state.draft`（皮套 + 隐藏部件），`beforeModelUpdate` 压部件透明度；新增 `window.__l2dApplyOutfit` 与 `__l2dRig().hidden`；加载器中间件改为按 `settings.__l2dPack` 认领，衣柜与数字人同时打开也不会串包。详见 `docs/提案-衣柜App.md`。
- 2026-11-16：语音合成配置对齐系统能力（S6）——`js/settings-tts.js` 的 `ttsBridge` 增补 `catalog/label/spec/supportsPitch/openSettings` 并派发 `hf-tts-changed` / `hf-tts-status`；角色面板改为分组音色下拉 + 引擎徽标 / 状态行 / 检测 / 语音设置入口，本地音色禁用音调并给出说明；探针补 8 项，共 59 项。
- 2026-11-16：音色界面分「超拟人 / 机械音」（S7）——设置页两页签 + 机械音卡片（AI 控制 / 直接朗读 / 使用 / 试听），数字人语音下拉同步分组并显示模式切换，`hf_ttsMechaMode` 为唯一状态；节奏标记只在「机械音 + AI 控制」时注入系统提示；`tools/probe-live2d.js` 补 2 项（共 61 项），`tools/settings.js` 补 4 项页签与模式断言。
- 2026-11-17：AI 语音控制从机械音扩展到全部可韵律本地音色（S8）——数字人角色音色也显示「AI 控制 / 直接朗读」，系统提示按音色能力注入；桥接层韵律分段支持 Piper / Kokoro / MeloTTS / VITS，语速换算统一为 `ttsRateScale()`；探针补 4 项（共 65 项）。
- 2026-11-17：参数合成 · 快问快答（S9）——`tools/distill-voice.js` 离线蒸馏带调音节音库，`plugins/runtime/tts-param.js` 纯 JS PSOLA 拼接，`/tts/speak` 增 `engine=param`，数字人音色清单自动出现该音色；`[[f]]/[[e]]` 扩展到 LLM 可控制的音调与重音；`tools/tts-param.js` 21/21、`tools/tts-prosody.js` 45/45。
- 2026-11-17：下线深海机娘机械音（S7），第二个音色页签改为「快速合成」——删除 `vits-mecha` 目录项、`vits:mecha` 启用值、`plugins/runtime/tts-mecha.js` 与 `tools/tts-mecha.js`；数字人 AI 控制行改为 `l2dAiCtrl`，状态键统一 `hf_ttsAiMode`；`tools/model-store.js` 增加「机械音已下线」断言。
- 2026-11-17：快速合成音库转为内置模型（S9）——用 VITS Theresa 全量蒸馏出 `plugins/runtime/param-bank/`（1220 音节 / 20649 字 / 14 MB），runtime 按「用户音库 → 内置音库」回退，不装老师模型也能直接用；`distill-voice.js` 增加候选字重试（最多 40 个）、单字补句号绕过 sherpa 的 GB2312 误判、`--jobs N` 并发与 `--out <dir>`。
