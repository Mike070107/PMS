@echo off
chcp 65001 >nul
echo ========================================
echo 操作日志定期清理 - Windows计划任务配置
echo ========================================
echo.

REM 设置项目路径
set PROJECT_DIR=%~dp0
set PYTHON_EXE=%PROJECT_DIR%.venv-1\Scripts\python.exe
set SCRIPT_PATH=%PROJECT_DIR%cleanup_logs.py

echo 项目目录: %PROJECT_DIR%
echo Python路径: %PYTHON_EXE%
echo 清理脚本: %SCRIPT_PATH%
echo.

REM 检查Python是否存在
if not exist "%PYTHON_EXE%" (
    echo [错误] 未找到Python虚拟环境，请确认路径: %PYTHON_EXE%
    pause
    exit /b 1
)

REM 检查脚本是否存在
if not exist "%SCRIPT_PATH%" (
    echo [错误] 未找到清理脚本，请确认路径: %SCRIPT_PATH%
    pause
    exit /b 1
)

echo [1] 测试清理脚本是否正常运行...
echo.
"%PYTHON_EXE%" "%SCRIPT_PATH%" 9999
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [错误] 清理脚本执行失败，请检查上方错误信息
    pause
    exit /b 1
)

echo.
echo [2] 创建Windows计划任务...
echo.

REM 删除已存在的任务（如果有）
schtasks /Query /TN "WJWY_LogCleanup" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo 删除已存在的计划任务...
    schtasks /Delete /TN "WJWY_LogCleanup" /F
)

REM 创建计划任务（每月1号凌晨3点执行）
schtasks /Create /SC MONTHLY /D 1 /ST 03:00 /TN "WJWY_LogCleanup" ^
    /TR "\"%PYTHON_EXE%\" \"%SCRIPT_PATH%\" 365" ^
    /RL HIGHEST /F

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo ✓ 计划任务创建成功！
    echo ========================================
    echo.
    echo 任务名称: WJWY_LogCleanup
    echo 执行时间: 每月1号 凌晨3:00
    echo 保留天数: 365天（1年）
    echo.
    echo 可以使用以下命令管理任务：
    echo   - 查看任务: schtasks /Query /TN "WJWY_LogCleanup"
    echo   - 立即运行: schtasks /Run /TN "WJWY_LogCleanup"
    echo   - 删除任务: schtasks /Delete /TN "WJWY_LogCleanup" /F
    echo.
) else (
    echo.
    echo [错误] 计划任务创建失败，错误代码: %ERRORLEVEL%
    echo 请尝试以管理员身份运行此脚本
    echo.
)

pause
