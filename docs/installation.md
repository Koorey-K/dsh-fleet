# 安装与部署

本文覆盖两端：**主控端**（你的电脑，跑服务和面板）与**被控端**（要帮忙的那台电脑，跑代理）。

- 支持系统：Windows 10 / 11（x64）
- 主控端依赖：Node.js ≥ 18（被控端包内自带 node.exe，无需安装）

---

## 目录

- [一、主控端](#一主控端)
- [二、被控端](#二被控端)
- [三、权限模式](#三权限模式)
- [四、批量部署](#四批量部署)
- [五、停机与卸载](#五停机与卸载)
- [六、升级](#六升级)
- [七、故障排查](#七故障排查)

---

## 一、主控端

### 1.1 手动启动（最简单）

```powershell
cd F:\dsh-fleet
node 主控端\server.mjs
```

看到下面三行就成功了：

```
DSH Fleet 控制台: http://127.0.0.1:7800/   （口令见 data/password.txt 或 FLEET_PASSWORD）
LLM 网关: 已配置上游 Key -> https://api.deepseek.com/anthropic
监听: 0.0.0.0:7800
```

`LLM 网关: 未配置` 也能用，只是 AI 回答变成模板（模拟模式），命令照样真实执行。

### 1.2 首次启动生成的文件

```
主控端/data/password.txt      控制台登录口令（随机生成）
主控端/data/enroll-key.txt    被控端自助登记钥匙（随机生成）
主控端/data/nodes.json        节点清单（令牌哈希、备注、状态）
主控端/data/tasks/            每次任务的 JSON + 输出日志
```

> 这些都在 `.gitignore` 里，不要提交。

### 1.3 配置模型 Key

三种方式，任选其一：

**① 文件**（最简单）

```powershell
Set-Content 主控端\upstream-key.txt 'sk-xxxxxxxxxxxxxxxx'
```

**② 环境变量**

```powershell
$env:UPSTREAM_API_KEY = 'sk-xxxxxxxx'
node 主控端\server.mjs
```

**③ 双击** `tools\设置APIKey.cmd`，按提示粘贴。

Key 只在主控端使用；被控端的模型请求走主控端的 `/llm/*` 网关，**不会**拿到 Key。

### 1.4 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FLEET_PORT` | `7800` | 监听端口 |
| `FLEET_HOST` | `0.0.0.0` | 监听地址；只在本机用可设 `127.0.0.1` |
| `FLEET_PASSWORD` | 文件生成 | 控制台口令（覆盖 `data/password.txt`） |
| `UPSTREAM_API_KEY` | 空 | DeepSeek Key；空则模拟模式 |
| `UPSTREAM_BASE` | `https://api.deepseek.com/anthropic` | 上游地址（兼容其它 OpenAI/Anthropic 代理） |
| `AI_MODEL` | `deepseek-chat` | 模型名 |
| `AI_MAX_STEPS` | `40` | 单个任务最多执行多少步 |
| `AI_TASK_TIMEOUT_MS` | `120000` | 单条命令等待上限 |
| `ENROLL_KEY` | 文件生成 | 自助登记钥匙 |

### 1.5 后台常驻（不想要黑窗口）

```powershell
# 双击，会自动提权并注册"登录时隐藏启动"
F:\dsh-fleet\service\安装开机自启.cmd
```

之后：

- 登录 Windows 后自动在后台跑，看不到窗口
- 面板入口：双击 `打开控制台.url`
- 停止：`service\卸载开机自启.cmd`

### 1.6 端口与防火墙

被控端要能访问主控端的 `7800`。

```powershell
# 放行专用网络（管理员）
New-NetFirewallRule -DisplayName "DSH Fleet 7800" -Direction Inbound -Protocol TCP -LocalPort 7800 -Action Allow -Profile Private,Domain
```

- 同一局域网：一般直接可用
- 跨网段 / 在家办公：需要 VPN 或端口映射
- 只在 `127.0.0.1` 用：`FLEET_HOST=127.0.0.1`，此时只能用插件/本机面板

查看本机 IP：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' }
```

---

## 二、被控端

### 2.1 方式 A：一行命令（推荐）

在**目标电脑**上打开 PowerShell：

```powershell
irm http://<主控端IP>:7800/join | iex
```

它做的事：

| 步骤 | 说明 |
| --- | --- |
| 1 | 从主控端下载 `payload.zip`（约 33 MB） |
| 2 | 用 `tar.exe` 解压到 `%LOCALAPPDATA%\DSH Fleet` |
| 3 | 调用 `fleet\install.ps1 -Mode user` |
| 4 | 读 `fleet\enroll.json` → `POST /api/agent/enroll` 换专属令牌 |
| 5 | 写入 `HKCU\...\Run\DSHFleet`（登录自启） |
| 6 | 启动代理 |

**不需要管理员**，不弹 UAC。

> 这条命令本身可以直接发微信/邮件；脚本内容可以先用浏览器打开 `http://<IP>:7800/join` 查看。

### 2.2 方式 B：安装包

把 `被控端\dist\DSH-Fleet-Lite-Setup.exe`（约 33 MB）拷过去，双击：

```
欢迎 → 选择目录 → 安装 → 完成
```

- 默认目录 `C:\Program Files\DSH Fleet`，**可以改到别的盘**
- 这种方式会请求管理员（UAC 点"是"），以 SYSTEM 身份运行
- 装完自动登记、自动启动

### 2.3 方式 C：手动解压（排查/特殊场景）

```powershell
# 把 payload.zip 解开到任意目录
Expand-Archive payload.zip -DestinationPath D:\DSHFleet
cd D:\DSHFleet\fleet

# 用户模式（不需要管理员）
powershell -ExecutionPolicy Bypass -File install.ps1 -Mode user -NoElevate

# SYSTEM 模式（需要管理员）
powershell -ExecutionPolicy Bypass -File install.ps1 -Mode system
```

### 2.4 安装参数

| 参数 | 说明 |
| --- | --- |
| `-Mode user\|system` | 用户模式（默认 system） |
| `-ControlUrl` | 主控端地址；没有 `fleet.json` 时需要 |
| `-Token` | 节点令牌；没有 `enroll.json` 时需要 |
| `-EnrollKey` | 自助登记钥匙（覆盖 `enroll.json`） |
| `-Label` | 备注名，默认计算机名 |
| `-NoStart` | 注册完不立即启动 |
| `-NoElevate` | 不自动提权（排错用） |

### 2.5 装完怎么确认

**目标电脑上：**

```powershell
Get-Content "$env:LOCALAPPDATA\DSH Fleet\fleet\logs\agent.log" -Tail 5
# 期望看到：DSH Fleet Agent 1.0.0 启动 node=nxxxx control=http://…
#           heartbeat ok
```

**主控端面板：**

左侧列表 15 秒内出现新机器，绿点在线。名字默认是计算机名，**双击可以改成"张伟-前台"**。

第一次建议发一句：

```
hostname
```

3～5 秒应回显目标机器的主机名。

---

## 三、权限模式

| | 用户模式（`-Mode user`） | SYSTEM 模式（`-Mode system`） |
| --- | --- | --- |
| 需要管理员 | 不需要 | 需要（UAC） |
| 安装位置 | `%LOCALAPPDATA%\DSH Fleet` | `C:\Program Files\DSH Fleet` |
| 自启 | `HKCU\...\Run`（+ 尝试计划任务） | 计划任务（开机，SYSTEM） |
| 能看到 | 当前用户的东西 | 整机（所有用户、服务、驱动） |
| 适合 | 帮同事修电脑、清磁盘、装软件 | 服务器、需要改系统设置 |

**大多数"帮同事看电脑"用用户模式就够，且阻力最小。**

---

## 四、批量部署

### 4.1 共享盘 + 一个 .cmd

把这一行存成 `接入.cmd` 放到共享盘，让同事双击：

```bat
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm http://192.168.16.8:7800/join | iex"
pause
```

### 4.2 组策略 / Intune

- 用启动脚本（GPO Startup Script）或 Intune Platform Script 调 `install.ps1 -Mode system -NoStart`
- 静默安装包：`DSH-Fleet-Lite-Setup.exe /S`

### 4.3 换一批机器时要注意

每台机器**各自登记、各自拿令牌**，互不影响。重复安装不会生成第二个节点（`fleet.json` 里已有 token 就沿用）。

---

## 五、停机与卸载

### 5.1 主控端

```powershell
# 停服务（二选一）
Get-NetTCPConnection -LocalPort 7800 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# 或双击
停止指挥端.cmd
```

### 5.2 被控端

**面板里远程卸载**：点那台机器右侧的 `X`（删任务 + 删目录）。

**目标电脑上本地卸载**（清得更干净）：

```powershell
powershell -File "$env:LOCALAPPDATA\DSH Fleet\fleet\uninstall.ps1" -RemoveApp
```

SYSTEM 模式：

```powershell
powershell -File "C:\Program Files\DSH Fleet\fleet\uninstall.ps1" -RemoveApp
```

---

## 六、升级

| 对象 | 做法 |
| --- | --- |
| 主控端 | 替换 `主控端\server.mjs`、`主控端\panel.html` 后重启；`data\` 保留即可 |
| 被控端 | 面板里点那台机器的 `↻`（推送新代理，自动重启）；或重新跑安装包 |
| 插件 | 覆盖 `主控端\plugin\lib\*` 后重启 Harness |

被控端的热更新走 `/api/agent/bundle`：代理拉取新代码 → 写临时文件 → 自我重启，不需要人工到场。

---

## 七、故障排查

| 症状 | 检查 |
| --- | --- |
| 打不开面板 | `Get-NetTCPConnection -LocalPort 7800 -State Listen`；换端口 `FLEET_PORT=7801` |
| 面板能开，机器不出现 | 目标机能访问主控端吗？`Test-NetConnection <IP> -Port 7800` |
| 机器在线，发指令没反应 | 目标机 `agent.log` 最后几行；可能有长命令占满并发（见 `docs/agent.md` 超时） |
| 提示 `unknown token` | 令牌失效：删掉 `fleet.json` 的 token 字段，重跑 `install.ps1` 重新登记 |
| `irm` 报错 / 下载卡住 | 公司安全软件拦了 PowerShell 下载 → 改用安装包 |
| 装了但不自启 | 用户模式看 `HKCU\...\Run\DSHFleet`；SYSTEM 模式看计划任务 `DSH Fleet Node` |
| 中文输出乱码 | 代理已强制 UTF-8；若是老版本，重新推送代理 |
| 响应很慢 | 先看是不是对端有长命令在跑（面板会显示"执行中"）；命令默认 180 s 超时 |
