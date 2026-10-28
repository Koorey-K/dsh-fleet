#Requires -RunAsAdministrator
<#
  卸载被控端
    powershell -ExecutionPolicy Bypass -File uninstall.ps1            # 只停服务、删任务
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveApp # 连程序目录一起删
#>
[CmdletBinding()]
param(
  [switch]$RemoveApp,
  [switch]$KillAll
)

$ErrorActionPreference = 'Continue'
$FleetDir   = $PSScriptRoot
$InstallDir = Split-Path -Parent $FleetDir

Write-Host '[1/4] 停止计划任务'
& schtasks.exe /end /tn "DSH Fleet Node" 2>$null | Out-Null
& schtasks.exe /end /tn "DSH Fleet Watchdog" 2>$null | Out-Null

Write-Host '[2/4] 结束代理进程'
$procs = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like '*agent.mjs*' }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if ($KillAll) {
  Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $FleetDir 'agent.lock') -Force -ErrorAction SilentlyContinue

Write-Host '[3/4] 删除任务与注册表'
& schtasks.exe /delete /tn "DSH Fleet Node" /f 2>$null | Out-Null
& schtasks.exe /delete /tn "DSH Fleet Watchdog" /f 2>$null | Out-Null
Remove-Item 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHFleet' -Recurse -Force -ErrorAction SilentlyContinue

if (-not $RemoveApp) {
  Write-Host '[4/4] 保留程序目录（加 -RemoveApp 可一并删除）'
  exit 0
}

Write-Host '[4/4] 删除程序目录'
$cmd = "ping 127.0.0.1 -n 3 >nul & rmdir /s /q `"$InstallDir`""
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WindowStyle Hidden
Write-Host '已排队删除，几秒后目录消失。'
