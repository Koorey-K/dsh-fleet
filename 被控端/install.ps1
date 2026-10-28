<#
  安装/注册被控端（可静默）
  用法：
    powershell -ExecutionPolicy Bypass -File install.ps1                    # 读同目录 fleet.json
    powershell -ExecutionPolicy Bypass -File install.ps1 -ControlUrl http://10.0.0.5:7800 -Token <令牌> -Label "前台-01"
  参数：
    -ControlUrl  指挥端根地址（没有 fleet.json 时才需要）
    -Token       指挥端签发的节点令牌（同上）
    -Label       节点备注名
    -Mode        system（默认，SYSTEM 权限 + 开机自启）| user（当前用户）
    -NoStart     注册完不立即启动
    -NoElevate   不自动提权（排错/自测用；此时注册任务会失败但文件照常生成）
#>
[CmdletBinding()]
param(
  [string]$ControlUrl,
  [string]$Token,
  [string]$Label = $env:COMPUTERNAME,
  [ValidateSet('system','user')][string]$Mode = 'system',
  [switch]$NoStart,
  [switch]$NoElevate,
  [string]$EnrollKey
)

$ErrorActionPreference = 'Stop'

# ---- 需要管理员：没有就自己提权重来一遍 ----
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $NoElevate -and $Mode -eq 'system') {
  Write-Host '需要管理员权限，正在提权...（UAC 请点"是"）'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
  foreach ($kv in $PSBoundParameters.GetEnumerator()) {
    if ($kv.Key -eq 'NoElevate') { continue }
    $v = $kv.Value
    if ($v -is [switch]) { if ($v.IsPresent) { $argList += "-$($kv.Key)" } }
    else { $argList += "-$($kv.Key)"; $argList += ('"' + [string]$v + '"') }
  }
  Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList
  exit 0
}
if (-not $isAdmin) { Write-Warning '当前不是管理员：文件会生成，但计划任务/注册表会失败（-NoElevate 模式）' }

$FleetDir   = $PSScriptRoot
$InstallDir = Split-Path -Parent $FleetDir
$AppExe     = Join-Path $InstallDir 'app\DeepSeek Harness.exe'
if (-not (Test-Path $AppExe)) { $AppExe = Join-Path $InstallDir 'DeepSeek Harness.exe' }
$NodeExe    = Join-Path $InstallDir 'node.exe'
$CfgPath    = Join-Path $FleetDir 'fleet.json'

# 运行时二选一：完整 Harness（Electron 即 Node）或轻量 node.exe
if (Test-Path $AppExe) {
  $Runtime = 'electron'
} elseif (Test-Path $NodeExe) {
  $Runtime = 'node'
} else {
  throw "找不到运行时：`n  $AppExe`n  $NodeExe`n（完整包用前者，轻量包用后者）"
}
Write-Host "      运行时: $Runtime  ($(if ($Runtime -eq 'electron') { $AppExe } else { $NodeExe }))"

function Write-Utf8([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host "[1/6] 读取配置 $CfgPath"
$cfg = $null
if (Test-Path $CfgPath) { try { $cfg = ([System.IO.File]::ReadAllText($CfgPath, [System.Text.Encoding]::UTF8)).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { $cfg = $null } }
if (-not $cfg) { $cfg = [pscustomobject]@{} }
if ($ControlUrl) { $cfg | Add-Member -NotePropertyName control -NotePropertyValue $ControlUrl.TrimEnd('/') -Force }
if ($Token)      { $cfg | Add-Member -NotePropertyName token   -NotePropertyValue $Token -Force }
if ($Label)      { $cfg | Add-Member -NotePropertyName label   -NotePropertyValue $Label -Force }
if (-not $cfg.control) { throw '缺少 -ControlUrl（也没有现成的 fleet.json）' }

# 没有令牌就自助登记：安装包里带 enroll.json（control + key），换一个专属令牌
$enrollCfg = Join-Path $FleetDir 'enroll.json'
$enrollKey = $EnrollKey
if (-not $enrollKey -and (Test-Path $enrollCfg)) {
  try {
    $e = ([System.IO.File]::ReadAllText($enrollCfg, [System.Text.Encoding]::UTF8)).TrimStart([char]0xFEFF) | ConvertFrom-Json
    $enrollKey = $e.key
    if (-not $cfg.control -and $e.control) { $cfg | Add-Member -NotePropertyName control -NotePropertyValue $e.control -Force }
  } catch {}
}
if (-not $cfg.token -and $enrollKey) {
  try {
    $body = @{ key = $enrollKey; hostname = $env:COMPUTERNAME; label = $Label } | ConvertTo-Json
    $r = Invoke-RestMethod -Method Post -Uri ($cfg.control.TrimEnd('/') + '/api/agent/enroll') -Body $body -ContentType 'application/json' -TimeoutSec 20
    $cfg | Add-Member -NotePropertyName token -NotePropertyValue $r.token -Force
    Write-Host "      已自动登记：nodeId=$($r.nodeId)"
  } catch {
    Write-Warning "自动登记失败：$($_.Exception.Message)"
  }
}
if (-not $cfg.token) { throw '没有令牌，也没有可用的 enroll.json —— 重装最新安装包，或手动填 token' }

if ($Runtime -eq 'electron') {
  $cfg | Add-Member -NotePropertyName appExe -NotePropertyValue $AppExe -Force
} else {
  # 轻量模式：没有 Harness 本体，dsh 类任务会被代理直接拒绝
  $cfg.PSObject.Properties.Remove('appExe')
}
$cfg | Add-Member -NotePropertyName dshHome  -NotePropertyValue (Join-Path $InstallDir 'dsh-home') -Force
$cfg | Add-Member -NotePropertyName workspace -NotePropertyValue (Join-Path $InstallDir 'work') -Force
$cfg | Add-Member -NotePropertyName allowShell -NotePropertyValue $true -Force
Write-Utf8 $CfgPath ($cfg | ConvertTo-Json -Depth 6)

Write-Host "[2/6] 写模型通道补丁（模型请求只走指挥端网关）"
$patchPath = Join-Path $FleetDir 'fleet-patch.yml'
$llmBase = ($cfg.control -replace '/+$','') + '/llm'
$patch = @"
# 由 install.ps1 生成：把 DeepSeek 的模型通道指向指挥端网关
# 被控端只持有节点令牌，真正的 API Key 只存在指挥端
- id: llm-deepseek
  config:
    baseURL: $llmBase
"@
Write-Utf8 $patchPath $patch

Write-Host "[3/6] 生成隐藏启动器（$Runtime）"
$cmdPath = Join-Path $FleetDir 'run-agent.cmd'
$agentMjs = Join-Path $FleetDir 'agent.mjs'
if ($Runtime -eq 'electron') {
  $launch = '"' + $AppExe + '" --expose-internals "' + $agentMjs + '" >> "' + $FleetDir + '\logs\stdout.log" 2>&1'
  $envLine = 'set "ELECTRON_RUN_AS_NODE=1"'
} else {
  $launch = '"' + $NodeExe + '" "' + $agentMjs + '" >> "' + $FleetDir + '\logs\stdout.log" 2>&1'
  $envLine = 'rem (plain node runtime, no ELECTRON_RUN_AS_NODE needed)'
}
$cmd = @"
@echo off
setlocal
$envLine
set "DSH_HOME=$($cfg.dshHome)"
set "DSH_PERMISSION_MODE=danger-full-access"
if not exist "$($cfg.dshHome)" mkdir "$($cfg.dshHome)"
if not exist "$($cfg.workspace)" mkdir "$($cfg.workspace)"`r`nif not exist "$FleetDir\logs" mkdir "$FleetDir\logs"
$launch
"@
Set-Content -Path $cmdPath -Value $cmd -Encoding OEM

$vbsPath = Join-Path $FleetDir 'run-agent.vbs'
$vbs = @"
CreateObject("WScript.Shell").Run """$cmdPath""", 0, False
"@
Set-Content -Path $vbsPath -Value $vbs -Encoding OEM

Write-Host "[4/6] 设置开机自启（$Mode）"
$who      = if ($Mode -eq 'system') { 'SYSTEM' } else { "$env:USERDOMAIN\$env:USERNAME" }
$wscript  = Join-Path $env:SystemRoot 'System32\wscript.exe'
$watchdog = Join-Path $FleetDir 'watchdog.ps1'
$runCmd   = '"' + $wscript + '" //nologo "' + $vbsPath + '"'

if ($Mode -eq 'user') {
  # 普通同事的电脑大多没有管理员权限：用 HKCU Run 自启，完全不碰任务计划程序
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  New-Item -Path $runKey -Force | Out-Null
  Set-ItemProperty -Path $runKey -Name 'DSHFleet' -Value $runCmd
  Write-Host '      已写入 HKCU Run（登录自启，无需管理员）'

  # 顺手试一下计划任务；失败也不影响（很多公司策略禁止）
  try {
    Import-Module ScheduledTasks -ErrorAction Stop
    $act = New-ScheduledTaskAction -Execute $wscript -Argument ('//nologo "{0}"' -f $vbsPath) -WorkingDirectory $FleetDir
    $trg = New-ScheduledTaskTrigger -AtLogOn -User $who
    $prn = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName 'DSH Fleet Node' -Action $act -Trigger $trg -Settings $set -Principal $prn -Force | Out-Null
    Write-Host '      计划任务也建好了（双保险）'
  } catch {
    Write-Host '      计划任务不可用（策略限制），已用 Run 键代替'
  }
} else {
  # SYSTEM 模式（要有管理员）：用任务计划程序，开机即起
  $taskOk = $false
  try {
    Import-Module ScheduledTasks -ErrorAction Stop
    $act = New-ScheduledTaskAction -Execute $wscript -Argument ('//nologo "{0}"' -f $vbsPath) -WorkingDirectory $FleetDir
    $trg = New-ScheduledTaskTrigger -AtStartup
    try { $trg.Delay = 'PT30S' } catch {}
    $prn = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName 'DSH Fleet Node' -Action $act -Trigger $trg -Settings $set -Principal $prn -Force | Out-Null
    $taskOk = $true

    $wdAct = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $watchdog) -WorkingDirectory $FleetDir
    $wdTrg = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    Register-ScheduledTask -TaskName 'DSH Fleet Watchdog' -Action $wdAct -Trigger $wdTrg -Settings $set -Principal $prn -Force | Out-Null
  } catch {
    if (-not $NoElevate) { throw "注册计划任务失败：$($_.Exception.Message)" }
    Write-Warning "注册计划任务失败（-NoElevate 模式，忽略）：$($_.Exception.Message)"
  }
  if ($taskOk) { Write-Host '      主任务 OK' }
}
Write-Host "[5/6] 写卸载信息"
try {
  $unkey = if ($Mode -eq 'user') { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHFleet' } else { 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHFleet' }
  New-Item -Path $unkey -Force | Out-Null
  Set-ItemProperty $unkey -Name DisplayName     -Value 'DSH Fleet Node'
  Set-ItemProperty $unkey -Name DisplayVersion  -Value '1.0.0'
  Set-ItemProperty $unkey -Name Publisher       -Value 'DSH Fleet'
  Set-ItemProperty $unkey -Name InstallLocation -Value $InstallDir
  Set-ItemProperty $unkey -Name UninstallString -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $FleetDir 'uninstall.ps1')`" -RemoveApp"
  Set-ItemProperty $unkey -Name NoModify -Value 1 -Type DWord
  Set-ItemProperty $unkey -Name NoRepair -Value 1 -Type DWord
} catch {
  if ($NoElevate) { Write-Warning "写注册表失败（-NoElevate 模式，忽略）：$($_.Exception.Message)" } else { throw }
}

Write-Host "[6/6] 启动"
if (-not $NoStart) {
  if ($Mode -eq 'user') {
    Start-Process -FilePath $wscript -ArgumentList ('//nologo "{0}"' -f $vbsPath) -WindowStyle Hidden
  } else {
    & schtasks.exe /run /tn "DSH Fleet Node" 2>$null | Out-Host
  }
  Start-Sleep -Seconds 3
  $p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($p) { Write-Host "已拉起进程 pid=$($p.Id -join ',')" } else { Write-Host '任务已注册，进程可能稍后启动（看 fleet\logs\agent.log）' }
}

Write-Host ''
Write-Host "完成：节点 $Label 已指向 $($cfg.control)"
Write-Host "日志：$FleetDir\logs\agent.log"
