<#
  在【被控端】上改指挥端地址 / 换令牌（无需重装）
  会自动在注册表、计划任务、常见目录、磁盘浅层搜索里找安装位置。

  用法：
    powershell -ExecutionPolicy Bypass -File switch-control.ps1 -Control http://192.168.16.8:7800 -Token <令牌>
    powershell -ExecutionPolicy Bypass -File switch-control.ps1            # 交互式
    powershell -ExecutionPolicy Bypass -File switch-control.ps1 -Diagnose   # 只诊断
#>
[CmdletBinding()]
param(
  [string]$Control,
  [string]$Token,
  [string]$FleetJson,
  [switch]$NoRestart,
  [switch]$Diagnose
)

$ErrorActionPreference = 'Continue'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $NoRestart) {
  Write-Host '需要管理员权限，正在提权...' -ForegroundColor Yellow
  $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'))
  if ($Control)   { $fwd += '-Control';   $fwd += ('"' + $Control + '"') }
  if ($Token)     { $fwd += '-Token';     $fwd += ('"' + $Token + '"') }
  if ($FleetJson) { $fwd += '-FleetJson'; $fwd += ('"' + $FleetJson + '"') }
  if ($Diagnose)  { $fwd += '-Diagnose' }
  Start-Process powershell.exe -Verb RunAs -ArgumentList $fwd
  exit
}

function Find-FleetJson {
  $candidates = New-Object System.Collections.Generic.List[string]

  # 1) 注册表（安装时写的 InstallDir / InstallLocation）
  foreach ($key in 'HKLM:\Software\DSHFleet', 'HKLM:\Software\WOW6432Node\DSHFleet') {
    try { $p = (Get-ItemProperty $key -ErrorAction Stop).InstallDir; if ($p) { $candidates.Add((Join-Path $p 'fleet\fleet.json')) } } catch {}
  }
  foreach ($key in 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHFleet', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\DSHFleet') {
    try { $p = (Get-ItemProperty $key -ErrorAction Stop).InstallLocation; if ($p) { $candidates.Add((Join-Path $p 'fleet\fleet.json')) } } catch {}
  }

  # 2) 计划任务里藏着真实路径
  try {
    $xmlText = (& schtasks.exe /query /tn 'DSH Fleet Node' /xml 2>$null) -join "`n"
    if ($xmlText) {
      $xml = [xml]$xmlText
      $exec = $xml.Task.Actions.Exec
      $argText = [string]$exec.Arguments
      $m = [regex]::Match($argText, '([A-Za-z]:\\[^"]*?)\\run-agent\.vbs')
      if ($m.Success) { $candidates.Add((Join-Path $m.Groups[1].Value 'fleet.json')) }
    }
  } catch {}

  # 3) 常见目录
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs", 'C:\', 'D:\', 'E:\', 'F:\')) {
    if (-not $root -or -not (Test-Path $root)) { continue }
    foreach ($name in 'DSH Fleet', 'DSHFleet') { $candidates.Add((Join-Path $root "$name\fleet\fleet.json")) }
  }

  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path } }

  # 4) 兜底：磁盘浅层搜索
  Write-Host '   常规位置没有，正在磁盘浅层搜索（最多 1 分钟）...' -ForegroundColor DarkGray
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, "$env:LOCALAPPDATA\Programs", 'C:\', 'D:\', 'E:\')) {
    if (-not $root -or -not (Test-Path $root)) { continue }
    try {
      $hit = Get-ChildItem $root -Filter 'fleet.json' -Recurse -Depth 4 -File -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -like '*fleet*' } | Select-Object -First 1
      if ($hit) { return $hit.FullName }
    } catch {}
  }
  return $null
}

Write-Host '1) 找 fleet.json ...'
if (-not $FleetJson) { $FleetJson = Find-FleetJson }

if (-not $FleetJson -or -not (Test-Path $FleetJson)) {
  Write-Host ''
  Write-Host '[x] 这台机器上找不到 fleet.json —— 代理没装上。' -ForegroundColor Red
  Write-Host ''
  Write-Host '现状：' -ForegroundColor Yellow
  & schtasks.exe /query /tn 'DSH Fleet Node' 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host '  · 计划任务 DSH Fleet Node：存在（但文件没了，装了一半）' }
  else { Write-Host '  · 计划任务 DSH Fleet Node：不存在' }
  Write-Host ('  · C:\Program Files\DSH Fleet：' + $(if (Test-Path 'C:\Program Files\DSH Fleet') { '存在' } else { '不存在' }))
  $pNode = Get-Process node -ErrorAction SilentlyContinue
  Write-Host ('  · node.exe 进程：' + $(if ($pNode) { '有 ' + $pNode.Count + ' 个（可能不是我们的）' } else { '没有' }))
  Write-Host ''
  Write-Host '三个常见原因：' -ForegroundColor Yellow
  Write-Host '  1. 双击安装包时 UAC 点了「否」/ 直接关掉了弹窗'
  Write-Host '  2. 用的是旧的有 bug 的安装包（双击完全没反应）'
  Write-Host '  3. 当前账号不是管理员，UAC 要输管理员密码，没输'
  Write-Host ''
  Write-Host '解决：用最新的 DSH-Fleet-Lite-Setup.exe 重装，UAC 一定点「是」。' -ForegroundColor Green
  exit 1
}

Write-Host "   [ok] $FleetJson" -ForegroundColor Green
$cfg = ([System.IO.File]::ReadAllText($FleetJson, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)) | ConvertFrom-Json
Write-Host "   control = $($cfg.control)"
Write-Host "   label   = $($cfg.label)"
Write-Host "   token   = $($cfg.token.Substring(0, [Math]::Min(8, $cfg.token.Length)))..."

if ($Diagnose) {
  Write-Host ''
  Write-Host '2) 诊断'
  try { $r = Invoke-WebRequest (($cfg.control).TrimEnd('/') + '/') -UseBasicParsing -TimeoutSec 6; Write-Host "   指挥端可达：HTTP $($r.StatusCode)" -ForegroundColor Green }
  catch { Write-Host "   指挥端不可达：$($_.Exception.Message)" -ForegroundColor Red }
  $log = Join-Path (Split-Path $FleetJson -Parent) 'logs\agent.log'
  if (Test-Path $log) { Write-Host '   日志尾部：'; Get-Content $log -Tail 5 -Encoding UTF8 | ForEach-Object { Write-Host "     $_" } } else { Write-Host '   没有 agent.log（代理没跑起来过）' -ForegroundColor Red }
  exit 0
}

if (-not $Control) { $Control = Read-Host '新的指挥端地址（例：http://192.168.16.8:7800）' }
if (-not $Token)   { $Token   = Read-Host '节点令牌（面板右上「接入令牌」生成的那串）' }
# 容忍"整段 JSON"粘贴（面板「接入令牌」弹的就是这种）
if ($Control -and $Control.TrimStart().StartsWith('{')) {
  try { $j = $Control | ConvertFrom-Json; if ($j.control) { $Control = $j.control }; if (-not $Token -and $j.token) { $Token = $j.token } } catch {}
}
if ($Token -and $Token.TrimStart().StartsWith('{')) {
  try { $j = $Token | ConvertFrom-Json; if ($j.token) { $Token = $j.token }; if (-not $Control -and $j.control) { $Control = $j.control } } catch {}
}
$Control = $Control.Trim().TrimEnd('/')
if ($Token -match '[{}\s]') { Write-Host '[x] 令牌里不该有空格或花括号 —— 你可能贴成了整段 JSON，只需要 token 的值。' -ForegroundColor Red; exit 1 }
if ($Control -notmatch '^https?://') { $Control = 'http://' + $Control }

Write-Host ''
Write-Host '2) 测试连通'
try {
  $r = Invoke-WebRequest ($Control + '/') -UseBasicParsing -TimeoutSec 6
  Write-Host "   [ok] HTTP $($r.StatusCode)" -ForegroundColor Green
} catch {
  Write-Host "   [x] 连不上：$($_.Exception.Message)" -ForegroundColor Red
  Write-Host '       检查地址 / 防火墙 / 是否同一网段'
  if ((Read-Host '   仍要继续改吗？(y/N)') -ne 'y') { exit 1 }
}

Write-Host ''
Write-Host '3) 写配置'
$cfg | Add-Member -NotePropertyName control -NotePropertyValue $Control -Force
$cfg | Add-Member -NotePropertyName token   -NotePropertyValue $Token.Trim() -Force
[System.IO.File]::WriteAllText($FleetJson, ($cfg | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "   control = $Control"
Write-Host "   token   = $($Token.Substring(0, [Math]::Min(8, $Token.Length)))..."

if ($NoRestart) { Write-Host '   （-NoRestart：未重启任务）'; exit 0 }

Write-Host ''
Write-Host '4) 重启代理'
& schtasks.exe /end /tn 'DSH Fleet Node' 2>$null | Out-Null
Start-Sleep -Seconds 2
& schtasks.exe /run /tn 'DSH Fleet Node' 2>$null | Out-Null
Start-Sleep -Seconds 5

$log = Join-Path (Split-Path $FleetJson -Parent) 'logs\agent.log'
if (Test-Path $log) {
  Write-Host ''
  Write-Host '5) 日志尾部'
  Get-Content $log -Tail 4 -Encoding UTF8 | ForEach-Object { Write-Host "   $_" }
}

Write-Host ''
Write-Host '[完成] 回指挥端面板，10 秒内应出现这台机器。' -ForegroundColor Green
