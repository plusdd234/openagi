# 衣柜 App —— 数字人皮套换装方案

状态：已生效
日期：2026-11-17（v2 重做；v1 为 2026-11-15）
适用范围：`apps/wardrobe/`（衣柜 App）、`apps/live2d/`（数字人读取搭配的契约）、`tools/probe-wardrobe.js`

## 1. 目标

给数字人一个**只做真实切换**的衣柜：只提供模型作者实际预留、且运行时真的存在的配饰、道具、配色与手部开关，把搭配存成套装，并让数字人直接穿上。

v1 只做「任意部件透明度隐藏」——那只是把画藏起来，并不等于换衣服。v2 的底线：

- **参数 / 部件必须真实存在**：只写 cdi3 / exp3 里作者声明过的开关；
- **不假装换整件服装**：如果 runtime 里没有第二套服装部件，就不做「制服」槽位；
- 没有预留开关的皮套，不放进衣柜下拉；
- 高级区仍允许手动隐藏任意部件，但那是调试/微调，不冒充「服装」。

硬约束：

- 皮套仍是标准 Cubism 3/4 模型，目录 `apps/live2d/model/<id>/`，不引入私有格式；
- 不复制、不重打包 moc3，换装只操作运行时部件透明度与参数；
- 预览运行时独立成模块，别的 App 也能复用；
- `file://` 断网可跑，不依赖服务器与外部模型；
- 素材只用有明确授权的：鲸鱼娘（CC BY-NC-SA 4.0）。

## 2. 模块划分

| 文件 | 职责 | 扩展方式 |
|---|---|---|
| `apps/wardrobe/presets.js` | `window.WD_PRESETS`：每个皮套的槽位、选项、参数、整组部件 | 加一个模型 = 加一组 `{ defaultHidden, slots[] }` |
| `apps/wardrobe/rig.js` | `window.WD_RIG`：注入 pixi / Cubism、按需加载 `pack.js`、部件隐藏 / 强制显示、参数写回、自适应尺寸 | 在返回对象上加方法；别的 App 直接 `WD_RIG.create(host)` |
| `apps/wardrobe/body.js` | `window.WD_BODY`：三栏窗口 DOM | 加面板 / 按钮即可，无逻辑 |
| `apps/wardrobe/app.js` | 界面与状态：皮套清单、槽位、套装、`hf_wardrobe_state` v2、探针钩子 | 槽位逻辑全在 `compose()` |
| `apps/wardrobe/app.css` | `.os-win.wardrobe` / `.wd-*` 作用域样式，窄窗容器查询 | 只加 `.wd-*` 选择器 |

复用而不复制：皮套目录、`model/models.js`、`model/<id>/pack.js` 与 `vendor/` 全部来自数字人 App。

### 参考的开源实现

| 项目 | 借鉴点 | 链接 |
|---|---|---|
| **A8Chann/dsh-pet-live2d**（同一只鲸鱼娘） | 20 个互斥槽位、装扮跨会话保留；槽位按 cdi3 作者分组划分，不猜参数 | <https://github.com/A8Chann/dsh-pet-live2d> |
| **jadas2321/yachiyo-ai-companion** | 三层换装（配色 / 部件 / 叠加）；两条实机踩坑：Cubism 5 的 `getPartId(i)` 返回对象、exp3 用 Add 会跨表情残留 | <https://github.com/jadas2321/yachiyo-ai-companion> |

没有找到「通用 Live2D 换装引擎」这类项目：社区做法基本一致——**在作者的拆分/参数上做互斥槽位**，而不是运行时改网格或贴图。本 App 走的就是这条路。

## 3. 换装原理

### 3.1 两条通道

1. **部件透明度**
   - 隐藏：先记下该部件当时的透明度（`stash`），再置 0；
   - 显示：置 1。给「默认 opacity 为 0」的备用部件留的通道；
   - 每帧在 `beforeModelUpdate` 重写一次，动作 / pose 拉起来也盖得住。
2. **参数开关**
   - 只收录模型自带（cdi3 / exp3）里实际存在的开关；
   - 每帧写**绝对値**，不叠 Add，避免表情那种跨帧残留；
   - 切换时把离开的旧参数写回 0，避免「取消马尾后头发还扎着」。

### 3.2 槽位与组合

`WD_PRESETS[modelId].slots` 每组互斥，`items[0]` 是默认项：

```js
{ id: 'glasses', label: '眼镜', items: [
  { id: 'none', name: '不戴' },
  { id: 'square', name: '方眼镜', params: { ParamCheek72: 1 } }
] }
```

- `params`：写进 Cubism 的参数；
- `hide` / `show`：要压 0 / 拉满的整组部件；
- `compose()` 把 `look` 展开成最终 `hidden` / `shown` / `params`，再交给 rig；
- 高级部件里手勾的微调记在 `extra`（强制隐藏）与 `showManual`（强制显示），叠在槽位之上。

### 3.3 鲸鱼娘（c_0120）的槽位来源

取自模型作者的 cdi3 参数组和随包 exp3，和 dsh-pet-live2d 的槽位表一致：

| 槽位 | 参数 |
|---|---|
| 桌布（白 / 黑） | `cc2` |
| 发饰（发箍 / 摘掉 / 单边马尾） | `ParamCheek38=3` / `fx1=1` |
| 眼镜（圆 / 方 / 椭圆 / 墨镜） | `ParamCheek70/72/10/71` |
| 贴纸（猫 / 兔 / 蝴蝶结） | `ParamCheek83/82/81` |
| 魔爪（粉 / 白） | `mozhua=1` / `+mozhua2=1` |
| 鲸鱼（头顶 / 桌上） | `jingyu=1` / `fangzhuoshang=1` |
| 桌面摆设（巴菲） | `baleite=1` |
| 手机换色 | `shouji=1` |
| 右手（猫爪 / 比耶） | `maoshou=1` / `phone7=1` |
| 左手（撤回 / 画笔 / 橡皮 / 蛋包饭） | `chehui` / `bi` / `pi` / `point=-1 + danbaofan` |

鲸鱼娘没有「换整件衣服」的拆分，所以不设服装槽位——界面如实写「配饰 / 桌面换装」，不冒充服装。

### 3.4 为什么没有 Haru 的「制服」

官方 Haru 示例的 `haru.cdi3.json` 里写了 002 组（`PARTS_01_BODY_002`、`PARTS_01_ARM_*_002`，名字是「２ 制服」），但**免费 runtime 的 `haru.moc3` 没有导出这些部件**：

- `haru.moc3`（231,936 B）字符串扫描只剩 `PARTS_01_*_001`，没有 `_002`；
- 运行时部件表只有 19 个部件（001 组 + 脸 / 头发 / ROUGH），没有 002；
- `setPartOpacityById('PARTS_01_BODY_002', 0)` 会写进 Cubism 的「不存在部件」回退表，`getPartOpacityById` 仍返回 1 —— 之前的探针就是在这里假通过的；
- 实际把 001 压 0 后，人物只剩一个头，因为 002 根本画不出来。

同样，鲸鱼娘里看起来像「第二套衣服」的 `Part163 蓝紫`、`Part166 黑色`、`Part140 衣服`、`Part134/135` 都是**没有 drawable 的空部件组**，不是可切换的服装层。

结论：**不保留假换装**。Haru 不写进 `presets.js`，也不出现在衣柜下拉里；它仍可以作为数字人的第二套皮套使用（`apps/live2d/model/models.js` 保留），只是衣柜没有它的槽位。将来拿到真的带多套服装 runtime 的免费模型，只要在 `presets.js` 里补 `hide` / `show` 两组部件即可，机制已经预留。

## 4. 数据契约

`localStorage.hf_wardrobe_state`（v2，读到 v1 自动迁移）：

```json
{
  "v": 2,
  "modelId": "c_0120",
  "activeId": "o...",
  "outfits": [
    {
      "id": "o...", "name": "眼镜马尾", "modelId": "c_0120",
      "look": { "glasses": "square", "hair": "tail" },
      "extra": [], "showManual": [],
      "hidden": [], "shown": [],
      "params": { "ParamCheek72": 1, "fx1": 1 },
      "ts": 0
    }
  ],
  "draft": {
    "modelId": "c_0120",
    "look": { "glasses": "square", "hair": "tail" },
    "extra": [], "showManual": [],
    "hidden": [], "shown": [],
    "params": { "ParamCheek72": 1, "fx1": 1 }
  }
}
```

- `look` 是槽位选择，`hidden` / `shown` / `params` 是展开结果（数字人直接照着执行）；
- `draft` 是「当前搭配」，数字人启动时按它穿衣；
- `activeId` 只用于高亮最近穿上的套装；手改槽位或部件后清空；
- 数字人侧：`readWardrobeWear()` → `S.modelId` + `S.hiddenParts` + `S.shownParts` + `S.outfitParams`，在 `beforeModelUpdate` 每帧写回；
- 同页联动：衣柜「应用到数字人」调 `window.__l2dApplyOutfit({ name, modelId, hidden, shown, params })`。

## 5. 功能清单

1. 皮套下拉：只列出 `presets.js` 里有槽位的皮套，没有预留开关的不出现；
2. 衣橱槽位：每个皮套按 `presets.js` 渲染互斥选项，点一下立即上身；
3. 高级部件：搜索、勾选、行内「只」隔离显示（放在折叠区，普通用户不用碰）；
4. 套装：保存当前（含 look / 参数 / 微调）、试穿、穿上（同步数字人）、删除；
5. 皮套切换时保留默认搭配；窄窗改成「舞台 / 衣橱 / 套装」上下排布；
6. 探针钩子：`__wdRig()`（含 look / hidden / shown / params）、`__wdPartOpacity(id)`、`__wdParam(id)`、`__wdState()`。

## 6. 验收

- `node tools/test-headless.js wardrobe`：PASS。探针覆盖：窗口打开、皮套渲染、鲸鱼娘眼镜 / 马尾参数真的写进 Cubism 且落盘 v2、套装保存 / 恢复默认 / 试穿、数字人启动读到 params、手动隐藏部件透明度真的归零再恢复、无槽位皮套不出现在下拉、窄窗无横向溢出、零脚本错误。
- `node tools/test-headless.js live2d`：PASS；保留 `shown` / `params` 诊断字段。
- 静态守卫：`app-scan --check`、`ns-guard`、`conf-guard`、`css-links` 全绿。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 另一套服装默认 opacity 为 0，只隐藏不会显示 | 槽位同时支持 `hide` 与 `show`，每帧分别写 0 / 1 |
| 取消选择后参数残留 | `setParams` 对离开的参数写回 0（这些开关默认值都是 0） |
| 部件在 moc3 里不存在，`getPartOpacityById` 却返回回退值 | 槽位只收作者参数；探针断言先确认部件在 `__wdRig().parts` 里 |
| 两个 App 同时开着，模型加载器中间件互相串包 | 两个 App 的中间件都按 `settings.__xxxPack` 归属认领 |
| 隐藏部件被动作 / pose 拉回可见 | 每帧 `beforeModelUpdate` 重压，且事件在 pose 之后 |
| 换皮套后旧部件 / 参数 id 失效 | 换皮套就清空 look / 微调；数字人手动换皮套也清空 hidden / shown / params |
| 无头环境没有本地模型网关，控制台出现连接失败 | 探针只忽略 `ERR_CONNECTION_REFUSED`；资源缺失仍是 `ERR_FILE_NOT_FOUND` |
| `apps/manifest.js` 内联 App 源码，改完不重生成就不生效 | 改完 App 必须跑 `node tools/app-scan.js`；提交前再跑 `--check` |

## 8. 变更记录

- 2026-11-15：v1 建立。`apps/wardrobe/`（app.js / body.js / app.css / rig.js）、`tools/probe-wardrobe.js`；数字人接入 `hf_wardrobe_state.draft` 与 `__l2dApplyOutfit`。
- 2026-11-17：v2 重做为真实换装。新增 `presets.js`（槽位表）、`rig.setParams/setShown`、存档 v2（look / params / shown / showManual）；鲸鱼娘槽位按作者参数重做；数字人每帧写 params 与 shown；探针改为验证参数与真实部件透明度。
- 2026-11-17：核实官方 Haru 的免费 runtime 不含 002 制服部件（cdi3 有、moc3 没有），移除 Haru 的假「制服」槽位；衣柜下拉只列出有真实槽位的皮套；探针增加「无槽位皮套不展示」与「手动隐藏部件透明度真实归零」两项。
