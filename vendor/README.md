# 第三方依赖说明

本目录存放运行时必需的第三方库文件（不通过 npm 安装，直接以 `<script>` 引入）。

| 文件 | 来源 | 版本 | 许可 |
|---|---|---|---|
| `three.min.js` | three.js | r149 | MIT |
| `GLTFLoader.js` | three.js examples | r149 | MIT |
| `OBJLoader.js` | three.js examples | r149 | MIT |
| `FBXLoader.js` | three.js examples | r149 | MIT |
| `NURBSCurve.js` / `NURBSUtils.js` | three.js examples | r149 | MIT |
| `fflate.js` | fflate（二进制 FBX 的 zlib 解压） | 0.8.2 | MIT |
| `OrbitControls.js` | three.js examples | r149 | MIT |

后三个 three.js examples 文件由官方 `examples/jsm` 版转成挂到全局 `THREE` 的 UMD 脚本
（去掉 `import/export`，只在本项目这种无打包器环境使用），算法与上游保持一致。

three.js 采用 MIT 许可，版权归 three.js authors 所有。
MIT 许可要求保留版权声明与许可文本 —— 这些声明保留在上述文件的头部注释中。

## 为什么不用 npm 装 three

桌面版用 `app://` 自定义协议加载静态页面，渲染进程不引入打包器，
`import` 裸模块无法直接跑。把 UMD 构建产物放这里是最省事的做法。
