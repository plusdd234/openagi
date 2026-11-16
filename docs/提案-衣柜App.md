# 衣柜 App —— 数字人皮套换装方案

状态：已生效
日期：2026-11-15
适用范围：`apps/wardrobe/`（衣柜 App）、`apps/live2d/`（数字人读取搭配的契约）、`tools/probe-wardrobe.js`

## 1. 目标

给数字人一个「衣柜」：选皮套、逐件隐藏 / 显示部件、把搭配存成套装，并存下当前搭配让数字人直接穿。

硬约束：

- 皮套仍是标准 Cubism 3/4 模型，目录 `apps/live2d/model/<id>/`，不引入私有格式；
- 换装不复制、不重打包 moc3，只操作运行时部件透明度；
- 预览运行时独立成模块，后续别的 App 也能复用；
- `file://` 断网可跑，不依赖服务器与外部模型。

## 2. 模块划分

| 文件 | 职责 | 扩展方式 |
|---|---|---|
| `apps/wardrobe/rig.js` | `window.WD_RIG`：注入 pixi / Cubism 运行时、按需加载 `pack.js`、挂载模型、部件隐藏、自适应尺寸 | 在返回对象上加方法；别的 App 直接 `WD_RIG.create(host)` |
| `apps/wardrobe/body.js` | `window.WD_BODY`：三栏窗口 DOM | 加面板 / 按钮即可，无逻辑 |
| `apps/wardrobe/app.js` | 界面与状态：皮套清单、部件分组、套装、`hf_wardrobe_state`、探针钩子 | `PART_CATS` 加一条正则就多一个部件分组 |
| `apps/wardrobe/app.css` | `.os-win.wardrobe` / `.wd-*` 作用域样式，窄窗容器查询 | 只加 `.wd-*` 选择器 |

复用而不复制：皮套目录、`model/models.js`、`model/<id>/pack.js` 与 `vendor/` 全部来自数字人 App。衣柜不另存一份模型，避免 2MB moc3 与纹理重复入库。

## 3. 换装原理

Cubism 运行时每个部件都有 opacity。衣柜把要隐藏的部件透明度压到 0：

1. 读 `model3.json` 的 `DisplayInfo`（`cdi3`）拿部件 id 与中文名，再用 `coreModel.getModel().parts.ids` 补齐；
2. 隐藏时先记下该部件当时的透明度（`stash`），再置 0；取消隐藏还回原值，不把 pose 管理的部件强行改成 1；
3. 每帧在 `beforeModelUpdate` 里重压一次，动作 / pose 把它拉起来也盖得住；
4. 皮套本身不重建，换部件是纯运行时操作。

已知边界：运行时没有「父子部件」信息（`ParentPartIndex` 只在编辑工程里），所以部件清单是平铺的，按中文名关键词分组（头发 / 面部 / 手 / 服装 / 道具 / 特效 / 其他）。同一件美术资源如果被画在别的部件里，隐藏该部件不会连带隐藏它 —— 这是皮套作者的拆分方式决定的。

## 4. 数据契约

`localStorage.hf_wardrobe_state`（v1）：

```json
{
  "v": 1,
  "modelId": "c_0120",
  "activeId": "o...",
  "outfits": [
    { "id": "o...", "name": "校服", "modelId": "c_0120", "hidden": ["Part92"], "ts": 0 }
  ],
  "draft": { "modelId": "c_0120", "hidden": ["Part92"] }
}
```

- `draft` 是「当前搭配」，数字人启动时按它穿衣；
- `activeId` 只用于高亮最近穿上的套装；手改部件后会清空；
- 数字人侧读取：`readWardrobeWear()` → `S.modelId` + `S.hiddenParts`；`beforeModelUpdate` 里压透明度；
- 同页联动：衣柜「应用到数字人」调 `window.__l2dApplyOutfit({ name, modelId, hidden })`，数字人开着就即时生效，没开就等下次启动读 `draft`。

## 5. 功能清单

1. 皮套下拉：读 `models.js`，切换即销毁旧舞台、装载新皮套；
2. 预览：呼吸 / 眨眼 / 物理 / idle 动作由 moc3 自带，按舞台尺寸自适应；
3. 部件：搜索、勾选隐藏、行内「只」单独显示、全部显示 / 重置；
4. 套装：保存当前、试穿、穿上（同步数字人）、删除；
5. 窄窗：容器宽度 ≤ 760px 时改成「舞台 / 部件 / 套装」上下排布，左栏套装横滑；
6. 探针钩子：`__wdRig()`、`__wdPartOpacity(id)`、`__wdState()`。

## 6. 验收

- `node tools/test-headless.js wardrobe`：PASS；探针 23 项，覆盖窗口打开、皮套渲染、100 件部件、隐藏后透明度为 0 且落盘、套装保存 / 试穿恢复、数字人读取搭配、同页即时应用、窄窗无横向溢出、零脚本错误。
- `node tools/test-headless.js live2d`：PASS；多皮套逻辑不变，新增 `hidden` 诊断字段。
- 静态守卫：`app-scan --check`、`ns-guard`、`conf-guard`、`css-links`、`app-registry` 全绿。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 两个 App 同时开着，模型加载器中间件互相串包 | 两个 App 的中间件都按 `settings.__xxxPack` 归属认领，不再用全局「当前包」 |
| 隐藏部件被动作 / pose 拉回可见 | 每帧 `beforeModelUpdate` 重压，并在取消隐藏时还原原透明度 |
| 无头环境没有本地模型网关，控制台出现连接失败 | 探针只忽略 `ERR_CONNECTION_REFUSED`；资源缺失仍是 `ERR_FILE_NOT_FOUND`，不会被吞 |
| 多 AI 并行时 `apps/manifest.js` 反复变红 | 按规范只在集成阶段串行生成；探针可用 `--skip-static` 单独验证 |

## 8. 变更记录

- 2026-11-15：衣柜 App 建立。`apps/wardrobe/`（app.js / body.js / app.css / rig.js）、`tools/probe-wardrobe.js` 新增；数字人接入 `hf_wardrobe_state.draft` 与 `__l2dApplyOutfit`，`__l2dRig()` 增加 `hidden`；数字人加载器中间件从「全局当前包」改为按 settings 归属认领。
