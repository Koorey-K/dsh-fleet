@echo off
chcp 65001 >nul
rem 把指挥端注册成「登录时后台启动」，以后看不到任何黑窗口
setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo [i] 需要管理员权限，正在提权...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs -PassThru; if ($p) { $p.WaitForExit() }"
  exit /b
)

set "HERE=%~dp0"
set "HERE=%HERE:~0,-1%"
set "VBS=%HERE%\run-server.vbs"

echo 注册计划任务：登录时隐藏启动…
schtasks /create /tn "DSH Fleet Server" /tr "\"%SystemRoot%\System32\wscript.exe\" //nologo \"%VBS%\"" /sc onlogon /rl LIMITED /f
if errorlevel 1 (
  echo [x] 注册失败（可能被安全策略拦了）
  pause
  exit /b 1
)

echo 立即启动一次…
schtasks /run /tn "DSH Fleet Server" >nul 2>&1
if errorlevel 1 (
  start "" "%SystemRoot%\System32\wscript.exe" //nologo "%VBS%"
)

timeout /t 4 >nul
echo.
echo [完成] 以后登录 Windows 会自动在后台跑，不会再弹黑窗口。
echo        打开面板：双击 打开控制台.url
echo        停掉：双击 后台服务\卸载开机自启.cmd
pause
