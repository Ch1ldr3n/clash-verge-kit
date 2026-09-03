@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Clash Verge Kit CLI

where node >nul 2>nul
if errorlevel 1 (
  echo [Clash Verge Kit] 未找到 Node.js 22.12.0 或更高版本。
  pause >nul
  exit /b 1
)

set "node_major=0"
set "node_minor=0"
for /f "tokens=1,2 delims=." %%A in ('node -p "process.versions.node"') do (
  set "node_major=%%A"
  set "node_minor=%%B"
)
if %node_major% LSS 22 goto node_too_old
if %node_major% EQU 22 if %node_minor% LSS 12 goto node_too_old
goto node_version_ok

:node_too_old
  echo [Clash Verge Kit] 需要 Node.js 22.12.0 或更高版本。
  pause >nul
  exit /b 1

:node_version_ok

if exist "%~dp0dist\cli\cli.mjs" goto run_cli

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [Clash Verge Kit] 首次运行需要构建，但未找到 npm。
  echo 请先安装项目依赖，再运行 npm.cmd run build:cli。
  pause >nul
  exit /b 1
)

echo [Clash Verge Kit] 首次运行，正在构建 CLI...
call npm.cmd run build:cli
set "exit_code=%errorlevel%"
if not "%exit_code%"=="0" (
  echo.
  echo [Clash Verge Kit] CLI 构建失败。请先运行 npm.cmd ci，再运行 npm.cmd run build:cli 查看错误。
  pause >nul
  exit /b %exit_code%
)

if not exist "%~dp0dist\cli\cli.mjs" (
  echo [Clash Verge Kit] 构建结束，但没有找到 dist\cli\cli.mjs。
  pause >nul
  exit /b 1
)

:run_cli
node "%~dp0dist\cli\cli.mjs"
set "exit_code=%errorlevel%"
if not "%exit_code%"=="0" (
  echo.
  echo [Clash Verge Kit] CLI 运行失败，按任意键关闭窗口。
  pause >nul
)
exit /b %exit_code%
