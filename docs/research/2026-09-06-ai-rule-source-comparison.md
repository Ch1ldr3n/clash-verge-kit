# Issue #1：AI 开源规则来源

2026-09-07 选定、2026-09-08 重新验证。默认直接引用 MetaCubeX 的 **`category-ai-!cn` 综合规则**。此前三分类建议已取代；当前 V3 新方案已接入综合规则，迁移的 V1/V2 仍保留原来源。实施结果见[本轮验收](2026-09-08-routing-v1-acceptance.md)。

## 复用范围

| 项目 | 选定值 |
| --- | --- |
| 仓库 | [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat) |
| 运行时来源 | [meta 分支的综合 AI 文本](https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/category-ai-!cn.list) |
| 固定证据 | [c9f1fd664797ccdc85783c5746827a3f22ce6068](https://github.com/MetaCubeX/meta-rules-dat/blob/c9f1fd664797ccdc85783c5746827a3f22ce6068/geo/geosite/category-ai-!cn.list) |
| 原始响应摘要 | SHA-256 `2f01a4ba73661bce315958aae3e81871bdae826a4494dd93311655c8849bb89e`；3431 字节，179 条 |
| 接入格式 | HTTP、domain、text；更新间隔 86400 秒，由 Mihomo 下载与缓存 |
| 本项目搬运内容 | 无上游处理代码、无打包规则全文、无新增依赖；只引用公开数据 URL |

固定 commit 用于研究复现；运行时滚动 URL 用于更新，二者不混用。探针 [probe-ai-source.mjs](../../scripts/probe-ai-source.mjs) 校验原字节摘要及代表域名，网络失败直接报错，不冒充成功。它不把完整数据落到仓库，也不访问私人配置。

## 与 WiseOneCloud 的区别

本地只读证据见 [WiseOneCloud 参考](2026-09-06-wiseonecloud-routing-reference.md)，2026-09-07 再次核对仍为 81 条规则、55 条指向 AI平台。未展开本机 GEOSITE 数据库，因此不是两个完整数据库的等价比较。

| 范围 | 综合规则固定样本 | WiseOneCloud 参考 |
| --- | --- | --- |
| ChatGPT、Claude | 有 | 有明确域名和分类 |
| Grok、Cursor、Perplexity | 有 | 有对应分类 |
| Gemini、NotebookLM | 有 | AI 条目未见明确对应项 |
| Linux.do、NodeSeek | 无 | 也分到 AI平台 |
| Stripe、Cloudflare 整个域名范围 | 无 | 有宽后缀；综合规则仍可能包含特定子域 |
| Envato、ThemeForest | 有 | 本地参考未作完整对应验证 |
| 公共语音服务 | 有 host.livekit.cloud 等 | 有更宽 livekit.cloud 后缀 |

采用上游综合范围，不自行删改或维护第二份名单。它并非严格的“只有 AI 请求”：素材站及共享服务也可能走所选出口；类别名称不能当成地域或业务保证。只承诺按规则匹配，不承诺各厂商登录、上传、语音或特定节点可用。服务单项覆盖优先于综合分类的例外机制留给后续产品需求，不在 #1 新增菜单。

## 更新与许可

[Mihomo 官方格式说明](https://wiki.metacubex.one/config/rule-providers/)支持上述接入方式。规则更新和机场订阅更新是独立的：Kit 只生成配置，客户端/内核负责下载；更新失败须区分已有缓存和首次无缓存，不能宣称失败时仍获得最新名单。

[MetaCubeX 仓库 LICENSE](https://github.com/MetaCubeX/meta-rules-dat/blob/master/LICENSE)为 GPL-3.0；其聚合来源包含 [domain-list-community](https://github.com/v2fly/domain-list-community/blob/master/LICENSE) 等各自授权的数据，不将整个聚合产物标成 MIT。本项目 MIT 许可不覆盖远程第三方数据。本次不复用上游处理代码，故无搬运代码的依赖或再许可结论；若未来打包、修改或转发规则全文，需按届时具体来源核对分发义务，不能沿用“仅引用”的结论。

## 其他候选与选择理由

blackmatrix7 有细分 Clash 规则，Sub-Store 有节点整理能力，完整覆写模板还可能重建代理组及 DNS/TUN。当前任务只需一个远程 AI 规则集合，没有必要引入这些处理链。本次没有从这些候选搬运代码或数据，因此不把它们的版本、许可审计冒称已完成。

此前 2026-09-06 三份服务文本计数/规范化摘要只描述旧建议；本页改用单个固定 commit 的原响应摘要，替代旧浏览缓存证据。测试通过只证明来源和覆盖样例，不等于正式功能或真实订阅已经生效。
