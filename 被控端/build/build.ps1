#Requires -Version 5.1
<#
  DSH Fleet 打包器（唯一入口，替代原来的 4 个脚本）

  用法：
    # 1) 完整包：payload.zip + install.cmd（372MB，节点能自己用 dsh）
    powershell -ExecutionPolicy Bypass -File build.ps1 -Target zip `
      -ControlUrl http://10.0.0.5:7800 -Token <token> -Label "前台-01"

    # 2) 轻量包：只用 node.exe + 代理（33MB，只跑 shell/file）
    powershell -ExecutionPolicy Bypass -File build.ps1 -Target lite `
      -ControlUrl http://10.0.0.5:7800 -Token <token> -Label "前台-01"

    # 3) 单文件安装包 exe（NSIS，约 320MB）
    powershell -ExecutionPolicy Bypass -File build.ps1 -Target exe `
      -ControlUrl http://10.0.0.5:7800 -Token <token> -Label "前台-01"

  通用参数：
    -SkipApp          复用已有 payload\app（改 token/label 时不用重抄 1GB）
    -SourceApp        从哪个已安装的 DSH 复制本体（默认 F:\DeepSeek Harness）
    -NodeExe          轻量包用哪个 node.exe（默认取 DSH 自带的那份）
    -Version          exe 的版本号
    -PfxFile/-PfxPassword   代码签名
#>
[CmdletBinding()]
param(
  [ValidateSet('zip', 'lite', 'exe', 'lite-exe', 'exe-full')][string]$Target = 'zip',
  [string]$ControlUrl,
  [string]$Token,
  [string]$Label = $env:COMPUTERNAME,
  [string]$SourceApp = 'F:\DeepSeek Harness',
  [string]$Version = '1.0.0',
  [string]$NodeExe = '',
  [switch]$SkipApp,
  [string]$EnrollKey,
  [string]$PfxFile,
  [string]$PfxPassword
)

$ErrorActionPreference = 'Stop'
$Build = $PSScriptRoot
$Kit = Split-Path -Parent $Build
$Dist = Join-Path $Kit 'dist'
$Tools = Join-Path $Build 'tools'
New-Item -ItemType Directory -Force -Path $Dist, $Tools | Out-Null

# ------------------------------------------------------------------ helpers

function Write-Utf8([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Copy-Normalized([string]$From, [string]$ToDir) {
  $target = Join-Path $ToDir (Split-Path $From -Leaf)
  if ($From -match '\.(ps1|nsi|nsh)$') {
    $text = [System.IO.File]::ReadAllText($From)
    $text = ($text -replace "`r`n", "`n") -replace "`n", "`r`n"
    [System.IO.File]::WriteAllText($target, $text, (New-Object System.Text.UTF8Encoding($true)))
  } else {
    Copy-Item $From $target -Force
  }
}

function Assert-Targets {
  if (-not $ControlUrl) { throw '需要 -ControlUrl' }
  if (-not $Token -and -not $EnrollKey) { throw '需要 -Token，或给 -EnrollKey 让安装包自助登记' }
}

# 有 -EnrollKey 时：fleet.json 不带 token，改由安装时向指挥端换
function Write-EnrollConfig {
  param([string]$FleetOut, [string]$Control, [string]$LabelText)
  if (-not $EnrollKey) { return }
  Write-Utf8 (Join-Path $FleetOut 'fleet.json') (@{
    control = $Control; token = ''; label = $LabelText; allowShell = $true
    pollSeconds = 25; heartbeatSeconds = 15; maxConcurrent = 2
  } | ConvertTo-Json -Depth 4)
  Write-Utf8 (Join-Path $FleetOut 'enroll.json') (@{ control = $Control; key = $EnrollKey } | ConvertTo-Json)
  Write-Host '  [enroll] 安装包会在目标机上自动换取专属令牌'
}

function New-Payload {
  param([string]$OutDir)

  $appOut = Join-Path $OutDir 'app'
  $fleetOut = Join-Path $OutDir 'fleet'
  New-Item -ItemType Directory -Force -Path $appOut, $fleetOut | Out-Null
  Assert-Targets

  if ($SkipApp -and (Test-Path (Join-Path $appOut 'DeepSeek Harness.exe'))) {
    Write-Host '  [payload] 复用已有 app（-SkipApp）'
  } else {
    if (-not (Test-Path (Join-Path $SourceApp 'DeepSeek Harness.exe'))) { throw "源目录不对: $SourceApp" }
    Write-Host '  [payload] 复制应用本体（约 1GB，几分钟）…'
    $xd = (@(
        (Join-Path $SourceApp 'resources\app'),
        (Join-Path $SourceApp 'resources\app.dshpurge-prev')
      ) | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $xf = '"debug.log" "app.asar.rename-pending" "Uninstall DeepSeek Harness.exe"'
    $argLine = '"{0}" "{1}" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /MT:8 /XD {2} /XF {3}' -f $SourceApp, $appOut, $xd, $xf
    $robo = Start-Process -FilePath 'robocopy.exe' -ArgumentList $argLine -Wait -PassThru -NoNewWindow
    if ($robo.ExitCode -ge 8) { throw "robocopy 失败 code=$($robo.ExitCode)" }
  }

  Write-Host '  [payload] 放入代理与脚本'
  foreach ($f in 'agent.mjs', 'install.ps1', 'uninstall.ps1', 'watchdog.ps1', 'run-local.cmd') {
    Copy-Normalized (Join-Path $Kit $f) $fleetOut
  }

  $cfg = [ordered]@{
    control          = $ControlUrl.TrimEnd('/')
    token            = $Token
    label            = $Label
    allowShell       = $true
    pollSeconds      = 25
    heartbeatSeconds = 15
    maxConcurrent    = 2
  }
  Write-Utf8 (Join-Path $fleetOut 'fleet.json') ($cfg | ConvertTo-Json -Depth 4)
  Write-EnrollConfig -FleetOut $fleetOut -Control $cfg.control -LabelText $cfg.label
  Write-Utf8 (Join-Path $fleetOut 'fleet-patch.yml') @"
# 模型请求只走指挥端网关；被控端只持有节点令牌
- id: llm-deepseek
  config:
    baseURL: $($cfg.control)/llm
"@
  return $OutDir
}

function New-PortableZip {
  param([string]$PayloadDir, [string]$OutDir, [string]$Title)

  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
  $zip = Join-Path $OutDir 'payload.zip'
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Write-Host "  [zip] 压缩 → $zip"
  & tar.exe -a -c -f $zip -C $PayloadDir .
  if ($LASTEXITCODE -ne 0) { throw "tar 打包失败 code=$LASTEXITCODE" }

  Copy-Item (Join-Path $Build 'install-cmd.template') (Join-Path $OutDir 'install.cmd') -Force
  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host "  [ok] $OutDir  →  payload.zip $mb MB + install.cmd"
}

function New-LitePayload {
  $exe = $NodeExe
  if (-not $exe) {
    $exe = Join-Path $SourceApp 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  }
  if (-not (Test-Path $exe)) {
    throw "找不到 node.exe：$exe`n用 -NodeExe 指定，或从 https://nodejs.org/dist/ 下 win-x64 zip 取 node.exe"
  }

  $lite = Join-Path $Kit 'payload-lite'
  $fleetOut = Join-Path $lite 'fleet'
  if (Test-Path $lite) { Remove-Item $lite -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $fleetOut | Out-Null
  Assert-Targets

  Write-Host '  [lite] 组装 node.exe + 代理'
  Copy-Item $exe (Join-Path $lite 'node.exe') -Force
  foreach ($f in 'agent.mjs', 'install.ps1', 'uninstall.ps1', 'watchdog.ps1', 'run-local.cmd') {
    Copy-Normalized (Join-Path $Kit $f) $fleetOut
  }
  $cfg = [ordered]@{
    control          = $ControlUrl.TrimEnd('/')
    token            = $Token
    label            = $Label
    allowShell       = $true
    pollSeconds      = 25
    heartbeatSeconds = 15
    maxConcurrent    = 2
  }
  Write-Utf8 (Join-Path $fleetOut 'fleet.json') ($cfg | ConvertTo-Json -Depth 4)
  Write-EnrollConfig -FleetOut $fleetOut -Control $cfg.control -LabelText $cfg.label
  return $lite
}

function New-IExpressExe {
  param([string]$PayloadDir, [string]$OutFile)

  $src = Join-Path $Dist '_source'
  New-Item -ItemType Directory -Force -Path $src | Out-Null
  $zip = Join-Path $src 'payload.zip'
  $cmd = Join-Path $src 'install.cmd'
  if (-not (Test-Path $zip) -or -not (Test-Path $cmd)) {
    New-PortableZip -PayloadDir $PayloadDir -OutDir $src
  } else {
    Write-Host "  [iex] 复用 $zip"
  }

  $sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$OutFile
FriendlyName=DSH Fleet Node
AppLaunched=install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=install.cmd /S
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0="payload.zip"
FILE1="install.cmd"
[SourceFiles]
SourceFiles0=$src\
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
  $sedPath = Join-Path $src 'iexpress.sed'
  Set-Content -Path $sedPath -Value $sed -Encoding ASCII

  Write-Host '  [iex] 打包单文件 exe（约 5 分钟，IExpress）…'
  $p = Start-Process -FilePath 'iexpress.exe' -ArgumentList '/N', '/Q', $sedPath -Wait -PassThru -WindowStyle Hidden
  if ($p.ExitCode -ne 0 -or -not (Test-Path $OutFile)) { throw "iexpress 失败 code=$($p.ExitCode)" }
  Write-Host ("  [ok] {0}  ({1:N0} MB)" -f $OutFile, ((Get-Item $OutFile).Length / 1MB))
}
function New-ExeInstaller {
  param([string]$PayloadDir, [string]$NsiFile = 'installer.nsi', [string]$OutputExe = 'DSH-Fleet-Setup.exe')

  $makensis = Get-ChildItem $Tools -Recurse -Filter 'makensis.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $makensis) {
    Write-Host '  [exe] 下载 NSIS 3.10 …'
    $zipPath = Join-Path $Tools 'nsis.zip'
    $url = 'https://downloads.sourceforge.net/project/nsis/NSIS%203/3.10/nsis-3.10.zip'
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    $ok = $false
    try {
      & curl.exe -L --fail --retry 3 -o $zipPath $url
      $b = [System.IO.File]::ReadAllBytes($zipPath)
      $ok = ($b.Length -gt 100000 -and $b[0] -eq 0x50 -and $b[1] -eq 0x4B)
    } catch { $ok = $false }
    if (-not $ok) {
      Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing -TimeoutSec 300
      $b = [System.IO.File]::ReadAllBytes($zipPath)
      $ok = ($b.Length -gt 100000 -and $b[0] -eq 0x50 -and $b[1] -eq 0x4B)
    }
    if (-not $ok) { throw "NSIS 下载失败（拿到的是网页）。手动下载 $url 解压到 $Tools 后重跑。" }
    Expand-Archive -Path $zipPath -DestinationPath $Tools -Force
    $makensis = Get-ChildItem $Tools -Recurse -Filter 'makensis.exe' | Select-Object -First 1
  }

  $cfgText = @(
    '# auto-generated',
    "!define CONTROL_URL `"$($ControlUrl.TrimEnd('/'))`"",
    "!define NODE_LABEL  `"$Label`"",
    "!define BUILD_VERSION `"$Version`""
  ) -join "`r`n"
  Set-Content -Path (Join-Path $Build 'installer-config.nsh') -Value $cfgText -Encoding UTF8
  # 重写成 UTF-8 BOM，makensis 才认中文/正确解析
  $nsh = Join-Path $Build 'installer-config.nsh'
  [System.IO.File]::WriteAllText($nsh, [System.IO.File]::ReadAllText($nsh, [System.Text.Encoding]::UTF8), (New-Object System.Text.UTF8Encoding($true)))
  $nsi = Join-Path $Build $NsiFile
  [System.IO.File]::WriteAllText($nsi, [System.IO.File]::ReadAllText($nsi, [System.Text.Encoding]::UTF8), (New-Object System.Text.UTF8Encoding($true)))

  Write-Host '  [exe] 编译（几分钟）…'
  $log = Join-Path $Dist 'makensis.log'
  $p = Start-Process -FilePath $makensis.FullName -ArgumentList '/V3', $nsi -Wait -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  if ($p.ExitCode -ne 0) {
    Get-Content $log -Tail 15
    Get-Content "$log.err" -Tail 15 -ErrorAction SilentlyContinue
    throw "makensis 失败 code=$($p.ExitCode)。若是 error creating mmap：32 位 makensis 的地址空间限制，改用 -Target zip 或 -Target lite。"
  }
  $exe = Join-Path $Dist $OutputExe
  if (-not (Test-Path $exe)) { throw "没有生成 $OutputExe" }

  if ($PfxFile) {
    $signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
    if ($signtool) {
      & $signtool sign /fd SHA256 /f $PfxFile /p $PfxPassword /tr http://timestamp.digicert.com /td SHA256 $exe
      Write-Host '  [ok] 已签名'
    } else {
      Write-Warning '找不到 signtool.exe，跳过签名'
    }
  }
  Write-Host ("  [ok] {0}  ({1:N0} MB)" -f $exe, ((Get-Item $exe).Length / 1MB))
}

# ------------------------------------------------------------------- driver

Write-Host "DSH Fleet 打包  target=$Target  node=$env:COMPUTERNAME"
switch ($Target) {
  'zip' {
    $payload = New-Payload -OutDir (Join-Path $Kit 'payload')
    New-PortableZip -PayloadDir $payload -OutDir (Join-Path $Dist '_source') -Title 'full'
  }
  'exe-full' {
    $payload = New-Payload -OutDir (Join-Path $Kit 'payload')
    New-IExpressExe -PayloadDir $payload -OutFile (Join-Path $Dist 'DSH-Fleet-Setup.exe')
  }
  'lite' {
    $lite = New-LitePayload
    New-PortableZip -PayloadDir $lite -OutDir (Join-Path $Dist '_source\lite') -Title 'lite'
  }
  'exe' {
    $payload = New-Payload -OutDir (Join-Path $Kit 'payload')
    New-ExeInstaller -PayloadDir $payload
  }
  'lite-exe' {
    $lite = New-LitePayload
    New-ExeInstaller -PayloadDir $lite -NsiFile 'installer-lite.nsi' -OutputExe 'DSH-Fleet-Lite-Setup.exe'
  }
}
Write-Host ''
Write-Host '分发：把 payload.zip 和 install.cmd 放同一目录，目标机双击 install.cmd（静默加 /S）'
