# 上传到 GitHub（一次就好）
# 用法：右键此文件 →「使用 PowerShell 运行」
# 需要准备：一个 GitHub 个人访问令牌（ghp_ 开头，权限勾 repo）

$ErrorActionPreference = 'Stop'
$env:Path = "C:\Program Files\Git\cmd;" + $env:Path
$repoDir = 'F:\dsh-fleet'

Write-Host ''
Write-Host '=== DSH Fleet 上传助手 ===' -ForegroundColor Cyan
Write-Host ''

# 1) 仓库地址
$url = Read-Host '粘贴你的仓库地址（形如 https://github.com/用户名/dsh-fleet.git）'
if (-not $url) { Write-Host '没给地址，退出'; exit 1 }
$url = $url.Trim()

# 2) 令牌
Write-Host ''
Write-Host '令牌在哪拿：https://github.com/settings/tokens → Generate new token (classic) → 勾 repo'
$token = Read-Host '粘贴令牌（ghp_ 开头，输入时不显示）' -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token))
if (-not $plain) { Write-Host '没给令牌，退出'; exit 1 }

# 3) 拼带凭据的地址（只在这次 push 用，不写进配置）
$user = ($url -replace '^https://', '') -replace '\.git$', ''
$user = ($user -split '/')[1]
$authUrl = $url -replace '^https://', ("https://" + $user + ':' + $plain + '@')

Set-Location $repoDir
Write-Host ''
Write-Host '正在推送…（首次会传 4~5 MB，几十秒）'

git remote remove origin 2>$null
git remote add origin $authUrl
git push -u origin main

# 4) 推完把 origin 改回干净地址，避免令牌留在 .git/config
git remote set-url origin $url
Write-Host ''
Write-Host ('完成：' + $url) -ForegroundColor Green
Write-Host '（origin 已改回不带令牌的地址）'
Write-Host ''
Read-Host '按回车关闭'
