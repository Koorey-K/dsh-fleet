@echo off
rem ============================================================
rem  Repair: create the scheduled tasks for an existing install
rem  (files are there, but the task was never created)
rem  Usage: run as administrator (this script asks for elevation)
rem ============================================================
chcp 65001 >nul
setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo [i] Asking Windows for elevation...
  if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%~f0' -Verb RunAs -PassThru; if ($p) { $p.WaitForExit() }"
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs -PassThru; if ($p) { $p.WaitForExit() }"
  )
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0repair-task.ps1" %*
echo.
pause
