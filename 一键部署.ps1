<#
.SYNOPSIS
  DSH Fleet 一键部署：起主控端 + 生成被控端安装包 + 给出接入命令

.DESCRIPTION
  在"主控端"那台机器上运行。做这些事：
    1. 检查 Node.js
    2. 首次启动主控端（自动生成口令与登记钥匙）
    3. 配模型 Key（可选，不给就是模拟模式）
    4. 放行防火墙 7800（-Firewall，需要管理员）
    5. 用当前 IP + 新登记钥匙重新打包被控端
    6. 打印面板地址 / 口令 / 一行接入命令
    7. 写一份 部署信息.txt 到项目根目录

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File 一键部署.ps1

.EXAMPLE
  # 全自动：给 Key、打 exe、装插件、放行防火墙
  powershell -ExecutionPolicy Bypass -File 一键部署.ps1 -ApiKey sk-xxx -WithPlugin -Firewall
#>
[CmdletBinding()]
param(
  [string]$ApiKey,
  [string]$ControlUrl,
  [int]$Port = 7800,
  [switch]$SkipExe,
  [switch]$SkipBuild,
  [switch]$WithPlugin,
  [string]$ProfileDir,
  [switch]$Firewall,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
if (-not (Test-Path (Join-Path $Root '主控端\server.mjs'))) {
  $Root = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path (Join-Path $Root '主控端\server.mjs'))) {
  throw "找不到 主控端\server.mjs —— 请把本脚本放在项目根目录（含 主控端 与 被控端 两个文件夹）"
}

$MainDir = Join-Path $Root '主控端'
$NodeDir = Join-Path $Root '被控端'
$DataDir = Join-Path $MainDir 'data'
$ServerJs = Join-Path $MainDir 'server.mjs'
$KeyFile = Join-Path $MainDir 'upstream-key.txt'

function Step($n, $text) { Write-Host ''; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    [ok] $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    [!] $text" -ForegroundColor Yellow }
function Die($text) { Write-Host "    [x] $text" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. Node
Step 1 '检查 Node.js'
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Die '没找到 node。先装：winget install OpenJS.NodeJS.LTS ，装完重开窗口再跑本脚本'
}
$verText = (& node --version).Trim()
$major = [int](($verText -replace '^v', '') -split '\.')[0]
if ($major -lt 18) { Die "Node 版本太低（$verText），需要 18 以上" }
Ok "node $verText"

# ---------------------------------------------------------------- 2. 启动主控端
Step 2 "启动主控端（端口 $Port）"
$running = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($running) {
  Ok "端口 $Port 已经有服务在跑（pid $($running[0].OwningProcess)），跳过启动"
} elseif ($NoStart) {
  Warn 'NoStart 已指定，不启动服务'
} else {
  $vbs = Join-Path $MainDir 'service\run-server.vbs'
  if (Test-Path $vbs) {
    Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList ('//nologo "' + $vbs + '"') -WindowStyle Hidden
  } else {
    Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $MainDir -WindowStyle Hidden
  }
  $ok2 = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 700
    try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $ok2 = $true; break } } catch {}
  }
  if ($ok2) { Ok '服务已启动' } else { Warn '服务没起来，稍后手动看 server.out.log' }
}

# ---------------------------------------------------------------- 3. 口令与钥匙
Step 3 '读取口令与登记钥匙'
if (-not (Test-Path (Join-Path $DataDir 'password.txt'))) { Die "没找到 data\password.txt，说明服务没成功启动过" }
$Password = (Get-Content (Join-Path $DataDir 'password.txt') -Raw).Trim()
$Enroll = (Get-Content (Join-Path $DataDir 'enroll-key.txt') -Raw).Trim()
Ok "口令：$Password"
Ok "登记钥匙：$Enroll"

# ---------------------------------------------------------------- 4. 模型 Key
Step 4 '配置模型 Key'
if (Test-Path $KeyFile) {
  Ok ('已配置：' + (Get-Content $KeyFile -Raw).Trim().Substring(0, 6) + '…')
} elseif ($ApiKey) {
  [System.IO.File]::WriteAllText($KeyFile, $ApiKey.Trim(), (New-Object System.Text.UTF8Encoding($false)))
  Ok '已写入 upstream-key.txt（重启服务后生效）'
} else {
  Warn '没有模型 Key —— AI 会跑在模拟模式（命令照样真执行，结论是模板）'
  $typed = Read-Host '    现在粘贴 Key（直接回车跳过）'
  if ($typed.Trim()) {
    [System.IO.File]::WriteAllText($KeyFile, $typed.Trim(), (New-Object System.Text.UTF8Encoding($false)))
    Ok '已写入 upstream-key.txt'
  }
}

# ---------------------------------------------------------------- 5. 地址
Step 5 '确定主控端地址'
if (-not $ControlUrl) {
  $cand = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
    Sort-Object -Property @{ Expression = { if ($_.IPAddress -like '192.168.*') { 0 } elseif ($_.IPAddress -like '10.*') { 1 } else { 2 } } }
  $ip = if ($cand) { $cand[0].IPAddress } else { '127.0.0.1' }
  $ControlUrl = "http://${ip}:$Port"
  Ok "自动探测：$ControlUrl"
} else {
  Ok "使用指定地址：$ControlUrl"
}

# ---------------------------------------------------------------- 6. 防火墙
Step 6 '防火墙'
if ($Firewall) {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Warn '需要管理员才能加防火墙规则，已跳过'
  } else {
    try {
      if (-not (Get-NetFirewallRule -DisplayName 'DSH Fleet' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName 'DSH Fleet' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain | Out-Null
        Ok "已放行 TCP $Port（专用/域网络）"
      } else { Ok '规则已存在' }
    } catch { Warn "加规则失败：$($_.Exception.Message)" }
  }
} else {
  Warn "没放行防火墙。被控端连不上时手动执行：`n        New-NetFirewallRule -DisplayName 'DSH Fleet' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private,Domain"
}

# ---------------------------------------------------------------- 7. 打包被控端
Step 7 '重新打包被控端（用新钥匙）'
if ($SkipBuild) {
  Warn 'SkipBuild 已指定，跳过打包'
} else {
  $builder = Join-Path $NodeDir 'build\build.ps1'
  if (-not (Test-Path $builder)) { Die "找不到 $builder" }
  $target = if ($SkipExe) { 'lite' } else { 'lite-exe' }
  Push-Location (Split-Path $builder)
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $builder -Target $target -ControlUrl $ControlUrl -EnrollKey $Enroll
    if ($LASTEXITCODE -ne 0) { Die "打包失败（返回码 $LASTEXITCODE），看上面的报错。常见原因：build.ps1 编码被破坏、NSIS 没装" }
  } finally { Pop-Location }

  $zip = Join-Path $NodeDir 'dist\_source\lite\payload.zip'
  if (Test-Path $zip) {
    Ok ('payload.zip ' + [math]::Round((Get-Item $zip).Length / 1MB, 1) + ' MB')
    $tmp = Join-Path $env:TEMP ('fleet-enroll-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    & tar.exe -xf $zip -C $tmp 'fleet/enroll.json' 2>$null
    $ej = Join-Path $tmp 'fleet\enroll.json'
    if (Test-Path $ej) {
      $cfg = Get-Content $ej -Raw | ConvertFrom-Json
      if ($cfg.key -eq $Enroll -and $cfg.control -eq $ControlUrl) { Ok '包内钥匙与地址已核对一致' }
      else { Warn "包内不一致：control=$($cfg.control) key=$($cfg.key)" }
    }
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Warn '没生成 payload.zip'
  }
  $exe = Join-Path $NodeDir 'dist\DSH-Fleet-Lite-Setup.exe'
  if (Test-Path $exe) {
    $exeAge = (Get-Item $exe).LastWriteTime
    $zipAge = if (Test-Path $zip) { (Get-Item $zip).LastWriteTime } else { Get-Date }
    Ok ('安装包 ' + [math]::Round((Get-Item $exe).Length / 1MB, 1) + ' MB')
    if ($exeAge -lt $zipAge -and $SkipExe) {
      Warn '安装包比 payload 旧（这次用了 -SkipExe）。要发 exe 给同事的话，去掉 -SkipExe 再跑一次'
    }
  } else {
    Warn '还没生成 exe 安装包 —— 去掉 -SkipExe 再跑一次'
  }
}

# ---------------------------------------------------------------- 8. 插件（可选）
Step 8 'Harness 插件'
if (-not $WithPlugin) {
  Warn '跳过（加 -WithPlugin 可自动安装）'
} else {
  if (-not $ProfileDir) {
    $proc = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*dsh-desktop-host*' } | Select-Object -First 1
    if ($proc -and $proc.CommandLine -match '([A-Za-z]:\\[^\s"]+\\dsh-home\\profiles\\[^\s"]+)') {
      $ProfileDir = $Matches[1]
    }
  }
  if (-not $ProfileDir -or -not (Test-Path $ProfileDir)) {
    Warn '没找到 profile 目录，用 -ProfileDir 指定（例如 ...\dsh-home\profiles\desktop）'
  } else {
    $dst = Join-Path $ProfileDir 'node_modules\dsh-fleet-plugin'
    New-Item -ItemType Directory -Force -Path "$dst\lib" | Out-Null
    Copy-Item (Join-Path $MainDir 'plugin\package.json') $dst -Force
    Copy-Item (Join-Path $MainDir 'plugin\cordis.patch.yml') $dst -Force
    Copy-Item (Join-Path $MainDir 'plugin\lib\index.js') "$dst\lib\" -Force
    Copy-Item (Join-Path $MainDir 'plugin\lib\client.js') "$dst\lib\" -Force

    # 指向本次部署路径
    $idx = Join-Path $dst 'lib\index.js'
    $it = [System.IO.File]::ReadAllText($idx, [System.Text.Encoding]::UTF8)
    $mainEsc = ($MainDir -replace '\\', '\\')
    $it = [regex]::Replace($it, "FLEET_SERVER_DIR \|\| '[^']*'", ("FLEET_SERVER_DIR || '" + $mainEsc + "'"))
    [System.IO.File]::WriteAllText($idx, $it, (New-Object System.Text.UTF8Encoding($false)))

    # package.json：依赖 + bundles
    $pj = Join-Path $ProfileDir 'package.json'
    Copy-Item $pj "$pj.bak-deploy" -Force
    $j = Get-Content $pj -Raw | ConvertFrom-Json
    if ($j.dependencies.PSObject.Properties['dsh-fleet-plugin']) {
      $j.dependencies.'dsh-fleet-plugin' = 'file:' + (Join-Path $MainDir 'plugin')
    } else {
      $j.dependencies | Add-Member -NotePropertyName 'dsh-fleet-plugin' -NotePropertyValue ('file:' + (Join-Path $MainDir 'plugin')) -Force
    }
    if ($j.dsh.profile.bundles -notcontains 'dsh-fleet-plugin') { $j.dsh.profile.bundles += 'dsh-fleet-plugin' }
    [System.IO.File]::WriteAllText($pj, ($j | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))

    # cordis.patch.yml：insert 行
    $cp = Join-Path $ProfileDir 'cordis.patch.yml'
    Copy-Item $cp "$cp.bak-deploy" -Force
    $ct = [System.IO.File]::ReadAllText($cp, [System.Text.Encoding]::UTF8)
    if ($ct -notmatch 'fleet-panel') {
      $ct = $ct.TrimEnd() + "`r`n`r`n- insert:`r`n    - id: fleet-panel`r`n      name: dsh-fleet-plugin`r`n"
      [System.IO.File]::WriteAllText($cp, $ct, (New-Object System.Text.UTF8Encoding($false)))
    }
    Ok "插件已装到 $ProfileDir（备份 *.bak-deploy）"
    Warn '重启 Harness 后生效'
  }
}

# ---------------------------------------------------------------- 9. 汇总
Step 9 '完成'
$joinUrl = "$ControlUrl/join"
$lines = @(
  'DSH Fleet 部署信息',
  ('生成时间：' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
  '',
  ('控制台地址：' + $ControlUrl + '/'),
  ('控制台口令：' + $Password),
  ('登记钥匙：  ' + $Enroll),
  '',
  '给人装（复制这一行到对方的 PowerShell）：',
  ('irm ' + $joinUrl + ' | iex'),
  '',
  ('或把这个文件发给对方双击：' + (Join-Path $NodeDir 'dist\DSH-Fleet-Lite-Setup.exe')),
  '',
  '停止服务：Get-NetTCPConnection -LocalPort ' + $Port + ' -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }'
)
$infoPath = Join-Path $Root '部署信息.txt'
[System.IO.File]::WriteAllText($infoPath, ($lines -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host '================ 部署完成 ================' -ForegroundColor Green
Write-Host ("  控制台   " + $ControlUrl + '/')
Write-Host ("  口令     " + $Password)
Write-Host ("  接入命令 irm " + $joinUrl + " | iex")
Write-Host ("  安装包   " + (Join-Path $NodeDir 'dist\DSH-Fleet-Lite-Setup.exe'))
Write-Host ("  详情已写入 " + $infoPath)
Write-Host '==========================================' -ForegroundColor Green

if (-not $env:DSH_NO_BROWSER) { Start-Process $ControlUrl }
