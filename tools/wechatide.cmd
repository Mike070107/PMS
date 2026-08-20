@echo off
rem 微信开发者工具 Skills CLI 的修正启动器。
rem
rem 官方自带的 wechatide.cmd 用「安装目录下 >50MB 的 exe」来找 Electron，
rem 而 2.01.2601082 这版主程序只有 5MB，所以直接报 "Cannot find Electron executable"。
rem 这里改成直接用工具自带的 node.exe 跑 skill 入口，功能等价。
rem
rem 另需 <安装目录>\dist\wechatide-skill 指向 resources\app.asar.unpacked\wechatide-skill
rem （CLI 只在 dist/ 与 src/skill/ 下找 skill 目录），已用 junction 建好。
rem
rem 用法：tools\wechatide.cmd -c ClaudeCode <toolName> [flags...]

setlocal
set "IDE_DIR=C:\Program Files (x86)\Tencent\微信web开发者工具"
set "SKILL_CLI=%IDE_DIR%\resources\app.asar.unpacked\js\common\cli\skill-index.js"

if not exist "%IDE_DIR%\node.exe" (
  echo ERROR: 未找到 %IDE_DIR%\node.exe，请确认开发者工具安装路径
  exit /b 1
)
if not exist "%SKILL_CLI%" (
  echo ERROR: 未找到 skill-index.js，当前版本可能不带 Skills 组件
  exit /b 1
)

"%IDE_DIR%\node.exe" "%SKILL_CLI%" %*
endlocal
