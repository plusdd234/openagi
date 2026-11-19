# 智搜 · AI 临时辅助脚本

- 状态：已生效
- 日期：2026-11-18
- 适用范围：`apps/aisearch/`（智搜 App），不涉及共享层

## 一、做了什么（已实现）

智搜在「检索完成、进入筛读与作答之前」，让语言模型临时写一段 JavaScript，由这段脚本自己决定候选页怎么补、怎么排、怎么删。

模型输出 `{"name":"…","code":"…"}`；`code` 是一个函数体，参数 `data` 形如：

```js
{
  question: "用户原问题",
  primary: "去噪后的主检索式",
  results: [{ i, title, url, site, snippet }]   // 当前候选，最多 24 条
}
```

`code` 同步 `return`：

```js
{
  queries: ["补充检索式"],      // 最多 3 条
  drop: ["要淘汰的 url"],       // 必须是 data.results 里真实存在的 url
  score: { "url": 分值 }        // -5 ~ 5，累加进最终排序
}
```

实现位置：

- 生成、解析、沙箱执行：[app.js](file:///c:/Users/30297/Desktop/AI%E6%8B%9F%E5%86%99%E6%8F%90%E7%A4%BA%E8%AF%8D/apps/aisearch/app.js#L2119-L2345)
- 接入主链路：[app.js](file:///c:/Users/30297/Desktop/AI%E6%8B%9F%E5%86%99%E6%8F%90%E7%A4%BA%E8%AF%8D/apps/aisearch/app.js#L2654-L2656)
- 排序加权：[app.js](file:///c:/Users/30297/Desktop/AI%E6%8B%9F%E5%86%99%E6%8F%90%E7%A4%BA%E8%AF%8D/apps/aisearch/app.js#L1647)
- 开关 UI：[body.js](file:///c:/Users/30297/Desktop/AI%E6%8B%9F%E5%86%99%E6%8F%90%E7%A4%BA%E8%AF%8D/apps/aisearch/body.js)、[app.css](file:///c:/Users/30297/Desktop/AI%E6%8B%9F%E5%86%99%E6%8F%90%E7%A4%BA%E8%AF%8D/apps/aisearch/app.css)

开关默认**开启**，状态存 `localStorage.hf_aisearch_assist`（`'0'` 表示关闭）；只在网页模式（`S.mode === 'web'`）生效。

## 二、安全边界

模型代码不在本页执行，而是丢进 `sandbox="allow-scripts"` 的 `srcdoc` iframe：

- 没有 `allow-same-origin` → 不透明源，读不到父页 `localStorage`、`window.openagiDesktop` 与任何 DOM；
- 内嵌 `Content-Security-Policy: default-src 'none'` → 没有网络请求、没有外部资源；
- 只喂候选页的纯数据；2 秒超时，超时或异常直接拆掉 iframe，原样返回主流程结果；
- 模型返回值仍做结构校验：检索式长度 ≤60、`drop` / `score` 的 URL 必须真实存在于候选池、分值夹在 -5~5；
- 静态拦截 `while(true)` / `for(;;)` 这类死循环写法；
- 模型不可用、输出非法、用户中止时，不产生额外请求、不改排序；
- 模型调用统一走 `LLMRouter.complete`，不自己拼接 Key、重试与超时。

## 三、对照实验

工具：[bench-aisearch-assist.js](file:///c:/Users/30297/Desktop/AI%E6%8B%9F%E5%86%99%E6%8F%90%E7%A4%BA%E8%AF%8D/tools/bench-aisearch-assist.js)

做法：同一套语料、同一套页面桩，A 组关闭辅助脚本、B 组开启；除「写脚本」外，筛选器固定走启发式、回答器只根据喂入的资料作答，因此差异只可能来自辅助脚本。4 道题，每题埋一篇「深页」，只有深页含关键事实。

指标：金标页进结果 / 金标页精读（各满分 8）、深页进结果 / 深页精读（各满分 4）、事实命中（满分 4）。

### 强模型（运行中应用的当前配置：`deepseek-v4.1-flash-1017`）

| 指标 | 基线 A | 辅助脚本 B |
|---|---|---|
| 金标命中（/8） | 6 | 9 |
| 金标精读（/8） | 5 | 8 |
| 深页进结果（/4） | 0 | 3 |
| 深页精读（/4） | 0 | 3 |
| 事实命中（/4） | 0 | 2 |
| 脚本生效题数 | — | 4/4 |

### 小模型（本地 `qwen2.5:3b`）

| 指标 | 基线 A | 辅助脚本 B |
|---|---|---|
| 金标命中（/8） | 6 | 6 |
| 金标精读（/8） | 5 | 5 |
| 深页进结果（/4） | 0 | 0 |
| 深页精读（/4） | 0 | 0 |
| 事实命中（/4） | 0 | 0 |
| 脚本生效题数 | — | 4/4 |

结论：强模型上正收益明确（深页 0→3、事实 0→2），无回退；3B 能写出可执行脚本，但检索式质量不足，没有收益，只多花 2–5 秒。产物在 `.workbuddy/runs/*-bench-aisearch-assist/bench.json`。

## 四、已知局限

- 小模型能力不足：脚本能跑，但补充检索式往往只是复述原句，收益接近零。
- 仍是单轮：脚本只写一次、补充检索式最多问 2 条；第一轮没带出新候选时不会迭代。
- 语料一致性：`Python 3.13` 一题模型给出的 `free-threading` 在实验语料里对应的是 `free-threaded`，桩按子串匹配没有命中深页；这是桩的匹配口径，不是脚本执行失败。
- 沙箱只挡同源与网络，不限制 CPU 时间片；极端的计算密集代码仍可能拖慢该次搜索（有 2 秒超时与死循环静态拦截兜底）。

## 五、验收与回退

验收：

```bash
node tools/test-headless.js aisearch     # 含 probe/aisearch 的辅助脚本断言
node tools/app-scan.js --check
node tools/ns-guard.js
node tools/conf-guard.js
node tools/css-links.js
```

实验复现（需要联网与系统代理）：

```powershell
$env:NODE_USE_ENV_PROXY="1"; $env:HTTPS_PROXY="http://127.0.0.1:18081"
$env:BENCH_LLM="live"; node tools/bench-aisearch-assist.js   # 读运行中桌面应用的当前模型配置
$env:BENCH_LLM="remote"; node tools/bench-aisearch-assist.js # 读仓库 openagi-store.json
node tools/bench-aisearch-assist.js                          # 本地 Ollama（默认 qwen2.5:3b）
```

回退：点掉输入区右侧「辅助脚本」按钮即可关闭并持久化；需要彻底移除时，删除 `aiAssistScript` 的单点调用（`app.js` 主流程末尾）即可，其余函数不参与主链路。
