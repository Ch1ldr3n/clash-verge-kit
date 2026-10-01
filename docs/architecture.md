# Architecture

当前架构以 [CLI-only V1 正式规格](specs/2026-08-23-cli-only-v1.md) 和 [ADR-0003](adr/0003-cli-only-product.md) 为准。CLI 是唯一产品入口；仓库不再包含 React 页面、localhost 服务或浏览器启动链路。

## 按功能找文件

| 要理解或修改的事情 | 主要入口 | 职责 |
| --- | --- | --- |
| 终端向导、嵌套和 AI 入口 | `scripts/cli.ts`、`cli-workflow.ts`、`cli-routing-nodes.ts` | 展示菜单、接收输入、组织返回和确认 |
| 发现订阅、读取节点、核验来源 | `scripts/local-profile-repository.ts`、`routing-node-inspection.ts`、`routing-source-catalog.ts` | 分别负责文件访问、单份配置的检查、跨来源汇总；同一主 YAML 只解析一次 |
| 生成嵌套与 AI 分流脚本 | `src/generator.ts`、`routing-runtime.ts` | 共享生成入口；旧模板保留兼容，新修订隔离目标缓存 |
| 重新打开、编辑、关闭方案 | `src/routing-plan-editing.ts`、`workspace-session.ts`、`managed-script-integrity.ts` | 纯编辑规则、会话状态、完整脚本校验；写入与备份仍归本机仓库 |
| 回归与实际进程验证 | `tests/`、`scripts/verify-package-install.mjs`、`probe-*.mjs` | 分别验证规则和工作流、安装后 CLI、隔离内核行为；四组内核探针共用 `probe-runtime.mjs` 管理临时目录、进程和回环服务 |

文件较多主要来自三类职责：用户交互、生成与安全读写、测试。不会为了减少文件数合并历史模板、取消路径或写入保护。具体测试入口见[验证说明](verification.md)。

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
- `src/routing-plan-editing.ts`：集中已保存方案转为编辑草稿、切换已有出口、手选节点和关闭分流的纯编辑规则，返回独立的新草稿，保留旧规则来源、自定义域名、移除依据与嵌套配置。两个 CLI 交互模块共用此入口；本机检查、返回/取消、版本门槛和交付确认仍由 CLI 组织，管理会话继续同步生成。
- 编辑规则与保存格式识别分开：`src/routing-plan.ts` 的归一化仍参与 V3 校验与字节重建，不承担编辑动作，也不因编辑重构改变历史识别语义。
- `src/generator.ts`、`src/integrity.ts`、`src/script-import.ts`、`src/managed-script-integrity.ts`、`src/types.ts`、`src/workspace-session.ts`：共用 TypeScript 核心；CLI 调用现有生成器，不维护第二套生成逻辑。
- 生成器内部统一组装完整脚本与遮罩预览：分别使用原始数据和遮罩数据，共用管理块、嵌套入口衔接与分流脚本的组装步骤。历史 V1/V2 模板、V3 `routing-v1` 模板和遮罩规则保持原字节合同；合成样例的固定摘要用于检查重构前后输出一致，遮罩测试同时检查正文与解码后的管理块。
- `scripts/clash-verge-locator.ts`、`scripts/local-profile-repository.ts`、`scripts/profile-yaml.ts`：有限位置发现、配置解析、进程内不透明 ID 和安全脚本写入。
- 分流来源通过 `LocalProfileRepository.readRoutingSnapshot` 按本机 ID 或来源定位，一次读取主 YAML，返回目标身份、可复制的 provider 描述和节点检查结果。`routing-node-inspection.ts` 使用同一解析结果检查静态节点与受限本机缓存；目标节点可读性与子订阅来源可复制性分别判断。主配置不存在、读取失败及部分 provider 失败保持不同结果；这不构成多个 provider 缓存的原子快照。
- `scripts/routing-source-catalog.ts` 消费来源快照并集中来源映射：选择时刷新描述，交付时拒绝已变化的 provider 定位。目标身份和主配置可读性独立核验；没有自身节点的可读目标仍可使用子来源。索引读取失败属于无法核实，不能当作来源不存在；被删除的 provider 引用须取消选择后才能保存草稿。CLI 只负责呈现和交互；保存方案的 revision、备份与写入前重读仍由本机配置仓库独立处理，不以分流检查结果代替写入校验。
- `src/managed-script-integrity.ts` 的 `inspectManagedScript` 集中同一份脚本内容的管理块解析与完整字节识别，返回解析出的设置及独立的可信性结论；设置可解析不代表正文可信。读取和写入共用此结果，保留各自的可编辑条件、冲突判断顺序和错误映射。编辑期版本核对、写入前及备份后的重新读取和真实路径检查仍由本机配置仓库执行，不跨文件快照复用检查结果。
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
