@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion
title DSH Fleet - 设置 API Key

rem 用法：
rem   双击，按提示粘贴；或命令行：设置APIKey.cmd sk-xxxxxxxx
rem 保存位置：control\upstream-key.txt（一行，只有 Key）

if not "%~1"=="" set "KEY=%~1"
if not defined KEY (
  echo.
  echo 把 DeepSeek 的 API Key 粘到下面，回车。
  echo 没有的话去 https://platform.deepseek.com/api_keys 建一个。
  echo.
  set /p KEY=sk-... : 
)
if not defined KEY (
  echo [x] 没输入，取消。
  pause
  exit /b 1
)

>"%~dp0..\upstream-key.txt" echo !KEY!
echo.
echo [ok] 已保存到 control\upstream-key.txt
echo      已写入：!KEY:~0,6!...

rem 如果指挥端正在跑，先停掉
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 7800 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>&1
timeout /t 1 >nul

echo [..] 用新 Key 重启指挥端…
start "" "%~dp0..\启动指挥端.cmd"
timeout /t 4 >nul
echo.
echo [完成] 面板打开后 Ctrl+F5 刷新，然后发一句"检查一下 C 盘有什么大文件"试试。
pause
