# Web 登录等待视图

只拥有退出按钮的 in-flight 状态。用户/账号/token 真值仍由 Web auth service 拥有；页面通过回调发命令，不读 credential repo、不创建 Host 或 Agent。

旧 `auth/WebLoggedInWaitingPage.tsx` 路径作为当前装配的公开兼容入口，本轮不移动 Web 实现。Mikiko 品牌与 locale copy 来自当前 Web 壳层。
