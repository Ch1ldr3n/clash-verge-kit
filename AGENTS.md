## Project rules

- 开始工作前阅读 `CONTEXT.md` 和相关 `docs/adr/`，遵循其中的术语与产品边界。
- 不提交真实订阅 URL、token、`profiles.yaml`、YAML 原文或完整生成脚本。
- 修改产品边界、架构、领域术语或用户流程时，同步检查 `README.md`、`CONTEXT.md`、相关 spec 和 ADR；普通实现修复不强制修改文档，历史决策使用“已取代”状态保留。
- 未经用户明确要求，不执行 commit、push、merge、发布或删除远端内容。

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with `CONTEXT.md` at the root and ADRs under `docs/adr/`. See `docs/agents/domain.md`.
