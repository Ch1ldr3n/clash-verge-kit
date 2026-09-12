# 规则分流 V1：AI 规则源与开源复用核实

日期：2026-09-05。对应工单 #1；这是实施研究，不表示功能已交付。未修改产品代码、下载真实订阅或执行上游脚本。研究目录此前不存在，本报告按工单放入 `docs/research/`。

## 推荐结论

已取代的历史建议：本节保留 2026-09-05 候选与 2026-09-06 三分类阶段的研究过程。2026-09-07 最终收敛为综合 `category-ai-!cn` 文本，2026-09-08 已复核固定证据并接入 V3；最新决定见[公开规则与 WiseOneCloud 对照](2026-09-06-ai-rule-source-comparison.md)。以下旧的“尚未选定/待确认”不再描述当前状态；候选代码版本、许可与零代码搬运范围仍可追溯。

- V1 推荐候选为现有生成器引用的 MetaCubeX `category-ai-!cn.mrs`，但尚未选定为生产规则源：其共享域影响需要用户确认，工单 #1 仍未完成。若接受此范围，应明确标示为“境外 AI 综合规则”，而不是声称只包含 ChatGPT、Claude、Gemini。固定快照已证实三者的关键域名存在，但不是端到端服务可用性证明。
- 只生成远程 rule-provider 引用，不把上游脚本、构建器或 MRS 数据复制进 Kit 源码/发布包。本次没有引入第三方代码，因此也没有新增第三方依赖。
- 更新使用上游 `meta` 分支；研究和回归样例记录固定 commit。上游会强推产物分支，固定 commit 不是永久可下载保证；不能把滚动 URL 宣称为内容锁定。
- Mihomo-Toolkit 可作为服务配置与生成思路的参考，但不整包调用其 `main`；MiSub 的变换链属于后续 B 范围；clashnodeeditor 暂不作为直接复制来源。下面把代码许可与规则数据许可分开记录，未完成的数据授权溯源不得冒充 MIT。

## 可复核版本

下列 SHA 来自本次 `git ls-remote`；候选仓库和产物又以临时浅克隆的 `rev-parse HEAD`、`git show` 核对。未修改全局 Git 配置。GitHub API 当时限流，未依赖其结果。链接固定到本次快照，不使用 README 的版本号代替 commit。

| 来源 | 固定 commit | 用途 |
| --- | --- | --- |
| MetaCubeX/meta-rules-dat master | `4178770badecb1b349fbcd62c737e0d7a2079729` | 构建工作流、仓库许可 |
| MetaCubeX/meta-rules-dat meta | `6dd69d6d3842a4e24d4ddb913e4f94eaeed804c9` | 实际产物的域名清单和 MRS |
| v2fly/domain-list-community HEAD | `cb663f66025ef3be1c1c7eb367dfac5f46645ffc` | 当前上游身份；网页读取的是滚动 master，未将其冒充该产物的构建输入 SHA |
| XiaoM-OVO/Mihomo-Toolkit | `e9d6a25529d90f76b29e1b4fa9737af446a75d30` | 生成结构候选 |
| imzyb/MiSub | `1008b7c9090d3d789d0ecb27bb2dc387d27881bd` | 后续变换链候选 |
| yanjinbin/clashnodeeditor | `00c1255d5ab5f30b6c498eab05e23b66da411cc8` | 交互/来源刷新参考 |

## 规则数据、覆盖和缺口

当前 `src/generator.ts` 的 `AI_RULESET_URL` 已使用该集合。实际检查的是固定产物的 [category-ai-!cn.list](https://github.com/MetaCubeX/meta-rules-dat/blob/6dd69d6d3842a4e24d4ddb913e4f94eaeed804c9/geo/geosite/category-ai-%21cn.list)，不是只凭集合名称推断覆盖；同快照包含 [MRS 产物](https://github.com/MetaCubeX/meta-rules-dat/blob/6dd69d6d3842a4e24d4ddb913e4f94eaeed804c9/geo/geosite/category-ai-%21cn.mrs)。本次未解码 MRS 对照全部条目。

| 服务 | 清单中确认的代表性匹配项 | 能证明/不能证明 |
| --- | --- | --- |
| ChatGPT / OpenAI | `+.chatgpt.com`、`+.openai.com`、`+.oaistatic.com`、`+.oaiusercontent.com`、`+.chatgpt.livekit.cloud` | 包含主站、API 所属域及部分资源/语音域；不证明所有登录、支付、实时语音依赖完整 |
| Claude / Anthropic | `+.claude.ai`、`+.claude.com`、`+.anthropic.com`、`+.claudeusercontent.com` | 包含主站、API 所属域和部分内容域；不证明全部第三方依赖 |
| Gemini / Google AI | `+.gemini.google.com`、`+.generativelanguage.googleapis.com`、`+.aistudio.google.com`、`ai.google.dev` | 包含主站、开发平台和模型 API；没有把所有 Google 域名一起导入 |

同一个集合还包含 Copilot、Cursor、Perplexity 等以及一些共享遥测/资源域。它并非三个品牌的精确隔离集合，共享域上的非 AI 请求也可能改道；这与已批准的“普通流量不变”存在产品范围取舍，不能由研究自行重新解释规格。需要用户确认接受综合规则的共享域影响，或选择更窄的规则范围；确认前仅保留为候选，不将其视为已选定生产规则源。来源仍是上述固定清单。

遗漏域、直接 IP 请求、未能提供域名的流量、第三方账号验证，以及服务商地域/账号限制不由“存在规则”解决。本次没有登录或请求真实 AI 服务，也没有测试登录、文件上传、语音等业务流程。后续验收必须区分域名命中、流量走指定出口与服务可用性。

### 更新链

[构建工作流](https://github.com/MetaCubeX/meta-rules-dat/blob/4178770badecb1b349fbcd62c737e0d7a2079729/.github/workflows/run.yml) 每天 UTC 22:30 调度，也支持手工和 master 推送触发；拉取 domain-list-community、domain-list-custom、转换器等，构建 geosite 再转换产物，最后强推 `meta`。这是计划频率，不是每日成功发布 SLA。上游输入未全部锁定 SHA，当前源文件不能证明此前某次产物的精确输入版本。

建议生成器的刷新间隔采用 86400 秒，并在用户说明中提示由 Mihomo 下载和缓存；Kit 不后台同步。首次下载失败、已有缓存时更新失败的实际行为应另做隔离内核验证，不得以出口组非空推导规则集已成功加载。也不要添加未经需求确认的 DIRECT 下载兜底策略。

### 代码许可不等于数据许可

- MetaCubeX 仓库的 [LICENSE](https://github.com/MetaCubeX/meta-rules-dat/blob/4178770badecb1b349fbcd62c737e0d7a2079729/LICENSE) 是 GPL v3 文本；这不能直接回答每份聚合规则数据的全部权利来源。
- 原始 domain-list-community 的 [LICENSE](https://github.com/v2fly/domain-list-community/blob/master/LICENSE) 是 MIT；[AI 集合源文件](https://github.com/v2fly/domain-list-community/blob/master/data/category-ai-%21cn) 包含 anthropic、openai、google-deepmind 等 include。结合构建工作流，可以追踪主要来源，但没有固定该次产物的上游输入 SHA，不能将整份 MRS 简单标成 MIT。
- 本次未发现并核实针对该 MRS 的独立数据授权声明、完整输入物料清单或所有间接来源的授权链。结论是“数据许可未完全解析”，不是“无许可”或“不可使用”。建议限定为上游远程引用、保留出处；若后续需要镜像、打包、修改和再分发，必须先补齐权利与通知要求的审核。这是工程范围控制，不是法律合规保证。

可选的更窄来源路线：直接采用 domain-list-community 的固定修订，解析目标集合及递归 include，保留 MIT 版权/许可通知，再生成 Kit 所需的静态数据。这样不复制 MetaCubeX 的 GPL 构建流水线，但会新增数据更新与格式转换职责；本次尚未在固定修订上完整解析 include、复核逐文件声明和验证转换一致性，因此它是可推进的替代方案，不是已经核验完毕的发布材料。如果 V1 必须内置或再分发数据，优先完成这条路线的核实，而不是把聚合 MRS 改标 MIT。

## 开源代码复用评估

| 候选与具体文件 | 许可证据 | 适合复用的最小内容与决定 |
| --- | --- | --- |
| [Mihomo-Toolkit src/mihomo-toolkit.js](https://github.com/XiaoM-OVO/Mihomo-Toolkit/blob/e9d6a25529d90f76b29e1b4fa9737af446a75d30/src/mihomo-toolkit.js) | [MIT LICENSE](https://github.com/XiaoM-OVO/Mihomo-Toolkit/blob/e9d6a25529d90f76b29e1b4fa9737af446a75d30/LICENSE)，XiaoM-OVO 2026 | 可参考 AI 服务目录和 provider 配置分离。其默认开关涉及 DNS/TUN、地区偏好、清洗/重命名，不能把整份 main 当 Kit 增量编排模块。V1 无需直接复制代码；若后续抽取片段，逐段固定 SHA 并保留版权/许可。其引用的规则和图标仍须另查授权。 |
| [MiSub functions/utils/operator-runner.js](https://github.com/imzyb/MiSub/blob/1008b7c9090d3d789d0ecb27bb2dc387d27881bd/functions/utils/operator-runner.js) | [MIT LICENSE](https://github.com/imzyb/MiSub/blob/1008b7c9090d3d789d0ecb27bb2dc387d27881bd/LICENSE)，MiSub Contributors 2026 | `runOperatorChain` 按顺序运行 filter/rename/script/sort/dedup；这不等价于 V1 手选节点身份保持。只作为 B 的变换链参考，本期不导入脚本执行和 URL 转换依赖。 |
| [clashnodeeditor src/utils/sourceRefresh.ts](https://github.com/yanjinbin/clashnodeeditor/blob/00c1255d5ab5f30b6c498eab05e23b66da411cc8/src/utils/sourceRefresh.ts) | [README](https://github.com/yanjinbin/clashnodeeditor/blob/00c1255d5ab5f30b6c498eab05e23b66da411cc8/README.md) 标 MIT；该固定树未见独立 LICENSE 文件 | 可参考来源刷新进度呈现，不能替代 Kit 本机检查/安全下载。具体版权和许可正文未齐全核实，不作为直接复制来源；Web 状态层也不适合 CLI。 |

MiSub 的 [processor-service.js](https://github.com/imzyb/MiSub/blob/1008b7c9090d3d789d0ecb27bb2dc387d27881bd/functions/services/processor-service.js) 还包含输出配置级设置和重名改写，不能作为“只增加出口组和规则”的整体实现。上述 MIT 判断限于已检查的项目声明，不代表依赖、数据、素材自动获得同一许可。

## 交付给实现阶段的检查点

1. 先确认共享域影响的产品取舍；未获确认前工单 #1 保持未完成、不接入生产源。若选择此综合集合，AI 模块摘要明确显示“境外 AI 综合规则”，不声称只有三家或全部 AI。
2. 添加代表域命中与普通域不命中的测试；更新数据与固定研究样本分开，避免测试依赖当天网络。
3. 验证 MRS 与文本快照一致性、首次下载失败/缓存更新失败及内核支持范围，再声明运行行为。
4. 增量修改只涉及 Kit 自有 rule-provider、出口组及置顶规则；不复用上游完整 DNS/TUN 模板。
5. 若决定直接复制候选代码或分发规则数据，先更新逐文件来源、授权/通知记录。本报告目前推荐零代码搬运和零数据打包，不阻止使用已存在的上游规则引用能力。

保存兼容合同和最低内核行为由工单 #1 的另一研究部分及工单 #2 负责，不在本报告中替它们下结论。
