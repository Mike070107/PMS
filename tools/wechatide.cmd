@echo off
rem Project launcher for the WeChat DevTools Skills CLI / MCP server.
rem .mcp.json runs it as:  cmd /c tools\wechatide.cmd mcp
rem
rem KEEP THIS FILE PURE ASCII. cmd.exe parses batch files in the console code page
rem (cp936 here); UTF-8 Chinese bytes get split into garbage commands, even in rem
rem lines, and even with chcp 65001 on the first line (verified 2026-09-04).
rem Chinese notes live in docs/development-workflow.md and the git log.
rem
rem History: the old launcher ran skill-index.js with node.exe from the DevTools
rem install dir because DevTools 2.01 shipped a 5MB main exe and the official
rem wechatide.cmd could not find Electron. DevTools 2.02.2609032 (2026-09-03)
rem removed that node.exe and the dist junction, so MCP died on start
rem (CONNECTION_CLOSED). The new main exe is 200MB and the official script works,
rem so this file only locates the install dir and forwards to it. Do NOT run
rem skill-index.js with the system node: the User Data hash is derived from the
rem executable path and will not match the running IDE, so it never finds the port.
rem
rem In mcp mode we first run "auth -c <client>" (output discarded, stdout must
rem stay clean for MCP): it starts the IDE service port if it is down and returns
rem at once when the client is already trusted. The IDE trusts clients by the
rem MCP clientInfo.name; Claude Code identifies itself as "claude-code" while the
rem Skills CLI uses "ClaudeCode", so both are trusted. An untrusted name gets
rem "Client authorization pending" on initialize and the MCP connection fails.
rem
rem If DevTools is installed elsewhere, set WECHAT_DEVTOOLS_DIR to the folder that
rem contains wechatide.cmd. The default folder name is Chinese, hence the wildcard.

setlocal
set "IDE_DIR=%WECHAT_DEVTOOLS_DIR%"
if defined IDE_DIR if exist "%IDE_DIR%\wechatide.cmd" goto :found
set "IDE_DIR="
for /d %%D in ("%ProgramFiles(x86)%\Tencent\*") do (
  if not defined IDE_DIR if exist "%%~D\wechatide.cmd" set "IDE_DIR=%%~D"
)
if not defined IDE_DIR for /d %%D in ("%ProgramFiles%\Tencent\*") do (
  if not defined IDE_DIR if exist "%%~D\wechatide.cmd" set "IDE_DIR=%%~D"
)
if not defined IDE_DIR (
  echo ERROR: wechatide.cmd not found under Tencent\* in Program Files. Set WECHAT_DEVTOOLS_DIR. 1>&2
  exit /b 1
)

:found
if /i "%~1"=="mcp" (
  call "%IDE_DIR%\wechatide.cmd" auth -c ClaudeCode >nul 2>&1
  call "%IDE_DIR%\wechatide.cmd" auth -c claude-code >nul 2>&1
)
call "%IDE_DIR%\wechatide.cmd" %*
exit /b %ERRORLEVEL%
