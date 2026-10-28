@echo off
chcp 65001 >nul
setlocal
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs -PassThru; if ($p) { $p.WaitForExit() }"
  exit /b
)
echo 停止并移除计划任务…
schtasks /end /tn "DSH Fleet Server" >nul 2>&1
schtasks /delete /tn "DSH Fleet Server" /f
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 7800 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
echo [完成]
pause
