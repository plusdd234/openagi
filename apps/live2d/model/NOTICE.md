# NOTICE —— 许可分层与署名 / License layering & attribution

`LICENSE`（MIT）**只覆盖本项目的代码**。仓库里还带着美术素材和第三方运行时，它们各自另有条款 ——
这就是这份 NOTICE 存在的原因（放在这里而不是塞进 `LICENSE`，是为了让 GitHub 能正确识别出 MIT）。

`LICENSE` (MIT) **covers the code of this project only**. The repository also ships artwork and third-party
runtimes under their own terms — hence this NOTICE (kept separate from `LICENSE` so that GitHub detects the
MIT license correctly).

---

## 1. 代码 / Code

- **范围 / Scope**：`lib/`、`tools/`、`cordis.patch.yml`、`assets/pet.js`
- **许可 / License**：**MIT**，Copyright © 2026 **Andersen216**（全文见 [`LICENSE`](LICENSE)）

## 2. 美术素材 / Artwork

- **范围 / Scope**：`assets/model/**` —— `*.moc3`、贴图、`*.exp3.json`（表情）、`*.motion3.json`（动作）、
  `model3.json` 等模型相关文件
- **许可 / License**：**[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh)**
  （署名 — **非商业性使用** — 相同方式共享）/ (Attribution — **NonCommercial** — ShareAlike)
- **版权 / Copyright**：**上善无形 / ZipZipPipe / 氵六青** 三位所有，逐项贡献见 [`AUTHORS.md`](AUTHORS.md)，
  逐文件来源与原《使用须知》原文见 [`PROVENANCE.md`](PROVENANCE.md)

## 2.5 Haru 示例模型 / Haru sample model

- **范围 / Scope**：`apps/live2d/model/haru/**`（`haru.moc3`、`haru.1024/texture_*.png`、
  `motion/*.motion3.json`、`haru.physics3.json`、`haru.pose3.json`、`haru.cdi3.json`）
- **来源 / Source**：Live2D 官方免费示例数据 <https://www.live2d.com/download/sample-data/>（`haru_ja.zip`）
- **版权 / Copyright**：插画 / 建模 **Live2D Inc.**
- **许可 / License**：Live2D 免费提供素材许可（Live2D 原创角色类型）：一般用户与小规模事业者
  同意规约后可商用，中大规模事业者仅限非公开测试用途。本项目按**非商业**范围使用并署名。
  语音（癒月）未使用，wav 已删除。

## 3. 第三方运行时 / Third-party runtime

| 组件 / Component | 许可 / License | 版权 / Copyright |
| --- | --- | --- |
| Live2D Cubism Core（`assets/vendor/live2dcubismcore.min.js`） | Live2D 专有许可 / Live2D Proprietary License | Live2D Inc. |
| PIXI.js 6.5.10（`assets/vendor/pixi.min.js`） | MIT | PIXI.js contributors |
| pixi-live2d-display 0.4.0（`assets/vendor/cubism4.min.js`） | MIT | pixi-live2d-display contributors |

## 4. 本项目整体是非商业的 / This project is non-commercial

完全免费：**不收费、不带货、不接广告变现、不卖周边、不作为任何付费产品或服务的卖点**。
模型作者的无偿分享与转载授权，**不解除**角色形象本身的 NC / SA 条件。

Entirely free: **no fees, no ads, no merchandise, no sponsorships, and not a selling point of any paid
product or service**. The model authors' kind permission to share and redistribute does **not** waive the
NC / SA conditions attached to the character artwork itself.

---

有任何权利主张 / For any rights claim: 见 [`PROVENANCE.md`](PROVENANCE.md) 末尾的联系方式
（或直接开一个 [Issue](https://github.com/Andersen216/dsh-whale-girl-live2d/issues)）。
