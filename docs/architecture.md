# Architecture

当前架构以 [CLI-only V1 正式规格](specs/2026-08-23-cli-only-v1.md) 和 [ADR-0003](adr/0003-cli-only-product.md) 为准。CLI 是唯一产品入口；仓库不再包含 React 页面、localhost 服务或浏览器启动链路。

## 数据流

```text
官方/便携配置位置 ─┐
用户指定配置位置 ──┼─► 本机配置仓库 ─► 受限检查摘要 ─► GeneratorSpec
手工 HTTPS URL ───┘                                      │
                                                         ▼
                                              共用 TypeScript 生成器
                                                         │
                                      ┌──────────────────┴──────────────────┐
                                      ▼                                     ▼
                              拓扑/诊断/遮罩预览                  完整脚本（不回显）
                                                                            │
                                                               用户再次确认方向
                                                                            │
                                      ┌─────────────────────────────────────┴────────┐
                                      ▼                                              ▼
                                  系统剪贴板                              已绑定的 s*.js
```

## 模块边界

- `scripts/cli.ts`：唯一运行入口，组合终端 I/O、本机配置仓库、远程读取、生成器和剪贴板。
- `scripts/cli-workflow.ts`：组织交互和状态迁移，不直接读取真实文件或网络，测试使用假 I/O 与假适配器。
- `src/generator.ts`、`src/integrity.ts`、`src/script-import.ts`、`src/managed-script-integrity.ts`、`src/types.ts`、`src/workspace-session.ts`：共用 TypeScript 核心；CLI 调用现有生成器，不维护第二套生成逻辑。
- `scripts/clash-verge-locator.ts`、`scripts/local-profile-repository.ts`、`scripts/profile-yaml.ts`：有限位置发现、配置解析、进程内不透明 ID 和安全脚本写入。
- `scripts/remote-profile-reader.ts`：用户确认后的公网 HTTPS 读取与 SSRF、跳转、超时、大小限制。

## 运行边界

CLI 是一个前台 Node.js 进程。它不监听端口、不提供 HTTP API、不启动浏览器或后台服务。远程订阅检查是用户明确确认后的出站请求；本机发现和本机缓存读取不会发起远程请求。

所有会话数据只存在于当前进程内存。终端显示拓扑、诊断和遮罩预览；完整脚本只在方向确认后进入系统剪贴板或安全写入目标订阅已经绑定的脚本文件。

## 本机配置与写入

`scripts/clash-verge-locator.ts` 按官方数据目录规则生成有限候选；Windows 额外读取运行进程和卸载记录中的安装位置以发现便携配置。自动发现失败时，只检查用户明确输入的安装目录、配置目录或 `profiles.yaml`，不递归扫描磁盘。

`LocalProfileRepository.installManagedScript` 在写入前重新读取现场配置。待写入脚本必须是当前生成器的格式化产物；检查原文件时，共用核心同时识别当前格式化产物和未修改的历史精简产物。随后再校验 JavaScript 语法、文件类型、真实路径和文件指纹。它只写目标订阅已经绑定的独立 `s*.js`，拒绝仅保留有效管理元数据的手改脚本、未知自定义脚本、符号链接、Windows Junction、越界路径和并发变化；不修改 `profiles.yaml`，不重启或控制 Clash Verge Rev。

## 生成器不变量

- 手工主代理组必须存在且为 `select`；自动模式无法唯一判断时在修改运行配置前失败。
- 子 provider 和代理组必须通过工具所有权检查；名称冲突不会覆盖用户配置。
- 更新与复原语义仍保留在共用生成器和管理元数据中，以维持脚本格式兼容；CLI-only V1 暂不提供对应交互入口。
- AI 未启用时不修改规则、DNS 或其他无关配置。
- 遮罩预览与完整脚本来自同一次生成结果，完整脚本不得打印到终端。

## 构建与包

`vite.cli.config.ts` 把 `scripts/cli.ts` 构建为 `dist/cli/cli.mjs`。npm `bin` 和 `files` 白名单只指向该 CLI 文件；`clash-verge-kit.cmd` 在产物缺失时调用 `npm.cmd run build:cli`，已有产物时直接用 Node 运行同一文件，不维护第二套业务逻辑。
