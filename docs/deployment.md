# 部署手册（从零开始）

本文是**从两台全新机器开始**的完整部署流程。赶时间可以直接看[一键部署](#零一键部署推荐)。

---

## 零、一键部署（推荐）

主控端那台机器上：

```powershell
cd F:\dsh-fleet
powershell -ExecutionPolicy Bypass -File 一键部署.ps1 -ApiKey sk-xxx -WithPlugin -Firewall
```

它会依次完成：

| 步骤 | 做什么 |
| --- | --- |
| 1 | 检查 Node.js（要求 ≥ 18） |
| 2 | 启动主控端（已在跑就跳过） |
| 3 | 读取自动生成的控制台口令与登记钥匙 |
| 4 | 写入模型 Key（不给就进模拟模式） |
| 5 | 自动探测内网 IP，拼出对外地址 |
| 6 | 放行防火墙 7800（需管理员，`-Firewall`） |
| 7 | **用当前 IP + 新钥匙重新打包被控端**（关键步骤） |
| 8 | 装 Harness 插件（`-WithPlugin`，自动找 profile 并备份） |
| 9 | 打印面板地址、口令、一行接入命令，并写入 `部署信息.txt` |

参数：

| 参数 | 说明 |
| --- | --- |
| `-ApiKey sk-xxx` | 直接写 Key，不交互 |
| `-ControlUrl http://IP:7800` | 手动指定对外地址 |
| `-Port 7801` | 换端口 |
| `-SkipExe` | 只打 zip（快），但发给同事的 exe 会变旧 |
| `-SkipBuild` | 不打包，只起服务拿凭据 |
| `-WithPlugin` / `-ProfileDir` | 自动装插件 / 指定 profile 目录 |
| `-Firewall` | 自动加防火墙规则 |
| `-NoStart` | 只打包不启动 |

> **为什么必须重新打包**：主控端每次新装都会生成新的登记钥匙，被控端里那把旧钥匙会被 `403 enroll key 不正确` 拒绝。

---

## 一、主控端（手动流程）

### 1.1 准备

- Windows 10 / 11 x64
- Node.js ≥ 18：`winget install OpenJS.NodeJS.LTS`
- 项目放在任意盘，**路径别用中文**（启动器是 `.cmd`，中文路径有编码坑）

### 1.2 启动

```powershell
cd D:\DSHFleet\主控端
node server.mjs
```

或双击 `启动指挥端.cmd`（自动开浏览器）。

首次启动生成：

```
主控端\data\password.txt      控制台口令
主控端\data\enroll-key.txt    登记钥匙（打包被控端要用）
主控端\data\state.json        节点清单
主控端\data\ai\               历史对话（重启后自动恢复）
```

### 1.3 配置模型

```powershell
Set-Content 主控端\upstream-key.txt 'sk-xxxxxxxx'
```

或双击 `主控端\tools\设置APIKey.cmd`。没配也能用：命令照常真执行，结论是模板（模拟模式）。

### 1.4 网络

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' }

New-NetFirewallRule -DisplayName "DSH Fleet" -Direction Inbound -Protocol TCP `
  -LocalPort 7800 -Action Allow -Profile Private,Domain
```

自检：

```powershell
(Invoke-WebRequest http://127.0.0.1:7800/join).StatusCode                       # 200
(Invoke-WebRequest http://127.0.0.1:7800/download/lite.zip -Method Head).StatusCode
```

第二条 404 说明还没打包，见下一节。

### 1.5 后台常驻（可选）

```powershell
# 双击，注册"登录时隐藏启动"，之后不再有黑窗口
主控端\service\安装开机自启.cmd
```

---

## 二、打包被控端

```powershell
cd D:\DSHFleet\被控端\build
powershell -ExecutionPolicy Bypass -File build.ps1 -Target lite `
  -ControlUrl http://192.168.1.50:7800 `
  -EnrollKey (Get-Content ..\..\主控端\data\enroll-key.txt)
```

`-Target` 取值：

| 值 | 产物 | 用途 |
| --- | --- | --- |
| `lite` | `dist\_source\lite\payload.zip`（33 MB） | `/join` 一行命令下载 |
| `lite-exe` | 上面的 + `dist\DSH-Fleet-Lite-Setup.exe` | 发给同事双击 |
| `zip` / `exe` | 完整包（含 Harness 本体，约 370 MB） | 节点要自己跑 DSH 时 |

核对包里的钥匙：

```powershell
tar -xOf D:\DSHFleet\被控端\dist\_source\lite\payload.zip ./fleet/enroll.json
```

---

## 三、被控端

### 3.1 一行命令（免管理员）

```powershell
irm http://192.168.1.50:7800/join | iex
```

### 3.2 安装包

双击 `DSH-Fleet-Lite-Setup.exe` → 下一步 → 完成（会请求管理员，装成 SYSTEM）。

### 3.3 核对

```powershell
Get-Content "$env:LOCALAPPDATA\DSH Fleet\fleet\fleet.json" -Raw
```

- `token` 必须非空
- `label` 应是他自己的计算机名
- `control` 应是你的地址

---

## 四、Harness 插件（可选）

见 [plugin.md](plugin.md)。一键部署时加 `-WithPlugin` 会自动完成前两步，你只需要重启 Harness。

---

## 五、验收清单

| 测什么 | 期望 |
| --- | --- |
| 面板发 `hostname` | 3～5 秒回显对方主机名 |
| 发长命令后点 ■ | **秒级停止**（不是等超时） |
| 发 `截屏` | 面板显示对方屏幕 |
| 重启主控端 | 历史对话还在，未完成任务标为「已中断」 |
| 连错 8 次口令 | 返回 429，10 分钟后再试 |

---

## 六、常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 被控端 `403 enroll key 不正确` | 打包用的旧钥匙 → 重新打包 |
| `/download/lite.zip` 404 | 没打包，或目录结构被改 → 看 `被控端\dist\_source\lite\payload.zip` |
| `irm` 卡住 | 对方访问不到 7800，或安全软件拦下载 → 换 exe |
| 装完列表不出现 | 看 `fleet\logs\agent.log`；多半是网络不通 |
| 命令一直「执行中」 | 对端在跑长命令；180 秒会超时，或点 ■ |
| 插件没按钮 | `cordis.patch.yml` 缺 `insert` 行，或 `SERVER_DIR` 指错，或没完全重启 Harness |
| `build.ps1` 报 `Unexpected token '!define'` | 脚本 BOM 丢了（被编辑器改成无 BOM UTF-8）→ 用记事本另存为「UTF-8 带 BOM」 |
