# desktop-computer-use

Main的Computer Use资源路径与能力入口。仅分配随包app/binary/server路径，不保存会话、权限或控制租约。
正式包忽略外部路径覆盖；开发仅使用显式本地覆盖或production cache，不借旧preview身份。
能力查询经异步access核查资源，低于mac14及非mac不可用。Host权限adapter另核对实际app-agent身份。
路径env经既有Main→Host边界传递；系统设置动作仅接受两种权限，并由原Main命令调用shell。
