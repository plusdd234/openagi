# 数字人 App 2.0 开发方案（语音陪伴 · 长期记忆）

- 状态：已生效（2026-11-13 当日开发并验收，PASS 5/5）
- 日期：2026-11-13
- 适用范围：`apps/live2d/`（数字人 App）、`tools/probe-live2d.js`
- 依据：`AGENTS.md`（一 App 一目录；`apps/manifest.js` 只由 `node tools/app-scan.js` 生成；测试默认无头、断言不靠截图；产物只进 `.workbuddy/runs/`）

## 0. 基线：1.x 已完成

| 能力 | 实现位置 | 状态 |
|---|---|---|
| Cubism 4 皮套渲染（moc3 + 2 张 2048 纹理） | `apps/live2d/model/` + `vendor/` | 已上线 |
| `file://` 加载（moc3 base64 + Live2DLoader 中间件 + 纹理 data URL） | `app.js` `loadRig()` / `serveFromPack()` | 已上线 |
| 呼吸 / 眨眼 / 物理 / 视线跟随 | 模型自带 + `focusController` | 已上线 |
| 7 种情绪映射 exp3、44 表情中 6 个可手动试演 | `EXPR` | 已上线 |
| 8 组 motion3 动作条 | `ACT_LINES` | 已上线 |
| 流式回复按字符驱动 `ParamMouthOpenY` | `frame()` / `speechFeed()` | 已上线 |
| 人设、聊天记录、亲密度本地持久化 | `hf_live2d_state` | 已上线 |

## 1. 设计点枚举与本期取舍

| 编号 | 设计点 | 现状 | 本期 | 取舍理由 |
|---|---|---|---|---|
| D01 | 多皮套切换 | 无 | 不做 | 缺第二套可商用素材；单套再增约 10MB |
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

- `node tools/test-headless.js live2d` → **PASS 5/5**（app-scan / ns-guard / conf-guard / css-links / probe），最近一次产物 `.workbuddy/runs/20261113-230812-34420`。
- 探针共 49 项断言，新增 13 项：音色下拉、语速落盘与文案、试听 utterance 语速与角色名、boundary 口型、说话态与 Esc 归零、记忆写入面板与 diag、摘要请求分流、记忆注入下一次对话、导出 Markdown、快捷话题、清空记忆、鼠标在头顶上方时抬头。
- 舞台气泡：49 项中含 3 项气泡断言——最新回复同步到头顶气泡、气泡落在舞台可见范围内、点击可收起；另有窄窗「不压名牌、不出舞台」1 项。
- 视线修正：原点从「舞台中心」改为「模型眼睛的屏幕位置」，纵向按 `focusController` 的上正坐标取反；舞台比皮套宽时不再出现「鼠标停在脸上却低头」。
- 视觉复验：1440×900 角色面板三块新 UI 排列整齐；900×760 切上下布局，侧栏与 App 横向溢出均为 0，角色面板内部滚动正常。
- 视觉复验（气泡）：宽窗气泡贴头顶、尾巴朝下，与名牌/亲密度条不重叠；窄窗头顶空间不足时退到底部浮层（`is-tight`，隐藏尾巴），避开 HUD 与动作条；顺带把 toast 挪到左上，避免压住气泡。
- 已知：`SpeechSynthesisUtterance.rate` 是 float32（1.2 → 1.200000047），探针用 0.01 容差比较。
- 已知：`?nostore=1` 只阻断中转回写，不阻断原生 `localStorage`，本地中转仍会把上次的 `hf_*` 回填进来；探针在打开窗口后先点 App 的「恢复默认」，保证起点确定。

## 7. 变更记录

- 2026-11-13：方案建立，D01–D18 设计点枚举，S1–S4 开工。
- 2026-11-13：S1–S4 全部落地；`apps/live2d/app.js`、`body.js`、`app.css`、`tools/probe-live2d.js` 更新；验收通过，状态转「已生效」。
- 2026-11-13：修正视线跟随——原点改为模型眼睛位置，纵向符号取反；探针补「鼠标在头顶上方时抬头」断言（46 项）。
- 2026-11-13：对话气泡框——舞台新增 `#l2dSay`（流式实时同步、超时/点击自动收起、发送与清空时隐藏），宽窗贴头顶、窄窗退到底部浮层；`__l2dRig()` 增加 `anchorX/anchorY/headTop` 诊断；探针补 3 项气泡断言，共 49 项。
