# RAW 文件查看助手

一个完全在浏览器本地的相机 RAW 照片查看助手。打开、解码、渲染、调整、导出,全程不离开浏览器,数据不会上传到任何服务器。

底层由 [LibRaw-Wasm](https://github.com/ybouane/LibRaw-Wasm) (v1.6.0, Apache-2.0) 提供解码能力 —— LibRaw 通过 Emscripten 编译为 WebAssembly,在 Web Worker 中并行运行,不阻塞界面。

## 快速开始

开发模式(Vite + React + TypeScript + shadcn/ui):

```bash
npm install
npm run dev
```

然后浏览器打开终端提示的地址(默认 http://localhost:5173)。

生产构建:

```bash
npm run build
npm run preview
```

也可以把 `dist/` 目录交给任意静态服务器。仓库已配置 GitHub Actions,推送到 `main` 会自动构建并部署到 GitHub Pages。

## 使用方式

1. 点击工具栏 **「打开 RAW…」** 选择文件(支持多选),或直接把 RAW 文件拖进窗口;
2. 照片在本地解码并渲染(首次解码约 0.3–1s,取决于文件大小与质量档位)。界面为三列布局:左侧列出已导入照片(点击缩略图即切换,无需新开标签页,悬停可移除单张),中间显示当前大图,右侧为信息/调整面板;
3. 查看/编辑完成后,用 **「⬇ 导出」** 下拉菜单:导出当前照片为 JPEG,或把所有已导入照片按当前调整参数统一导出为一个 **ZIP 压缩包**。

## 功能

**打开与解码**
- 支持的格式:CR2 / CR3 / NEF / ARW / RAF / RW2 / ORF / PEF / DNG 以及 LibRaw 支持的其他常见 RAW(dcraw 格式清单)
- 批量导入:一次可多选/拖入多张 RAW;左侧缩略图列点击即可切换当前照片,悬停可移除单张,「＋ 追加照片」可在当前列表继续添加文件;导入过程显示「正在解析照片 X/N」进度
- 三档解码质量,可随时切换,切换即重新解码:
  | 档位 | 说明 |
  |---|---|
  | 标准 | 全尺寸输出,适合大多数浏览场景 |
  | 高质量 | 全尺寸 + 高质量插值,画质最佳、耗时更长 |
  | 快速 | 半尺寸输出,优先速度 |

**查看**
- 缩放:工具按钮放大/缩小、**适应窗口**、**100% 原尺寸**
- 放大查看模式:按住拖动平移,滚轮按光标位置缩放

**渲染调整**(实时,重新渲染即可看到效果)
- 曝光 (**EV**)、亮度、对比度、饱和度、高光、阴影
- 白平衡:相机 / 自动 / 日光 / 阴天 / 阴影 / 闪光灯 / 钨丝灯 / 荧光灯 预设,以及自定义 RGB 增益(浏览器端实时调色,无需重新解码)

**信息面板**
- 直方图(明亮度 + 单通道 R / G / B,可切换通道)
- 文件信息与 EXIF 元数据(相机型号、镜头、焦距、光圈、快门、ISO、日期等,以文件实际内容为准)
- 拍摄位置地图(文件含 GPS 时显示坐标与地图内嵌,无 GPS 会明确提示)
- 像素拾取:放大查看模式下悬停/点击显示坐标与该点 RGB

**导出与预览**
- 导出:把当前渲染参数(曝光、白平衡、色调等)套用到全尺寸图并导出为 JPEG
- 批量导出:所有已导入照片按当前调整参数统一导出为 JPEG,并打包为 **ZIP 压缩包**(自动下载)
- 内嵌预览图:提取文件内嵌的 JPEG 预览(速度极快)

## 技术栈与目录结构

- 构建:Vite + React 19 + TypeScript
- UI:shadcn/ui(Tailwind CSS v4),深色主题
- 解码:LibRaw-Wasm(Web Worker + pthread)

```
raw-viewer/
├── index.html          Vite 入口
├── vite.config.ts      Vite 配置(base './',支持 GitHub Pages 子路径)
├── src/
│   ├── App.tsx         三列布局 + 状态编排
│   ├── components/     Toolbar / ThumbColumn / Viewer / SidePanel / ui(shadcn)
│   ├── hooks/          useRawViewer / useTheme
│   └── lib/            libraw.ts(worker 封装) / rawEngine.ts(解码) / render.ts(渲染) / format.ts(导出)
├── public/
│   ├── libraw/         LibRaw-Wasm 编译产物(worker.js / libraw.js / libraw.wasm)
│   └── samples/        测试用示例文件
└── .github/workflows/  GitHub Pages 自动构建部署
```

## 技术说明

- **纯浏览器端**:解码在 Web Worker 中执行,依赖 LibRaw-Wasm 的 pthread 支持;无需任何后端。
- **解码管线**:RAW → 去马赛克/色彩空间转换(LibRaw 输出 RGB8)→ 应用渲染参数 → RGBA 渲染到 canvas。调整参数时直接用 LUT 映射原始像素重渲染,不用重新解码(白平衡预设除外,预设通过设置 `useCameraWb` / `userMul` 重新解码以获得正确色温)。
- **性能**:标准档对 4256×2856 样片解码约 300ms,调整滑块重渲染约 10–30ms。

## 许可与致谢

- 应用代码(除 `public/libraw/` 外):随意使用,无限制。
- 解码引擎 [ybouane/LibRaw-Wasm](https://github.com/ybouane/LibRaw-Wasm) v1.6.0:Apache-2.0,其底层为 LibRaw(dcraw 衍生),版权归 LibRaw LLC。`public/libraw/` 目录为编译产物,授权请参考上游仓库。
- 示例文件 `samples/sample.ARW` 取自 [f-spot/raw-samples](https://gitlab.gnome.org/GNOME/f-spot/-/tree/master/raw-samples/RAW) (Sony A700)。
