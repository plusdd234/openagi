# 建模 App · Blender 架构对标与并行开发任务卡

> 基线：2026-11-04 实测 `node tools/probe-modeldesk.js` → **116/116 全绿，0 pageerror**。
> 本文只写「实测能点出什么」，不按旧里程碑表的口径写。

---

## 0. 事实基线

### 0.1 本轮实测

| 指标 | 实测值 |
| --- | --- |
| 探针断言 | 116 项全绿（含拾取、撤销、保存往返、四视图、热盒、算子会话） |
| 视口 | 606×613，240 tri / 15 draw call，ACES Filmic，峰值 222/255，过曝 0% |
| DOM | 449 节点，11 个占位 span |
| 多对象 | `doc.meshes` + `node.meshRef` 已落地，GLB 往返两对象面数一致 |
| 算子 | 14 个：挤出/内插/删面/合并点/平滑/倒角/桥接/分段/连接/目标焊接/四边形/分离/切刀/布尔 |
| 静态检查 | `js/model-desk.js` 4796 行、200+ 个闭包函数、21 个职责段 |

### 0.2 旧计划表与实际进度不一致（已校正）

旧 `docs/建模App-计划表单.csv` 明显滞后。以下按代码+探针校正：

| 编号 | CSV 状态 | 实际 | 证据 |
| --- | --- | --- | --- |
| V7 | 待开发 | **已完成** | 四视图逐格激活、双击最大化、Esc 退出（`model-desk.js` 1741–1857） |
| S5 | 待开发 | **内核已就绪，未接线** | 手柄已有 `setConstraint(axis)`（`model-transform-gizmo.js` 179），主壳没有 X/Y/Z 键绑定 |
| S2b | 待开发 | **已完成（本轮接线）** | `setSelMode` 改为 `SeedSelection.convertSelection`，面→顶点→面往返探针通过 |
| A3 | 待开发 | **已完成（本轮接线）** | 手柄步长改读 `SeedSnap.getPrefs()`；UI 吸附开关同步 `setEnabled`，一份状态 |
| A4 | 待开发 | **已完成** | 八项全接：栅格/边/点/线框 + 背面（material.side）/材质（本色⇄素模）/纹理（map 留底）/光照（方向光归零、环境光保留） |
| A1/A2 | 待开发 | **已落地** | 命令注册表 + 工具会话 + 参数条，14 个算子全部走 `SeedTools` |
| B2a/B2d | 待开发/进行中 | **已完成** | 多网格文档、GLB 两对象往返均过探针 |
| M6b | 未开工 | **已完成** | `seed-operators.js` 48KB，14 个算子注册进命令表 |
| X2 | 待开发 | **已完成** | 软选择面板 + 权重衰减 + 热力曲线 + 按权重变换 |
| X1 | 待开发 | **部分完成** | 倒角/桥接/分段已做；环切已升级为四边环 loop cut（X6，含循环边，条数/滑移可调）；三角转四边（X7）已接入；溶解未做 |

### 0.3 真正的剩余缺口（按影响排序）

1. **双真源（已收口三项）**：吸附步长与开关只读 `SeedSnap`、栅格与显示开关只读 `SeedViewFlags`；选择集仍是 `st.sel` → `doc.selection` 手动 sync。
2. **入口未收口**：七组菜单仍是占位；命令行只认完整命令 id；快捷键是一段 300 行 switch。
3. **UI 与命令混写**：`onClick` 一个 150 行 switch + 35 处 UI 字符串拼在 `model-desk.js`。
4. **模块存在但未接线**：`seed-evaluator`（恒返回 base）；`seed-snap` / `seed-view-flags` / `convertSelection` 已在本轮接上。
5. **工具缺 Blender 的「模态」行为**：拖动中数值输入（S6/S7）、轴约束（S5）、上次算子参数复用（redo panel）。
6. **交付风险**：22 个建模模块 + docs 全部未纳入版本库（`git status` 全为 `??`），一崩就全丢。

---

## 1. Blender 架构对照

Blender 的分层不是「文件多」，而是**每层只有一种真相，层间只走契约**。逐层对照：

| Blender 层 | 作用 | 我们的现状 | 差距 | 本轮动作 |
| --- | --- | --- | --- | --- |
| `bpy` / RNA 数据 API | 文档是唯一真源，UI 不持有数据 | `SeedModel.Scene` + `SeedModel.Mesh`（face-vertex、稳定 ID、base64） | **已对齐**，且更简单 | 冻结为 core 契约，不许 shell 直接改数组 |
| Depsgraph + evaluated object | base data → 求值结果，视口只读求值 | `seed-evaluator.js` 49 行空壳，恒返回 base | 缺修改器栈；MVP 可暂缓 | X4 延后，但接口先冻结（`evaluate(doc,node)`） |
| Operator（poll / exec / modal / redo） | 命令有可用性判定、可交互、可复用参数 | `SeedCommands.when` + `SeedTools.begin/drag/commit/cancel` | 缺 modal keymap、数值输入、last-op 参数 | B 路线补 3 张卡 |
| Tool system + gizmo group | 工具是持续态，手柄按工具/轴切换 | `model-transform-gizmo` 三轴三环 + `setConstraint` | 未接 X/Y/Z 键；无平面/中心手柄 | B2 |
| Keymap（区域 + 上下文 + when） | 同一键在不同区域/模式不同义 | 300 行 `onKeyLayer` switch，硬编码 | 无注册表、无 when、不可重映射 | B5 |
| Context（active object / area / mode） | 操作显式拿上下文，不读全局 | 全部读闭包 `st` | 子模块只能被主壳调用，无法独立测试 | 冻结 `MdHost` 上下文 |
| Undo（全局栈 + 操作名 + memfile） | 一次操作 = 一条可命名历史 | 快照带网格指纹、按内容去重、64MB 预算 | **优于 Blender 的粗粒度**；缺「跨会话撤销策略」 | 保持，I 路线补 D1/D2 |
| Space / Region / Panel / Menu | UI 由 schema 渲染，不手拼 DOM | `ensureUI()` 一次 `innerHTML` + 35 处拼接 | 菜单/面板无法按命令表生成 | C1 + I1 |
| Asset browser / append | 资产与场景分离 | 桌面资产库 + `openAsset` | 已够用 | 不动 |
| Tests | 每个算子有回归 | 单一探针 116 项 | 缺按模块分段、缺失败即退出码 | I2 |

**不该照抄**：完整 depsgraph、节点编辑器、动画/骨骼、离线渲染、插件市场。这些会把建模主线拖慢（与旧审计 9.5 的「下游 DCC 不做」一致）。

---

## 2. 解耦目标：三层 + 一个上下文

### 2.1 依赖规则（冻结）

```
core    : seed-mesh-core / seed-model-scene / seed-selection / seed-operators / seed-snap
          —— 纯函数或纯数据，禁止 DOM、禁止 THREE 场景对象、禁止读写 localStorage
session : seed-commands / seed-tools / seed-keymap(新) / seed-view-flags
          —— 只做状态与调度，禁止 document.querySelector / innerHTML
shell   : model-desk(拆分后) / md-*.js
          —— 唯一持有 THREE、DOM、历史、文档写入
```

四条铁律（评审直接按这四条打回）：

1. **文档只有一个写入口**：`MdHost.applyMesh(mesh, label)` / `MdHost.applyNode(patch, label)`。
2. **历史只有一个写入口**：`MdHost.commit(label)`，由 shell 在 `pointerup` / `commitTool` 调用；预览期间禁止。
3. **命令体不碰 DOM**：需要反馈时调 `ctx.status(...)` / `ctx.openPanel(...)`。
4. **算子不改输入**：`SeedOps.*` 返回新 mesh；原地改会毁掉历史指纹（已有约定，继续守住）。

### 2.2 `MdHost` 上下文契约（新增，先冻结后实现）

命令与工具统一拿这个对象，不再各自读 `st`：

```js
MdHost = {
  doc(), activeNode(), mesh(),           // 只读快照（mesh 为 base mesh）
  sel(), selMode(), tool(), space(),     // 只读选择/模式
  setSel(patch), setSelMode(mode),
  applyMesh(mesh, label),                // 唯一网格写入口（自动进历史）
  applyNode(nodeId, patch, label),
  status(msg, isError), openPanel(spec), closePanel(),
  requestRender(), frame(what),
  prefs(), setPrefs(patch),
  commands(), tools(), snap(), flags()   // 模块句柄，便于子模块互调
}
```

现状可先由 `model-desk.js` 暴露 `window.modelDesk.ctx()` 实现，**不改任何现有行为**；子模块迁移完成后再删内部捷径。

### 2.3 `model-desk.js` 拆分边界（按现有注释段，不重写逻辑）

| 目标文件 | 从 `model-desk.js` 迁出的段（行号） | 行数 | 依赖 |
| --- | --- | --- | --- |
| `md-viewport.js` | 视口 1477–1740、四视图导航 1741–1857、叠加层 1989–2199 | ~600 | THREE、ViewFlags、Host |
| `md-outline.js` | 大纲渲染 / 层级 / 拖拽（UI 段内） | ~250 | Host、Scene |
| `md-props.js` | 属性编辑器 / 通道盒 / 材质槽（`paintParams` 段） | ~300 | Host、m3d-slots |
| `md-toolbox.js` | 工具箱 3305–3587、热盒 3588–3975 | ~550 | Host、Commands |
| `md-history.js` | 历史 2200–2793 | ~590 | Mesh hash/clone、Host |
| `md-persist.js` | 新建/打开 4236–4268、导出/保存 4492–4578、覆盖层 4579–4622 | ~300 | GLB meta、资产库 |
| `md-input.js` | 选择手势 757–916、组件变换 917–1476、快捷键 2974–3143 | ~900 | Selection、Gizmo、Host |
| `model-desk.js` | UI 骨架 135–756 + 生命周期 + 路由 | ~900 | 以上全部 |

拆分顺序 **leaf → trunk**：viewpoint/outline/props 先迁（风险低），`md-input`/`md-history` 最后（风险高）。每一步只允许「搬函数 + 注入 ctx」，**不允许顺手改行为**；每步完跑探针必须仍 116 全绿。

---

## 3. 三路并行 + 一路集成

### 3.1 文件白名单（互不重叠，冲突为零）

| 路线 | 可改文件 | 禁止触碰 |
| --- | --- | --- |
| **A · 视口与显示** | `js/md-viewport.js`(新)、`js/seed-view-flags.js`、`css/12-modeldesk.css` | `model-desk.js`、`seed-commands.js`、`seed-tools.js`、`index.html` |
| **B · 工具与交互** | `js/seed-snap.js`、`js/seed-tools.js`、`js/seed-keymap.js`(新)、`js/model-transform-gizmo.js`、`js/seed-selection.js` | `model-desk.js`、`model-transform-gizmo.js` 之外的手柄调用方 |
| **C · 命令 / UI / 持久化** | `js/md-outline.js`(新)、`js/md-props.js`(新)、`js/md-toolbox.js`(新)、`js/md-persist.js`(新)、`js/seed-commands.js` | `model-desk.js`、`seed-tools.js`、`index.html` |
| **I · 集成** | `js/model-desk.js`、`index.html`、`tools/probe-modeldesk.js`、`tools/probe-toolframe.js`、`docs/` | 其余路线的白名单文件（只读） |

> 唯一例外：B 路线若必须改手柄接线，先向 I 路线提「接线补丁」，由 I 路线落到 `model-desk.js`，B 不直接改。

### 3.2 并行节奏

1. **I 先冻结契约**（`MdHost` 方法签名 + `SeedTools` 扩展字段 + `SeedKeymap` 结构），发布给 A/B/C。
2. A / B / C 同时开工，各自只在自己的文件里实现，自带探针段。
3. I 每完成一次接线就提交一次：`probe → 116+ 绿 → commit`。
4. 三路产物汇入 I，I 负责 diff 评审（按第 2.1 四条铁律）与最终验收。

---

## 4. 任务卡（可直接投喂子 AI）

每张卡都写明「只改哪些文件、不许做什么、怎么算过」。验收命令统一：

```powershell
node tools/probe-modeldesk.js   # 必须 116/116 全绿（新增段另计）
node tools/probe-toolframe.js   # 命令/会话/吸附/显示四条链路
```

### A 路线

**A1 · 显示开关全量接线**（A4，最高性价比）
- 文件：`js/seed-view-flags.js`、`js/md-viewport.js`(新)
- 做：新增 `applyFlags(state, view)`，把 8 个开关一次性映射到 `gridHelper.visible` / `edgeLines.visible` / `vertPoints.visible` / `material.side` / `material.map` / 灯光强度 / 线框材质；渲染主循环不再出现 `if (showX)`。
- 不许：改 `st.showGrid` 之外的选择与历史逻辑；不许在渲染循环里加条件分支。
- 验收：探针新增 8 条断言，逐项切开关 → `__debug()` 对应对象状态变化；旧 116 条不变。

**A2 · 着色六态 + 照明四预设**（A5/A6）
- 文件：`js/md-viewport.js`
- 做：`shaded / shaded-wire / wire / flat / textured / xray` 六态；照明 `default / two-light / no-light / selected-only` 四预设，不重建材质、不动文档。
- 验收：六态切换后 `renderer.info` 与材质 `wireframe/transparent` 断言；纹理态无 UV 回退实体并进状态行。

**A3 · 视图布局单/四/双**（A7）
- 文件：`js/md-viewport.js`
- 做：在现有四视图 scissor 基础上加单/四/双（左右两屏各独立相机），切换保留当前相机。
- 验收：三种布局出图数、各屏 `quadCams` 存在、切回单视图相机姿态不变。

### B 路线

**B1 · 吸附单源**（A3）
- 文件：`js/seed-snap.js`、`js/model-transform-gizmo.js`
- 做：手柄删掉 `STEPS` 常量，改读 `SeedSnap.getPrefs()`（rotate 由度转弧度）；主壳 `snap` 开关改为 `SeedSnap.setEnabled`。
- 不许：改手柄几何/拾取面；不许改默认值 0.05 / 15° / 0.1。
- 验收：改 `SeedSnap.setPrefs({move:0.25})` 后拖手柄，位移必须是 0.25 的整数倍；关闭吸附后为连续值。

**B2 · 轴约束 X/Y/Z**（S5）
- 文件：`js/model-transform-gizmo.js`（内核已就绪，仅补平面/中心手柄可选）
- 做：拖动中按 X/Y/Z → `setConstraint`；再按一次取消；约束态在 HUD 显示。
- 由 I 路线接键盘：`model-desk` 在 `onTransformStart` 后转发按键。
- 验收：拖 X 手柄时按 Y，位移只剩 Y 分量；Esc/再按取消后恢复自由拖动。

**B3 · 模态数值输入**（S6/S7）
- 文件：`js/seed-tools.js`、`js/model-transform-gizmo.js`
- 做：拖动中键入数字 → 回车按该值落定、Esc 取消整次拖动；`SeedTools` 增加 `modalKeys` 描述（不自己绑 DOM，由 shell 转发）。
- 验收：探针模拟 `pointerdown → keydown "1.5" → Enter`，文档位置精确 1.5，历史只 +1。

**B4 · 模式切换按包含关系转换**（S2b）
- 文件：`js/seed-selection.js`（已有 `convertSelection`，只补边界）
- 由 I 路线把 `setSelMode` 的清空改为 `convertSelection(mesh, from, to, sel)`。
- 验收：面选 2 个 → F9 得到 8 个顶点；点选不足一面 → F11 为空；UV 岛与面互转保持面 ID。

**B5 · 快捷键注册表**（Blender keymap 对标）
- 文件：`js/seed-keymap.js`(新)
- 做：`define({key, when, region, run})`、`lookup(e, ctx)`、`list()`；支持同一键在不同 `region`（viewport / outline / commandline）不同义；现有键位逐条迁入，`onKeyLayer` 只查表。
- 验收：探针现有 W/E/R、F8–F12、Ctrl+Z/Y/S/N/O、`` ` `` 全绿；新增「输入框聚焦时让位」与「窗口不在最上层时让位」两条。

### C 路线

**C1 · 七组菜单由命令表渲染**（P1/P4）
- 文件：`js/md-toolbox.js`(新)、`js/seed-commands.js`
- 做：`SeedCommands.list(group)` → 菜单项；`when` 为假 → 灰显（不隐藏）；菜单项只发 `run(id)`，不写业务。
- 验收：七个下拉都能开；每项点击后状态行/文档变化与命令行同一 id 完全一致。

**C2 · 命令行最小解析**（P2）
- 文件：`js/md-toolbox.js`
- 做：`camera front` / `shading wire` / `select object|vertex|edge|face` / `mesh.extrude 0.2`；↑↓ 历史、Tab 补全；错误进状态行常驻。
- 验收：四条命令各有断言；未知命令不抛异常。

**C3 · 大纲层级 / 组 / 多选变换**（B2b/B2c）
- 文件：`js/md-outline.js`(新)
- 做：父子拖拽、组节点、眼睛可见性、隐藏页；多选后 gizmo 同量变换（手柄画在激活节点）。
- 验收：拖拽改父子后 GLB 层级一致；两个对象多选拖动各位移同量、历史只 +1。

**C4 · 属性编辑器材质槽增删改名**（P5）
- 文件：`js/md-props.js`(新)
- 做：新建/重命名/删除槽；指派选中面到槽；槽色即时刷新；贴图 key 不迁移。
- 验收：新建槽后 `m3d-slots` 配置 key 不变；指派面后视口颜色变化；撤销回原槽。

**C5 · 自动保存与保存前校验**（D1/D2）
- 文件：`js/md-persist.js`(新)
- 做：120s 自动保存、保存中不阻塞拖动、失败降级提示；超 1 万面拒绝并给面数/体积预估。
- 验收：探针改文档后等待/直接触发自动保存 → `LAST_KEY` 可续开；11000 面文档保存返回明确拒绝。

### I 路线

**I1 · 外壳拆第一步**（低风险）
- 文件：`js/model-desk.js`、`index.html`
- 做：只迁 `md-viewport` / `md-outline` / `md-props` 三个 leaf，注入 `MdHost`；`index.html` 按依赖顺序插入三个 script。
- 验收：旧 116 条全绿 + `renderer.info` 数字与拆分前逐项一致。

**I2 · 探针分段 + 交付门**
- 文件：`tools/probe-modeldesk.js`、`tools/probe-toolframe.js`
- 做：按 A/B/C 分组打印小节；任一失败 `process.exit(1)`；输出总绿/总红。
- 验收：`node tools/probe-modeldesk.js` 退出码 0；人为破坏一处必须退出码 1。

**I3 · 入库**
- 做：把 22 个建模模块、`docs/`、`tools/` 纳入 git（当前全部 untracked），按模块拆 3–4 个提交，消息写清「新增内核/接入/修复」。
- 验收：`git status` 无 `??` 的建模文件；任一提交可单独回滚。

---

## 5. 验收门（I 路线执行）

1. **契约门**：新增模块必须只用 `MdHost`，代码里出现 `$('md...')` 或 `document.` → 直接打回（shell 除外）。
2. **行为门**：旧 116 条一条不能红；新增断言必须能在旧代码上失败（证明它真的测到了东西）。
3. **历史门**：任何拖动/算子，`pointerup` 后只 +1 条历史；预览期间 `getState().revision` 不变。
4. **体积门**：1 万面硬上限；保存体积超预算要给出面数与预估 MB。
5. **入口门**：同一命令在菜单 / Shelf / 工具箱 / 热盒 / 命令行 / 快捷键六入口结果必须一致（只查 `SeedCommands`）。

---

## 6. 与 Blender 的取舍结论

- **该学**：单一数据真源、算子 poll/when、工具会话、keymap 注册表、UI 由 schema 渲染、按模块回归。
- **已领先**：网格内容指纹撤销（按指纹去重 + 引用回收），比 Blender 的整文件 memfile 更省。
- **暂不做**：完整 depsgraph / 修改器求值、节点编辑器、动画、渲染器、插件系统。
- **一句话**：先把「一张表、一个上下文、一个写入口」落下来，再谈并行；否则六路 AI 只会同时往 `model-desk.js` 里加分支。
