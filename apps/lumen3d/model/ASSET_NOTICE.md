# 流明 3D 数字人 · 资源声明

本目录的 `face-meta.js`、`face-geometry.js`、`face-curves.js` 由 `tools/pack-lumen3d.js`
从 [AaBb-coder/LumenAct](https://github.com/AaBb-coder/LumenAct) 的公开资源打包而来，
仅做了格式转换（base64 内联、曲线 float32 → uint8 量化），没有修改几何、形态键名称或表演数据。

## 授权

| 内容 | 来源 | 授权 |
|---|---|---|
| 参考脸几何与贴图 `lumen-reference-face` | LumenAct / ぷらすわん | CC BY-NC 4.0，**仅限非商用** |
| 表演曲线（97 段） | LumenAct（B站 Lumen_流明_） | CC BY 4.0，使用时需署名 |
| 通道表、曲线目录 | LumenAct | 随上游资源声明 |
| 本仓库的 App 代码 | 本仓库 | 沿用本仓库授权 |

参考脸基础网格作者为 **ぷらすわん**，项目方已取得商业使用许可；该许可不随这份开源资源转让，
因此本 App 只能作为非商用演示。需要商用时应替换为自有、带同名形态键的角色。

## 未随包使用的部分

LumenAct 的语义模型 `selector.onnx`（约 146 MB）及分词器没有打包。本 App 直接使用语言模型
输出的中文标签在 `catalog.styles` 中查表选段，不依赖 Python、ONNX Runtime 或本地 HTTP 服务。
