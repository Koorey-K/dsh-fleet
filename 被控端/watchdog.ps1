# 看门狗：每 5 分钟由计划任务调用，代理没在跑就拉起来
$ErrorActionPreference = 'SilentlyContinue'
$FleetDir = $PSScriptRoot
$lock = Join-Path $FleetDir 'agent.lock'
$log  = Join-Path $FleetDir 'logs\watchdog.log'

function Write-Wd($msg) {
  if (-not (Test-Path (Split-Path $log))) { New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null }
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  if ((Get-Item $log).Length -gt 1MB) { Move-Item $log "$log.old" -Force }
}

if (-not (Test-Path (Join-Path $FleetDir 'fleet.json'))) { exit 0 }

$alive = $false
if (Test-Path $lock) {
  $pidText = (Get-Content $lock -Raw).Trim()
  if ($pidText -match '^\d+$') {
    $p = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
    if ($p) { $alive = $true }
  }
}

# 锁文件所在进程可能已换皮，再用命令行兜底判断一次
if (-not $alive) {
  $candidate = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*agent.mjs*' }
  if ($candidate) { $alive = $true }
}

if ($alive) { exit 0 }

Write-Wd '代理未运行，重新拉起'
$vbs = Join-Path $FleetDir 'run-agent.vbs'
Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList '//nologo', $vbs -WindowStyle Hidden
