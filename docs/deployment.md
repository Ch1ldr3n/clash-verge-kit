# CLI 本机运行

Clash Verge Kit CLI-only V1 只交付本机命令行工具，不提供浏览器页面、localhost 服务或公网部署配置。

## 安装与运行

要求 Node.js 22.12.0 或更高版本。

```powershell
npm.cmd ci
npm.cmd run cli
```

`npm.cmd run cli` 会先执行 TypeScript 检查和 CLI 构建，再运行 `dist/cli/cli.mjs`，适合首次运行或源码修改后使用。

Windows 的 `clash-verge-kit.cmd` 始终运行同一个 `dist/cli/cli.mjs`，不包含第二套业务实现。构建产物不存在时，它只执行一次 `npm.cmd run build:cli`；产物已存在时直接用 Node 启动，因此日常双击不会重复显示 Vite 的模块构建日志。CMD 不会自动执行 `npm.cmd ci`，源码更新后需要主动运行 `npm.cmd run cli` 或 `npm.cmd run build:cli`。

构建后也可以直接运行：

```powershell
npm.cmd run build:cli
node dist/cli/cli.mjs
```

构建产物只有：

```text
dist/cli/cli.mjs
```

## 包边界

`package.json` 声明 `bin.clash-verge-kit = dist/cli/cli.mjs`，并用 `files` 白名单限制发布内容。包已配置为公开发布；首次发布完成后，普通用户直接运行 `npx clash-verge-kit`，无需克隆仓库。

```powershell
npm.cmd run verify:package
```

dry-run 包只应包含 `LICENSE`、`README.md`、`dist/cli/cli.mjs` 和 `package.json`。

发行前可运行：

```powershell
npm.cmd run check:release
```

该命令只在临时目录中生成 `.tgz`、隔离安装并启动其 npm `bin` 命令；它不执行 npm 发布，也不创建 GitHub Release。安装声明的运行时依赖时可访问 npm registry。

## 运行责任

CLI 写入目标扩展脚本成功后，只能说明文件已安全更新。用户仍需回 Clash Verge Rev 重新激活目标订阅并检查运行配置；CLI 不重启客户端、不调用内部 Tauri 命令，也不宣称脚本已即时应用。

## 验收

```powershell
npm.cmd test
npm.cmd run build:cli
npm.cmd run verify:privacy
npm.cmd run verify:package
```

验收不安装浏览器，也不运行 Playwright、HTTP 服务或页面 E2E。
