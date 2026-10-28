@echo off
rem ============================================================
rem  Switch the control-plane address / token on a NODE machine
rem  Usage:  switch-control.cmd http://192.168.16.8:7800 <token>
rem          switch-control.cmd          (asks interactively)
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
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0switch-control.ps1" %*
echo.
pause
