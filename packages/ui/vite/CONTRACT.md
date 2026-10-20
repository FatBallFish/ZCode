# PDF.js 本地资源构建适配

Node build adapter 只读取当前安装的 pdfjs-dist/cmaps。build 插件输出 packed CMap，serve 插件提供同路径中间件；两者都不依赖外部 CDN。

emitFile 只能在 build 模式使用；serve 绝不执行构建资产 API。路径保持 pdfjs/cmaps/\*.bcmap，中文解码和 Vite 8 实际启动/构建由 pdfJsCMapSupport 测试验证。
