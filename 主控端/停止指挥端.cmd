@echo off
rem Stop the control plane listening on FLEET_PORT (default 7800)
chcp 65001 >nul
setlocal EnableExtensions
if "%FLEET_PORT%"=="" set "FLEET_PORT=7800"
echo Stopping server on port %FLEET_PORT% ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort %FLEET_PORT% -State Listen -ErrorAction SilentlyContinue; if (-not $c) { Write-Host '[i] nothing listening'; exit 0 }; $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host ('[ok] killed pid ' + $_.OwningProcess) }"
pause
