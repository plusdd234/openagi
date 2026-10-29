<div align="center">

# The seed · Open AGI

**开源的 AI 工作流工作台 —— 用可视化节点把「文生图 / 图生图 / 3D 生成 / 网页 AI 接入」串成一条可复用的流水线。**

原生 JS + Electron，无打包器，无构建步骤。克隆下来就能跑。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F.svg)](package.json)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-5FA04E.svg)](package.json)

</div>

---

## 这是什么

一个**桌面工作台**：左边是工作流列表，中间是节点画布，右边是参数面板。
每个节点是一次明确的能力调用（生图、拆分、3D、网页自动化接入……），
用连线把上一个节点的输出接到下一个节点的输入，跑起来就是一条完整的流水线。

不是「ComfyUI 换皮」。两条设计底线：

1. **节点是业务动作，不是算子。** 21 个节点覆盖的是「生成一张图」「把图拆成多视图」「去网页上传参数」这类完整动作，
   同一个「图像生成」节点可以接本地 ComfyUI、在线 API 或网页版 Tripo——**节点与引擎解耦**。
2. **跨引擎，不绑死。** ComfyUI 有 1000+ 算子但绑死单一引擎且用拓扑执行 + 节点缓存语义，
   混进蓝图调度会踩「谁先跑」的经典坑。所以这里**只借算子、不借编排**：
   要用 ControlNet / Inpaint / LoRA，就通过 `comfyWorkflow` 拼几条连线指过去。

## 核心能力

| 能力 | 说明 |
|---|---|
| **21 类节点** | 输入（文本 / 数值 / 布尔 / 图像 / 模型）、生成（生图 / 压缩 / 拆分 / 3D / 多视图）、逻辑（分支 / 智能分支 / 变量）、Tripo 网页接入、起止与结果 |
| **多引擎生图** | 本地 ComfyUI / 在线 API / Tripo 网页版，统一走 `wfImage(prompt, image, opts)` 一个出口 |
| **本地语言模型** | Ollama 接入，含**冷加载预热 + 驻留保活**（首条消息不用干等 4-5 秒，且不会弹出黑窗口） |
| **3D 预览** | 基于 three.js 的 GLB / OBJ 查看器，轨道操控 |
| **确定性网页 AI 接入** | 通过浏览器自动化调用没有开放 API 的第三方 AI 服务：可见文本正则 + 几何邻近锚点 + 原生 setter 写入 + 回读校验 |
| **工作台桌面** | 类 OS 桌面，多 App 统一翻页动效（模型商店 / ComfyUI / 图库 / 模型库 / AI 对话） |
| **对话内生图** | AI 对话可以直接出图，三态触发（自动 / 生图 / 仅对话），「仅对话」防误扣额度 |
| **自建账号网关** | 零依赖 Node 服务：注册/登录/按人头限额，OpenAI 兼容接口转发，scrypt 加盐 + HMAC 签名令牌 |
| **交流社区** | SSE 长连接的大厅式聊天，零依赖，自动重连 |
| **资产库 / 模型库** | 本地资产与模型清单管理 |

## 快速开始

### 桌面版（推荐）

```bash
git clone https://github.com/plusdd234/openagi.git
cd openagi
npm install          # 首次会下载 electron（约 100 MB）
npm start
```

Windows 上也可以直接双击 `start.bat`（它会自动装依赖再启动）。

### 浏览器模式

```bash
npm install
node plugins/relay/relay.js   # 本地中转服务
```

然后打开 `index.html`。注意：**浏览器模式下 `file://` 页面直连本机引擎会被 CORS 拦**，
本地对话与中文提示词翻译需要走中转服务。

### 自建网关 / 社区服务

```bash
node server/gateway.js --port=8791   # 账号网关（需要配置上游 Key）
node server/chat.js                   # 交流社区
```

`deploy/` 里有现成的 systemd unit 与 Caddyfile 示例。

## 配置

复制 `openagi-store.example.json` 为 `openagi-store.json`，填入自己的值：

```json
{
  "hf_llmBaseUrl": "https://your-api/v1",
  "hf_llmModel": "your-model",
  "hf_imgBaseUrl": "https://your-api",
  "hf_imgEndpoint": "/images/edits"
}
```

**真实配置文件 `openagi-store.json` 已在 `.gitignore` 中排除（含明文 API Key），不要提交。**

本地引擎（Ollama / ComfyUI）可在设置页开启「开机自动启动」与「预热当前模型」。

## 架构

```
index.html            静态入口（无打包器，浏览器可直开）
css/01-base … 12-media 样式按 App 切成 12 份，<link> 顺序即层叠顺序，不可调换
  （另有 multiview.css 给独立工具页共用、settings.css 给设置面板）
js/
  node-defs.js        ★ 节点注册表：新增节点只改这一个文件
  node-registry.js      引脚类型解析的唯一来源
  blueprint-core.js     画布数据模型
  blueprint-runtime.js  执行引擎
  editor.js             视图手势
  desktop.js            桌面与 App 外壳
  desk-chat.js          AI 对话
  desk-image.js         生图纯逻辑（意图 / 改写 / 来源分支）
  provider.js           多引擎生图
electron/
  main.js               主进程：窗口 / 服务编排 / 引擎自启
  engine-autostart.js   引擎自动启动（纯逻辑，可 node 直测）
  engine-keepalive.js   模型驻留保活器
plugins/
  relay/                CORS 中转
  runtime/              本地引擎桥（8794）
  tripo/                Tripo 网页自动化桥
server/
  gateway.js            账号网关
  chat.js               交流社区
tools/                  测试与探针（playwright-core）
```

### 三条架构铁律

1. **一个节点只写一处。** 新增节点只在 `js/node-defs.js` 追加 `registerNode({...})`，
   不允许往 desktop / runtime / validate / flow-gen 里加 `if(n.type === ...)` 分支。
2. **引脚解析只有一份。** 全部走 `node-registry.js` 的 `pinTypeOf` 系列，编辑器只是薄封装。
3. **默认值唯一来源。** `seedNodeData` 是默认值的唯一出处；取值优先级：连线 → 就地值 → `paramFallback`。

## 测试

```bash
node tools/desk-chat.js          # 对话 + App 化
node tools/desk.js               # 桌面翻页
node tools/engine-autostart.js   # 引擎自动启动（纯 node）
node tools/engine-keepalive.js   # 驻留保活器（纯 node）
node tools/runtime-bridge.js     # 本地引擎桥
```

浏览器侧测试用 `playwright-core` 驱动 Edge（`channel:'msedge'`），
加载 `file://index.html?nostore=1`（`?nostore=1` 只禁写不禁读）。

跑需要真实 Ollama / ComfyUI 的测试前，先卸载模型清场（`keep_alive:0`），
并杀干净残留的 electron 进程（**单实例锁**会让新实例静默退出）。

## 已知限制

- **Tripo 网页桥**用 `playwright-core` 驱动真实 Edge，违反 Tripo 服务条款有封号风险，仅供自用研究。
- **本地生图**受 CLIP 语言能力的限制：CLIP 只懂英文，中文提示词需要先经语言模型翻译（降级链见 `js/provider.js`）。
  尺寸也不能超模型能力（SD1.5 喂 1024 会出拼贴画），由 `comfyModelCap()` 按模型家族给上限。
- **内容包热更新**要求 Ed25519 验签，自检失败不动指针。

## 许可

MIT，见 [LICENSE](LICENSE)。

第三方依赖的来源与许可见 [vendor/README.md](vendor/README.md)。

## 致谢

- [three.js](https://threejs.org/) r149（MIT）—— 3D 预览
- [Ollama](https://ollama.com/) —— 本地语言模型
- [ComfyUI](https://www.comfy.org/) —— 本地生图引擎
- [Playwright](https://playwright.dev/)（Apache-2.0）—— 网页自动化
