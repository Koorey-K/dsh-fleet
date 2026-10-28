@echo off
rem 直接跑代理（自测用，不装计划任务）
rem 自动适配两种运行时：..\node.exe（轻量包） 或 ..\app\DeepSeek Harness.exe（完整包）
setlocal
set "DSH_PERMISSION_MODE=danger-full-access"
if not exist "%~dp0dsh-home" mkdir "%~dp0dsh-home"
set "DSH_HOME=%~dp0dsh-home"

if exist "%~dp0..\node.exe" (
  "%~dp0..\node.exe" "%~dp0agent.mjs"
  exit /b %errorlevel%
)

if not exist "%~dp0..\app\DeepSeek Harness.exe" (
  echo [x] 找不到运行时：..\node.exe 或 ..\app\DeepSeek Harness.exe
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\app\DeepSeek Harness.exe" --expose-internals "%~dp0agent.mjs"
exit /b %errorlevel%
