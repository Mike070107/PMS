@echo off
setlocal
set "NEW_EXE=%~dp0Pms.DataSyncAssistant.exe"
set "OLD_EXE=%~dp0..\PMS-LegacySync-0.1.1\Pms.DataSyncAssistant.exe"
if not exist "%OLD_EXE%" (
  echo Cannot find installed assistant: %OLD_EXE%
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%NEW_EXE%' -ArgumentList '--apply-update','%OLD_EXE%','0' -Verb RunAs"
endlocal
