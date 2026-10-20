# office-runtime

内置文档插件（documents、pdf、presentations、spreadsheets）的查看面板共用这一份运行时。每个插件在自己的 package.json 里用 `office` 字段声明面板标题和格式，并把 `build` 脚本指向本包的 `scripts/build.mjs`；构建只保留该插件格式的解析器与查看器，输出到插件根目录的 `dist/`。面板、MCP 工具与锚点语法见 [src/CONTRACT.md](src/CONTRACT.md)。

不变量：

- 产品工作区覆盖环境变量使用 `MIKIKO_WORKSPACE_ROOT`，缺省取进程 cwd。显式导入文件由现有 importer 单一所有者写入工作区 `.mikiko/document-imports`；取消、失败和过期清理复用该目录，不写官方 `.zcode` 目录。面板读取现有文件仍保持只读；用户显式上传后的工作区写入沿用现有导入协议。
- 新资源声明与能力协商使用 `_meta["mikiko/csp"]` / `experimental["mikiko/csp"]`，放宽项仍只有现有的 `unsafeEval` / `wasmUnsafeEval` 布尔值。宿主读取旧 `zcode/csp` 的兼容逻辑由 shared 统一维护，插件不双写。

- 插件名取自插件的 `.mikiko-plugin/plugin.json`，它同时是 MCP 服务名、面板 surface id 和 `ui://<name>/` 资源前缀；不能从目录名推导（目录名带 `-plugin` 后缀）。
- 构建必定产出 `contract.ts` 的 `OFFICE_RUNTIME_OUTPUTS`。官方插件定义、SEA 清单、桌面打包与远端资产都把它们列为必需资产，改动产物路径时这几处要一起改。
- 产物自包含：`dist/server.mjs` 与面板脚本由 esbuild 打包全部依赖，运行时不读取 `node_modules`；第三方许可随产物写入 `dist/THIRD_PARTY_NOTICES.txt`。
- 查看器只读：面板和工具从不写工作区文件。
