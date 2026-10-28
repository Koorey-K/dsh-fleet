<#
  修复：给已经装好文件、但没有计划任务的机器补上任务（不需要重装）
  用法：右键 repair-task.cmd → 以管理员身份运行
  参数：
    -InstallDir 自定义安装目录（可选，默认自动找）
    -NoStart    只建任务，不立刻启动
#>
[CmdletBinding()]
param(
  [string]$InstallDir,
  [switch]$NoStart,
  [switch]$TestOnly
)

$ErrorActionPreference = 'Continue'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $TestOnly) {
  Write-Host '需要管理员权限，正在提权...' -ForegroundColor Yellow
  $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
  if ($InstallDir) { $fwd += '-InstallDir'; $fwd += ('"' + $InstallDir + '"') }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $fwd
  exit
}

function Find-InstallDir {
  foreach ($k in 'HKLM:\Software\DSHFleet', 'HKLM:\Software\WOW6432Node\DSHFleet') {
    try { $p = (Get-ItemProperty $k -ErrorAction Stop).InstallDir; if ($p -and (Test-Path (Join-Path $p 'fleet'))) { return $p } } catch {}
  }
  foreach ($k in 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHFleet', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\DSHFleet') {
    try { $p = (Get-ItemProperty $k -ErrorAction Stop).InstallLocation; if ($p -and (Test-Path (Join-Path $p 'fleet'))) { return $p } } catch {}
  }
  foreach ($p in 'C:\Program Files\DSH Fleet', 'C:\Program Files (x86)\DSH Fleet', 'D:\DSH Fleet', 'D:\DSHFleet') {
    if (Test-Path (Join-Path $p 'fleet')) { return $p }
  }
  # 从计划任务反查（如果任务还在但路径变了）
  try {
    $xml = [xml]((& schtasks.exe /query /tn 'DSH Fleet Node' /xml 2>$null) -join "`n")
    $arg = [string]$xml.Task.Actions.Exec.Arguments
    $m = [regex]::Match($arg, '([A-Za-z]:\\[^"]*?)\\run-agent\.vbs')
    if ($m.Success) { return (Split-Path (Split-Path $m.Groups[1].Value -Parent) -Parent) }
  } catch {}
  return $null
}

if (-not $InstallDir) { $InstallDir = Find-InstallDir }
if (-not $InstallDir -or -not (Test-Path (Join-Path $InstallDir 'fleet'))) {
  Write-Host '[x] 找不到安装目录（没有 fleet 子目录）。这台机器上可能没装，重装一次吧。' -ForegroundColor Red
  exit 1
}

$fleet = Join-Path $InstallDir 'fleet'
$cfg = Join-Path $fleet 'fleet.json'
$cmd = Join-Path $fleet 'run-agent.cmd'
$vbs = Join-Path $fleet 'run-agent.vbs'
$wd  = Join-Path $fleet 'watchdog.ps1'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'

Write-Host "安装目录: $InstallDir"
Write-Host "配置: $(if (Test-Path $cfg) { '有' } else { '缺（重装更省事）' })"
Write-Host "启动器: $(if (Test-Path $cmd) { '有' } else { '缺 —— 下面会重建' })"

# 缺启动器就重建（运行时会自动判断是 node.exe 还是 app\DeepSeek Harness.exe）
if (-not (Test-Path $cmd)) {
  $node = Join-Path $InstallDir 'node.exe'
  $app  = Join-Path $InstallDir 'app\DeepSeek Harness.exe'
  $agent = Join-Path $fleet 'agent.mjs'
  if (-not (Test-Path $agent)) { Write-Host '[x] 连 agent.mjs 都没有，重装吧。' -ForegroundColor Red; exit 1 }
  if (Test-Path $node) {
    $launch = '"' + $node + '" "' + $agent + '" >> "' + $fleet + '\logs\stdout.log" 2>&1'
    $envLine = 'rem (node runtime)'
  } elseif (Test-Path $app) {
    $launch = '"' + $app + '" --expose-internals "' + $agent + '" >> "' + $fleet + '\logs\stdout.log" 2>&1'
    $envLine = 'set "ELECTRON_RUN_AS_NODE=1"'
  } else { Write-Host '[x] 没有运行时（node.exe 或 app\DeepSeek Harness.exe）' -ForegroundColor Red; exit 1 }
  $body = "@echo off`r`nsetlocal`r`n$envLine`r`nset `"DSH_PERMISSION_MODE=danger-full-access`"`r`nif not exist `"$fleet\logs`" mkdir `"$fleet\logs`"`r`n$launch`r`n"
  Set-Content -Path $cmd -Value $body -Encoding OEM
  Write-Host '   已重建 run-agent.cmd'
}
if (-not (Test-Path $vbs)) {
  Set-Content -Path $vbs -Value ('CreateObject("WScript.Shell").Run "' + $cmd + '", 0, False') -Encoding OEM
  Write-Host '   已重建 run-agent.vbs'
}

if ($TestOnly) { Write-Host ''; Write-Host '[TestOnly] 跳过任务注册'; exit 0 }
Write-Host ''
Write-Host '注册计划任务...'
Import-Module ScheduledTasks -ErrorAction Stop
$act = New-ScheduledTaskAction -Execute $wscript -Argument ('//nologo "{0}"' -f $vbs) -WorkingDirectory $fleet
$trg = New-ScheduledTaskTrigger -AtStartup
try { $trg.Delay = 'PT30S' } catch {}
$prn = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'DSH Fleet Node' -Action $act -Trigger $trg -Settings $set -Principal $prn -Force | Out-Null

if (Test-Path $wd) {
  $wdAct = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $wd) -WorkingDirectory $fleet
  $wdTrg = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  Register-ScheduledTask -TaskName 'DSH Fleet Watchdog' -Action $wdAct -Trigger $wdTrg -Settings $set -Principal $prn -Force | Out-Null
}

& schtasks.exe /query /tn 'DSH Fleet Node' 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host '[x] 任务还是没建成，检查是不是安全软件拦了。' -ForegroundColor Red; exit 1 }
Write-Host '   [ok] DSH Fleet Node 已注册' -ForegroundColor Green

if (-not $NoStart) {
  Write-Host ''
  Write-Host '启动代理...'
  & schtasks.exe /run /tn 'DSH Fleet Node' 2>&1 | Out-Null
  Start-Sleep -Seconds 6
  $log = Join-Path $fleet 'logs\agent.log'
  if (Test-Path $log) { Get-Content $log -Tail 5 -Encoding UTF8 | ForEach-Object { Write-Host "   $_" } }
  else { Write-Host '   还没有 agent.log —— 再等几秒，或看 logs\stdout.log' -ForegroundColor Yellow }
}

Write-Host ''
Write-Host '[完成] 回指挥端面板看节点。' -ForegroundColor Green
