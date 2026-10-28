# DSH Fleet

**一句话远程运维台**：你在自己的电脑上打一句人话（"看看 C 盘哪些目录最占空间"），AI 会在同事那台电脑上自己跑命令、看结果、给结论。

- **主控端**：零依赖 Node 服务 + 网页面板 + Harness 插件（Key 只存在这里）
- **被控端**：零依赖 Node 代理，33 MB 单文件安装包，**免管理员、免配置、自动登记**
- 模型：DeepSeek（function calling）

> 定位：小团队 / IT 支持 / 帮同事修电脑。不是 RMM 平台，也不是木马。

---

## 它解决什么问题

| 以前 | 现在 |
| --- | --- |
| TeamViewer 连过去，一步步手点 | 说一句"清一下临时目录，告诉我释放了多少" |
| 让他截图给你看 | 直接拉进程 / 磁盘 / 服务列表，或一句 `截屏` |
| 让他找文件再传 | 直接从他那台机器取回文件 |

---

## 架构

```
┌──────────────────────────────┐        ┌───────────────────────────┐
│  主控端\                     │        │  被控端\                  │
│  ├─ server.mjs  零依赖       │◀──────▶│  ├─ agent.mjs  零依赖      │
│  ├─ panel.html  网页面板     │ 长轮询  │  ├─ install.ps1           │
│  ├─ plugin\     Harness 插件 │ 令牌鉴权│  ├─ uninstall.ps1         │
│  ├─ service\    后台自启     │        │  ├─ watchdog.ps1          │
│  └─ data\       口令/节点/任务│        │  ├─ build\  打包脚本      │
│                              │        │  └─ dist\   安装包        │
│   AI 执行器 → DeepSeek        │        │                           │
│   /llm/* 网关（Key 不进节点）  │        │  只持有节点令牌            │
└──────────────────────────────┘        └───────────────────────────┘
```

AI 在主控端跑，被控端只"领任务、执行、回结果"——所以包能压到 33 MB，换模型也只改主控端。

---

## 一键部署

`powershell
git clone https://github.com/Koorey-K/dsh-fleet.git F:\dsh-fleet
cd F:\dsh-fleet
powershell -ExecutionPolicy Bypass -File 一键部署.ps1 -ApiKey sk-xxx -WithPlugin -Firewall
```

跑完会打印：

```
控制台   http://192.168.1.50:7800/
口令     （自动生成）
接入命令 irm http://192.168.1.50:7800/join | iex
安装包   被控端\dist\DSH-Fleet-Lite-Setup.exe
```

详细流程见 [docs/deployment.md](docs/deployment.md)。

---

## 被控端接入（每台 1 分钟）

```powershell
# 一行命令，免管理员
irm http://<主控端IP>:7800/join | iex
```

或把 `被控端\dist\DSH-Fleet-Lite-Setup.exe` 发过去双击。

装完自动：装到 `%LOCALAPPDATA%\DSH Fleet` → 领专属令牌 → 写登录自启 → 启动。
**对方不用填任何东西，也拿不到 API Key。**

---

## 目录

```
dsh-fleet/
├─ 主控端/                      ← 你自己的电脑
│  ├─ server.mjs                HTTP + AI 执行器 + LLM 网关
│  ├─ panel.html                网页面板（无框架单文件）
│  ├─ data/                     口令、节点、历史任务（不提交）
│  ├─ plugin/                   Harness 插件
│  ├─ service/                  后台常驻 / 开机自启
│  ├─ tools/                    设置 Key、改地址、修任务
│  ├─ 启动指挥端.cmd / 停止指挥端.cmd / 检查环境.cmd
│  └─ 打开控制台.url
│
├─ 被控端/                      ← 要帮忙的电脑
│  ├─ agent.mjs                 代理主体
│  ├─ install.ps1 / uninstall.ps1 / watchdog.ps1
│  ├─ run-local.cmd             前台自测
│  ├─ build/                    打包脚本
│  └─ dist/                     安装包产物
│
├─ docs/                        文档
├─ 一键部署.ps1                  ← 部署入口
├─ CHANGELOG.md  SECURITY.md  LICENSE  README.md
```

---

## 能力

| 能力 | 说明 |
| --- | --- |
| 自然语言驱动 | 模型自己决定跑哪条 PowerShell，多步执行后给结论（最多 40 步） |
| **停止即杀** | 点 ■ 立刻向对端下发 `cancel`，`taskkill /T /F` 杀进程树（实测 277 ms） |
| 实时输出 | 命令执行中的输出边跑边显示 |
| 计划模式 | API 层支持 `/api/ai/plan` 先出计划再确认执行（面板未启用按钮） |
| 会话历史 | 选中机器自动回填最近 10 条；主控端重启后仍可查 |
| 节点管理 | 备注名（双击改）、搜索、在线状态、磁盘余量、冻结、远程卸载 |
| 远程截屏 | 发 `截屏` 直接看到对方屏幕 |
| 取文件 | 指定远端路径直接下载 |
| 自愈 | 登录自启、看门狗守护、命令 180 秒超时、任务恢复 |
| 安全 | 每节点独立令牌（只存哈希）、登录限速、冻结 / 吊销 / 远程自毁 |
| 模拟模式 | 没配 Key 也能跑真实命令，只是结论是模板 |

---

## 配置（环境变量）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FLEET_PORT` | `7800` | 端口 |
| `FLEET_HOST` | `0.0.0.0` | 监听地址 |
| `FLEET_PASSWORD` | 文件生成 | 控制台口令 |
| `UPSTREAM_API_KEY` | 空 | 模型 Key（空=模拟模式） |
| `AI_MODEL` | `deepseek-chat` | 模型 |
| `AI_MAX_STEPS` | `40` | 单任务最多步数 |
| `AI_TASK_TIMEOUT_MS` | `120000` | 单条命令等待上限 |
| `AI_OUTPUT_LIMIT` / `AI_LIVE_LIMIT` | 8000 / 20000 | 回给模型 / 给面板的输出上限 |
| `MAX_TASKS` | `2000` | 任务记录保留条数 |

---

## 文档

| 文档 | 内容 |
| --- | --- |
| **[docs/原理.md](docs/原理.md)** | **这套东西怎么运转：三角色、AI 循环、停止即杀、数据流** |
| **[docs/使用说明.md](docs/使用说明.md)** | **日常怎么用：面板、接入新机器、常见问题、卸载** |
| [docs/deployment.md](docs/deployment.md) | 从零部署：一键脚本、手动流程、打包、验收 |
| [docs/installation.md](docs/installation.md) | 安装细节：参数表、权限模式、批量分发、排错 |
| [docs/agent.md](docs/agent.md) | 被控端：工作方式、fleet.json、任务类型、自启、热更新 |
| [docs/api.md](docs/api.md) | HTTP 接口清单 |
| [docs/plugin.md](docs/plugin.md) | Harness 插件安装与排错 |
| [docs/接入新电脑.md](docs/接入新电脑.md) | 给同事看的一页纸 |
| [CHANGELOG.md](CHANGELOG.md) | 更新日志 |
| [SECURITY.md](SECURITY.md) | 安全模型与部署建议 |

---

## 安全

这是**远程命令执行**工具，能力等于对方机器上的一个 shell。只在自己的或明确授权的设备上使用，建议部署在内网 / VPN 内。详见 [SECURITY.md](SECURITY.md)。

---

## License

MIT
