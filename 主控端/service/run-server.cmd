@echo off
rem 后台启动指挥端（无窗口）。由 run-server.vbs 调用。
rem 用绝对路径，避免中文/百分号在 cmd 里被解析
cd /d "%~dp0.."
set "FLEET_PORT=7800"
if exist "upstream-key.txt" set /p UPSTREAM_API_KEY=<"upstream-key.txt"
node server.mjs >> "server.out.log" 2>&1
