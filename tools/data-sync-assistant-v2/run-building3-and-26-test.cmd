@echo off
cd /d "%~dp0"
"Pms.DataSyncAssistant.V2.exe" --test-building3-controller
exit /b %errorlevel%
