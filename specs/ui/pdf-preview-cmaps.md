# PDF 中文预览的 CMap 资源

PDF.js 的预定义 CMap 由当前安装的 pdfjs-dist 提供，生产构建写入 `pdfjs/cmaps/*.bcmap`，开发服务器在相同路径读取本地包资源。运行时不请求外部 CDN。

构建插件只在 Vite build 调用 emitFile；开发 serve 插件只装配 CMap 中间件，不调用构建专属资源 API。两者沿用同一资源目录与相对 base URL，不能因为修复 Vite 8 serve 启动而丢失开发中文 PDF。

验收：真实 Vite server 可启动并返回 UniGB-UCS2-H.bcmap，日志无 emitFile 不支持错误；build 输出完整 packed CMap；ReportLab STSong 中文文本可解码。中间件拒绝目录穿越与非 bcmap 请求。
