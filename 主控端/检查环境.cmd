@echo off
rem Environment / health check for the DSH Fleet control plane.
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
if "%FLEET_PORT%"=="" set "FLEET_PORT=7800"

echo ============================================
echo  DSH Fleet control check
echo  folder : %~dp0
echo ============================================
echo.

echo [1] node.exe
where node 2>nul
if errorlevel 1 (echo     [x] node not found in PATH) else (node --version)
echo.

echo [2] files
if exist "server.mjs" (echo     [ok] server.mjs) else (echo     [x] server.mjs missing)
if exist "panel.html" (echo     [ok] panel.html) else (echo     [x] panel.html missing)
if exist "data\password.txt" (echo     [ok] data\password.txt) else (echo     [!] password file not created yet - it appears on first start)
if exist "upstream-key.txt" (echo     [ok] upstream-key.txt) else (echo     [!] upstream-key.txt missing - AI runs in MOCK mode)
echo.

echo [3] port %FLEET_PORT%
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort %FLEET_PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { '     [ok] listening, pid ' + ($c[0].OwningProcess) } else { '     [x] nothing listening - run the launcher' }"
echo.

echo [4] HTTP check
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest ('http://127.0.0.1:' + %FLEET_PORT% + '/') -UseBasicParsing -TimeoutSec 5; '     [ok] HTTP ' + $r.StatusCode + ' (' + $r.RawContentLength + ' bytes)' } catch { '     [x] ' + $_.Exception.Message }"
echo.

echo [5] last lines of server log
if exist "server.out.log" (powershell -NoProfile -Command "Get-Content 'server.out.log' -Tail 6 -Encoding UTF8") else (echo     (no server.out.log yet^))
echo.
pause
