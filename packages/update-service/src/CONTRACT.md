# Mikiko 升级 HTTP 服务

`worker.ts` 是唯一 HTTP router，拥有更新清单/强更配置、R2 下载代理与发布鉴权；R2/KV 通过现有 Worker bindings 注入。contract 只公开该入口和绑定类型，不复制路由、缓存、版本/平台选择规则。

普通客户端更新始终访问自建域名。发布与删除旧版本只由显式 CI/admin 鉴权请求执行，契约和测试不部署、不写正式 R2/KV。Range、不可变发行包与短缓存的真实行为由现有 update-service 测试套件覆盖。

下载的单 Range 由完整 R2 元数据校验，再按规范化 offset/length 流式读取；R2 `size` 始终是完整大小，206 头部使用实际分片长度。闭区间、开放末端、suffix 和 416 由真实本地 Worker/R2 回归；416 空 body 且 no-store，HEAD 仅读取完整元数据，不打开下载流。不支持的 Range 仍回完整 200。

原 wrangler Worker 入口保持不变；本模块只登记已有真实服务边界，不引入另一套发布或缓存 owner。
