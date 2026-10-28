@echo off
rem ============================================================
rem  DSH Fleet - control plane launcher
rem  Keep this file ASCII-only (Chinese text in .cmd breaks under
rem  the default codepage and the window closes instantly).
rem ============================================================
chcp 65001 >nul
title DSH Fleet Control
setlocal EnableExtensions
cd /d "%~dp0"

if "%FLEET_PORT%"=="" set "FLEET_PORT=7800"
if "%UPSTREAM_BASE%"=="" set "UPSTREAM_BASE=https://api.deepseek.com/anthropic"
if "%UPSTREAM_API_KEY%"=="" if exist "upstream-key.txt" set /p UPSTREAM_API_KEY=<"upstream-key.txt"

rem --- already running? just open the panel ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort %FLEET_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo [i] Server already running on port %FLEET_PORT%.
  echo [i] Control panel: http://127.0.0.1:%FLEET_PORT%/
  if not "%DSH_NO_BROWSER%"=="1" start "" "http://127.0.0.1:%FLEET_PORT%/"
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)

rem --- first run: ask for the model key (optional) ---
if "%UPSTREAM_API_KEY%"=="" (
  echo.
  echo [i] No UPSTREAM_API_KEY found.
  echo     without it: MOCK mode - commands still run, the summary is canned
  echo     with it   : the AI really thinks and drives the target machine
  echo     Tip: put the key into upstream-key.txt to skip this prompt.
  set /p "UPSTREAM_API_KEY=sk-... : "
)

if not exist "data" mkdir "data"
echo.
echo   Control panel : http://127.0.0.1:%FLEET_PORT%/
echo   Login password: data\password.txt
echo.
echo   Starting server...  ^(close this window to stop it^)
echo.

if not "%DSH_NO_BROWSER%"=="1" start "" "http://127.0.0.1:%FLEET_PORT%/"

node server.mjs
echo.
echo [x] server exited. Press any key to close.
pause >nul
