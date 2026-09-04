## 项目规则

- 开始工作前阅读 `CONTEXT.md` 和相关 `docs/adr/`，遵循其中的术语与产品边界。
- 不提交真实订阅 URL、token、`profiles.yaml`、YAML 原文或完整生成脚本。
- 修改产品边界、架构、领域术语或用户流程时，同步检查 `README.md`、`CONTEXT.md`、相关 spec 和 ADR；普通实现修复不强制修改文档，历史决策使用“已取代”状态保留。
- 未经用户明确要求，不执行 commit、push、merge、发布或删除远端内容。

## Agent skills

### 问题追踪器

本仓库的问题与规格记录在 GitHub Issues 中。参见 `docs/agents/issue-tracker.md`。

### 分类标签

使用五个默认分类标签：`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human` 和 `wontfix`。参见 `docs/agents/triage-labels.md`。

### 领域文档

本仓库采用单一上下文结构：根目录使用 `CONTEXT.md`，ADR 存放在 `docs/adr/`。参见 `docs/agents/domain.md`。
