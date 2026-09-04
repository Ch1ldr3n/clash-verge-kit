# 问题追踪器：GitHub

本仓库的问题与规格记录在 GitHub Issues 中。所有操作都使用 `gh` CLI。

## 操作约定

- **创建问题**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取问题**：`gh issue view <number> --comments`，使用 `jq` 筛选评论，并同时获取标签。
- **列出问题**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需添加 `--label` 和 `--state` 筛选条件。
- **评论问题**：`gh issue comment <number> --body "..."`
- **添加或移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭问题**：`gh issue close <number> --comment "..."`

根据 `git remote -v` 判断目标仓库；在仓库克隆目录中运行时，`gh` 会自动完成判断。

## 是否把 Pull Request 纳入分类

**PRs as a request surface: no.** _（如果本仓库把外部 PR 视为功能请求，可改为 `yes`；`/triage` 会读取此标记。）_

设置为 `yes` 后，PR 与问题使用相同的标签和状态，并改用对应的 `gh pr` 命令：

- **读取 PR**：使用 `gh pr view <number> --comments`，并用 `gh pr diff <number>` 查看差异。
- **列出待分类的外部 PR**：运行 `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的 PR。
- **评论、添加标签或关闭**：使用 `gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的问题与 PR 共用编号空间，因此单独出现的 `#42` 可能指任意一种对象：先运行 `gh pr view 42`，失败后再运行 `gh issue view 42`。

## 当 Skill 要求“发布到问题追踪器”时

创建一个 GitHub Issue。

## 当 Skill 要求“获取相关工单”时

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图（map）**是一个独立问题，**子问题（child）**作为其工单。

- **地图（Map）**：一个带有 `wayfinder:map` 标签的独立问题，正文包含 Notes / Decisions-so-far / Fog。
- **子工单（Child ticket）**：作为 GitHub 子问题关联到地图的问题。未启用子问题功能时，改用任务列表和 `Part of #<map>`。
- **阻塞关系（Blocking）**：使用 GitHub 原生问题依赖；无法使用时，添加一行 `Blocked by: #<n>`。
- **前沿查询（Frontier query）**：按照地图顺序，选择第一个仍开放、未被阻塞且无人负责的子问题。
- **认领（Claim）**：运行 `gh issue edit <n> --add-assignee @me`。
- **解决（Resolve）**：先评论答复，再关闭子问题，最后把它的上下文指针加入地图。
