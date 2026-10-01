# 规则分流 V1：Issue #1–#6 验收

> 历史快照。本页“未提交、193 项、复审 0 项”为 2026-09-08 当时结果。2026-09-23 对提交 `53abaf0` 完成发布检查后复现了跨目标缓存串用 P1，随后在本地工作区修复；当前验证结果、210 项回归和剩余工作见[最新检查记录](2026-09-23-release-readiness.md)。

2026-09-08。用户本轮要求一并完成 #1–#6。本记录针对 `codex/rule-routing-v1` 的未提交工作区，起点为 `095a14d80faa8e7655f5474007f0b436c83e9c76`，包含此前在制改动；不表示远端已包含代码、工单已关闭或真实订阅已生效。

## 交付结果

一个 CLI、一个公开生成入口。独立 AI 可复用已有 select 组，也可分页搜索并组合目标/本机子订阅的静态和可读取 provider 节点；方案保存于目标已绑定的 Kit 脚本。再次打开可换出口、增减节点、关闭或取消。原嵌套保留，未知脚本保持拒绝。

新方案采用 MetaCubeX 综合 AI 文本规则；旧 V1/V2 保留来源与域名语义。管理块 V3 分离来源、出口、模块，旧生成字节不变；写入前保留同目录旧脚本副本并核验整个编辑期的索引、绑定和旧文件快照。复制不视为安装，写入不视为激活。

## 工单映射

| Issue | 结果与证据 |
| --- | --- |
| #1 规则源/保存合同 | [固定来源、许可与覆盖](2026-09-06-ai-rule-source-comparison.md)、[候选仓库固定版本](2026-09-05-routing-rule-sources.md)、[保存兼容合同](../specs/2026-09-05-routing-persistence-design.md)；公开源摘要及 16 项断言、9 项研究合同验证通过 |
| #2 空候选实测 | `probe-routing-empty.mjs`：静态、file/HTTP、手动/定时更新、部分/全部缺失、负对照直连、503/解析/超时、无缓存首启、重启磁盘缓存、坏配置保留旧运行配置 |
| #3 已有组 CLI 交付 | `cli-workflow.test.ts`、`routing-plan.test.ts`、`local-profile-repository.test.ts`：独立入口、综合源、优先级、原组策略、安全交付、V3 回读及引用校验 |
| #4 回读/修改/关闭 | `routing-workflow.test.ts`、`routing-plan.test.ts`：实际临时仓库往返；V1/V2 后缀迁移与旧输出撤除；共享对象延续归属、最终引用消失才清理；取消不写文件 |
| #5 目标节点 | CLI 分页、搜索、选择/取消和缺失提示；目标原静态节点不改名、provider 私有副本精确过滤；未知/旧内核拒绝；真实生成器输出的 HTTP provider 更新验证 |
| #6 跨子订阅 | 来源/provider/原名称身份、原前缀、同名隔离、来源定位变化拒绝陈旧交付、删除不再选用的来源、嵌套保留、原 include-all 组隔离；正式生成脚本的真实 TCP 验证 |

## A1–A16

| 编号 | 已验证场景 | 主要入口 |
| --- | --- | --- |
| A1 | 无子订阅：已有组或目标节点可生成、复制/写入 | CLI 集成、routing workflow |
| A2 | 加入/编辑/关闭路由仍保留原入口、子组与 provider | repository、routing plan、generated probe |
| A3 | 复用 select 组保留成员/原策略；不导入子订阅原组 | CLI、生成器、嵌套回归 |
| A4 | source + provider + raw name 精确定位；同名、加号、方括号及已有前缀隔离；私有节点不进入原 include-all 组 | routing plan、generated/empty probes |
| A5 | AI 规则置顶，早于机场更宽规则；普通样例仍走原出口 | generator、generated probe |
| A6 | 临时脚本保存→回读→换组/改节点→再次保存；复制新草稿不改旧文件；陈旧 provider 定位拒绝 | routing workflow、repository |
| A7 | 新鲜机场输入与已有 Kit 输出上关闭；共享组/provider 保留，外部引用随后移除可再清理 | routing plan、V1/V2 CLI 迁移 |
| A8 | 一个来源全缺失仍使用另一来源选中候选 | empty/generated probes |
| A9 | 成功更新后静态与动态全部选中节点缺失时 REJECT；真实请求不走直连/未选节点；主动检查允许重选或关闭 | probes、routing workflow |
| A10 | 已有组摘要明示其原策略，包括 DIRECT；手选摘要单独说明空候选阻断 | 中英文 CLI 回归 |
| A11 | 多次应用、改出口和开关不累积对象；共享对象等值复用、归属延续；悬空/循环拒绝 | generator、routing plan、兼容回归 |
| A12 | V1 固定字节、历史压缩、V2、V3 完整重建；未知字段/修订、重复块、附加代码、失配目标、并发变化及异常路径拒绝 | import、compatibility、repository、routing workflow |
| A13 | 手选最低核实稳定版本 1.19.29；旧版本、未知/预发行拒绝；显式 MIHOMO_BIN 无 PATH 回退 | CLI gate、capability、版本证据 |
| A14 | 22 节点列表分页搜索、英文选择/复制；筛选/命名/确认返回保留选择；默认输出无来源凭据 | routing workflow、CLI、privacy check |
| A15 | 复制未安装、已写入、重新激活三者区分；安装前方向复核 | CLI 集成、真实临时仓库 |
| A16 | 本机读取失败不当作零节点；连接失败仍保留候选；更新 503/非法内容/完整超时保留旧候选；无缓存节点首启、规则首启失败及应用失败分别实测 | repository、workflow、两个真实 probes |

上述是自动化及隔离运行验收，不替代用户的实际客户端激活/业务测试。

## 命令与结果

在仓库根目录运行；公开规则探针需要网络，其他探针只使用合成来源及回环端口。`MIHOMO_BIN` 可指定本机已安装的内核，不下载内核。

```powershell
node scripts/probe-ai-source.mjs
node --test scripts/probe-routing-contract.mjs
node scripts/probe-routing-empty.mjs
node scripts/probe-routing-generated.mjs
npm.cmd run check
```

- 公开源：固定 `c9f1fd664797ccdc85783c5746827a3f22ce6068`，SHA-256 `2f01a4ba73661bce315958aae3e81871bdae826a4494dd93311655c8849bb89e`，179 条、16 项断言通过；未把规则全文保存进仓库。
- 研究关系/所有权合同：9 项通过。正式保存使用 V3 生产实现，研究 schema 不参与产品运行。
- 全量回归：15 个文件、193 项通过。开发期间按公开行为先复现失败再修复，定期运行类型检查及受影响测试。
- `npm run check` 的测试阶段通过，首次构建遇到旧沙箱账号创建的 `tsconfig.node.tsbuildinfo` 写入拒绝；随后获准在沙箱外执行原 `npm run build:cli` 成功，未改变 ACL、项目配置或构建命令。其后 `verify:privacy`、`verify:package` 均通过；所有 check 组成步骤已完成。
- 产物为 `dist/cli/cli.mjs`；包检查只包含 LICENSE、两份 README、CLI 产物和 package.json。没有发布包或新增依赖。

实测内核：`Mihomo Meta v1.19.29 windows amd64 with go1.26.5 Sat Jul 18 12:20:03 UTC 2026`、`with_gvisor`，读取本机 `D:\Clash Verge\verge-mihomo.exe`，在独立临时目录启动测试实例。

官方 [v1.19.27 release](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.27) 的 `1e62d55` 是 empty-fallback 首次稳定发布证据；本轮实测为 1.19.29，因此产品门槛保守定为 1.19.29，未将 1.19.27 冒称经过运行矩阵验证。

## 运行失败的真实边界

| 事件 | 实际观察与解释 |
| --- | --- |
| 成功更新返回非空来源，但没有选中名称 | 组级精确过滤为空，只剩 REJECT；真实 TCP 请求阻断 |
| 原始来源全空 / provider 自身过滤零匹配 | 内核拒绝该次更新并保留旧候选；不是更新成功后的空组 |
| HTTP 503、非法 HTTP 200、完成的 HTTP 超时 | 更新失败，最后有效选中候选继续存在；不保证其服务器仍可连接 |
| 首次节点来源失败且无缓存 | 只有 REJECT，无虚构可用节点 |
| 选中节点存在，但 TCP 上游不可连接 | 候选仍存在，请求失败；不换成未选出口 |
| 首次规则下载 503 且无缓存 | 新配置返回 204、ruleCount=0，请求沿用原机场出口；不能据写入/应用成功宣称 AI 分流生效 |
| 坏配置应用失败 | Controller 返回 400，旧运行配置继续提供连接；抛错不能当作新阻断策略已生效 |
| 关闭模块 | 以当次输入撤除自有规则及不再共享的对象，保留当前机场规则与嵌套 |

## 限制与审查

- 没有修改活跃 Clash Verge 配置、系统代理、DNS/TUN 或真实订阅；测试实例、回环服务与临时文件均在退出时清理。
- 未实测 UDP、长连接、全部代理协议或各操作系统；未登录真实 ChatGPT/Claude/Gemini，也未代替用户在 Clash Verge Rev 重新激活。规则覆盖样例不等于服务可用性。
- 节点检查依赖本机原配置及可读取缓存。缺缓存须由用户在 Verge 刷新；不复制子订阅的任意下载 header/proxy 策略或传输变换，不支持者明确为无法核实。仅按来源/名称定位，不能识别同名服务器被替换。
- V1 AI create 是旧克隆组，保持只读，不伪造成手选结果；不提供一键撤销或后台健康/同步服务。
- Standards / Spec 两路审查发现的共享归属丢失、旧域名迁移与旧输出残留、越级返回、来源定位陈旧、原空 exclude-filter 误排除问题均已修复并加入对应回归。
- 最终定点复审：Standards 通过、Spec 通过，剩余问题 0 项。构建产物输入 `0` 的启动/退出烟测通过。
