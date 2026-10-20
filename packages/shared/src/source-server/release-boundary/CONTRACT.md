# Source Server release contract

Owner：distribution。层：contract。唯一 schema 仍在 `release.ts`，本入口转出原常量、schema 与推导类型，不复制校验器、缓存或发布状态。

- 支持 Linux/macOS 的 x64/arm64 四种 target；schema 允许合法 target 子集，发布流程另行要求完整四平台。
- archive 文件名必须为 `mikiko-server-<target>.tar.gz`；SHA256 使用 64 位小写十六进制，size 为正整数。
- descriptor 内 archive 的版本与 descriptor 相同，target 不重复；未知字段拒绝。
- 下载地址允许 HTTP(S) 或安全相对路径，拒绝绝对文件路径、反斜线和点段穿越。
- schema 只验证元数据格式；实际归档字节完整性由既有发布与安装 owner 校验，不能把 parse 成功当作文件已下载或校验成功。

外部模块使用 `release-boundary/contract.ts`；原 `release.ts` 保留兼容入口。此模块零 IO、无可变状态、无运行时适配器依赖。
