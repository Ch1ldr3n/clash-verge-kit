# Clash Verge Kit

[简体中文](README.md) | [English](README.en.md)

Clash Verge Kit 是一个面向 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) 的本机命令行工具。它帮助你把多个子订阅分别组织成代理组，再安全地加入现有主订阅。

> 当前状态：项目尚未发布到 npm。现在请从源码运行，暂时没有可用的 `npm` 或 `npx` 一键安装命令。

## 它解决什么问题

如果你在 Clash Verge Rev 中使用多个订阅，手工编写嵌套脚本通常需要自己处理订阅来源、代理组名称、重复项和脚本写入位置。Clash Verge Kit 把这些步骤整理成一个终端向导，并在真正写入前让你检查结果。

目前支持：

- 读取 Clash Verge Rev 已导入的本机订阅；
- 选择目标主订阅和主代理组；
- 添加本机子订阅，或手工输入子订阅的公网 HTTPS 地址；
- 为每个子订阅生成独立代理组；
- 查看配置摘要和隐藏敏感来源的脚本预览；
- 将完整脚本复制到剪贴板；
- 经你确认后，安全写入目标订阅已经绑定的脚本文件。

## 现在怎么使用

使用前需要：

- Node.js 22.12.0 或更高版本；
- 已安装 Clash Verge Rev；
- 目标主订阅已经导入 Clash Verge Rev。

在终端运行：

```powershell
git clone https://github.com/Ch1ldr3n/clash-verge-kit.git
cd clash-verge-kit
npm.cmd ci
npm.cmd run cli
```

Windows 用户安装依赖后，也可以双击仓库根目录的 `clash-verge-kit.cmd`。第一次运行会构建 CLI，以后会直接启动已有构建产物。

## 使用流程

1. 选择界面语言和目标主订阅。
2. 选择要接收子组的主代理组。
3. 添加一个或多个子订阅。
4. 检查订阅与代理组的对应关系。
5. 选择复制脚本，或确认后写入目标脚本文件。
6. 回到 Clash Verge Rev，重新激活目标订阅并检查结果。

写入成功只代表脚本文件已经更新。Clash Verge Kit 不会自动重启或控制 Clash Verge Rev，也不会把“文件已写入”当成“配置已经生效”。

## 安全与隐私

- 订阅来源和生成结果只保存在当前 CLI 进程中；
- 终端不会输出完整脚本，预览会隐藏订阅来源；
- 工具不会修改 `profiles.yaml`；
- 未经确认不会联网检查订阅或写入文件；
- 未知自定义脚本、异常路径、符号链接、Windows Junction 和并发变化会被拒绝；
- 请勿在仓库、Issue、截图或日志中公开真实订阅 URL、token、`profiles.yaml`、YAML 原文或完整生成脚本。

完整边界见 [安全说明](SECURITY.md)。

## 项目状态

当前唯一正式入口是本机 CLI，仓库暂未发布 npm 包。未来完成 npm 发布后，README 会再补充无需克隆仓库的一条命令用法；在此之前，以本页的源码运行方式为准。

开发和发行前检查：

```powershell
npm.cmd test
npm.cmd run check:release
```

更多技术信息见 [本机运行说明](docs/deployment.md) 和 [验证说明](docs/verification.md)。

## 许可证

[MIT License](LICENSE)
