# 被控端（agent）说明

被控端是一个**零依赖**的 Node 脚本，负责：领任务 → 执行 → 回结果。它不跑模型，也拿不到 API Key。

---

## 一、它怎么工作

```
              ① 长轮询 /api/agent/poll?wait=25&slots=2
  agent  ──────────────────────────────────────────────▶  control
         ◀──────────────────────────────────────────────
              ② 立刻返回排队的任务（没有任务就挂 25 秒）

              ③ POST /api/agent/result  { code, ms }
  agent  ──────────────────────────────────────────────▶  control

              ④ 每 15 秒 POST /api/agent/heartbeat（主机名/内存/磁盘）
```

特点：

- **出站连接**：被控端不需要开任何入站端口，不需要公网 IP
- **长轮询**：有任务时几乎立即下发（毫秒级），空闲时不空转
- **并发**：默认 2 条任务并行（`maxConcurrent`）
- **令牌鉴权**：每个节点一个独立令牌，服务端只存哈希

---

## 二、安装后长什么样

用户模式（推荐）：

```
%LOCALAPPDATA%\DSH Fleet\
├─ node.exe                    便携 Node（约 89 MB）
├─ dsh-home\                   运行时数据（DSH 模式用）
├─ work\                       工作目录
└─ fleet\
   ├─ agent.mjs                代理主体
   ├─ fleet.json               配置（含本机专属令牌）
   ├─ enroll.json              自助登记钥匙（装完即可删）
   ├─ install.ps1 / uninstall.ps1 / watchdog.ps1
   ├─ run-agent.cmd            启动器（隐藏窗口）
   ├─ run-agent.vbs            wscript 入口
   ├─ run-local.cmd            前台自测用
   └─ logs\
      ├─ agent.log             运行日志
      └─ stdout.log            进程标准输出
```

SYSTEM 模式路径为 `C:\Program Files\DSH Fleet\`，结构相同。

---

## 三、配置文件 `fleet.json`

```json
{
  "control": "http://192.168.16.8:7800",
  "token": "节点专属令牌",
  "label": "张伟-前台",
  "allowShell": true,
  "pollSeconds": 25,
  "heartbeatSeconds": 15,
  "maxConcurrent": 2,
  "dshHome": "C:\\Users\\zhang\\AppData\\Local\\DSH Fleet\\dsh-home",
  "workspace": "C:\\Users\\zhang\\AppData\\Local\\DSH Fleet\\work"
}
```

| 字段 | 说明 |
| --- | --- |
| `control` | 主控端地址（含协议和端口） |
| `token` | 本机专属令牌；**泄露等于交出这台机器** |
| `label` | 面板显示名，可在面板里双击改 |
| `allowShell` | 是否允许执行 shell；`false` 时只接受 DSH 任务 |
| `pollSeconds` | 长轮询挂起时长（默认 25） |
| `heartbeatSeconds` | 心跳间隔（默认 15） |
| `maxConcurrent` | 同时执行的任务数（默认 2） |
| `dshHome` / `workspace` | DSH 模式的数据目录与工作目录 |

改完 `fleet.json` 需要重启代理（或等下一次自启）。

---

## 四、任务类型

服务端下发的任务形如 `{ id, kind, payload }`：

| kind | payload | 说明 |
| --- | --- | --- |
| `shell` | `{ command, timeoutMs? }` | 执行 PowerShell，返回 stdout/stderr 与退出码 |
| `file_get` | `{ path }` | 读取文件，输出 base64（面板里点"取文件"直接下载） |
| `file_put` | `{ path, base64 }` | 写入文件 |
| `dir` | `{ path }` | 列目录，返回 JSON（名称/大小/是否目录/时间），最多 500 项 |
| `screenshot` | `{}` | 截取整屏，PNG base64 写进任务日志（面板发 `截屏` 触发） |
| `cancel` | `{ taskId }` | **杀掉指定任务的进程树**（`taskkill /T /F`），不受并发槽限制 |
| `dsh` | `{ prompt }` | 调用本机 DSH Harness 跑一次会话（需要本机装了 Harness） |
| `update_agent` | `{}` | 拉取新代理代码并自我重启 |
| `purge` | `{}` | 远程自毁：删计划任务、删目录、退出 |

### shell 任务的执行细节

- 用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command <prologue + command>`
- prologue 强制 UTF-8 输出，避免中文乱码
- 输出流式回传（`/api/agent/event`），面板可以看到实时进度
- **超时**：`payload.timeoutMs`，未指定时默认 **180 秒**；超时会杀掉子进程并返回超时标记

---

## 五、自启与守护

### SYSTEM 模式

```
计划任务 DSH Fleet Node      开机触发 + 延迟 30 秒，SYSTEM 身份
计划任务 DSH Fleet Watchdog  每 5 分钟检查一次，进程没了就拉起
```

### 用户模式

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run\DSHFleet
  = "C:\Windows\System32\wscript.exe" //nologo "…\fleet\run-agent.vbs"
```

> 用户模式**不依赖任务计划程序**（很多公司策略禁用它），登录即启动。

### 手动启动 / 自测

```powershell
cd "$env:LOCALAPPDATA\DSH Fleet\fleet"
.\run-local.cmd          # 前台跑，直接看输出
```

---

## 六、日志

| 文件 | 内容 |
| --- | --- |
| `fleet\logs\agent.log` | 启动、心跳失败、任务异常、更新记录 |
| `fleet\logs\stdout.log` | 进程级输出（崩溃时看这里） |
| 主控端 `主控端\data\tasks\<id>.log` | 每条任务的完整输出 |

日志轮转：目前不自动切割，长期运行建议定期清理或改用系统日志收集。

---

## 七、热更新（不用到场）

```
主控端: POST /api/nodes/:id/update
   → 标记节点待更新
agent:  下一轮 poll 收到 update 指令
   → GET /api/agent/bundle 拉取新 agent.mjs
   → 写入临时文件、校验、替换自身
   → 以新代码重启
```

面板里点机器的 `↻` 就是这个流程。

---

## 八、安全边界

| 开关 | 效果 |
| --- | --- |
| 令牌 | 每个节点独立；服务端只存哈希，泄露需立即轮换 |
| 冻结（面板 `II`） | 停止派单，`poll` 只回 `frozen:true`，模型调用返回 403 |
| 吊销 | 删节点记录，令牌立即失效（代理会退避重试并提示） |
| 远程自毁（面板 `X`） | 删任务 + 删目录，等价卸载 |
| `allowShell=false` | 拒绝所有 shell 任务 |

**没有内建的加密**：所有流量是明文 HTTP。跨不可信网络请套 VPN / SSH 隧道 / 反向代理 + TLS。

---

## 九、常见问题

**Q：代理一直 `heartbeat 失败 401 unknown token`**
令牌在服务端被删了。删掉 `fleet.json` 里的 `token` 值，重跑 `install.ps1`（会重新登记）。

**Q：任务一直"执行中"**
对端有长命令占着并发槽（例如全盘 `Get-ChildItem -Recurse`）。等它超时（默认 180 s）或到那台机器上结束 `powershell.exe`。

**Q：公司电脑装不上**
用户模式不需要管理员；若被组策略拦（禁止 HKCU Run / 禁止 PowerShell），改走安装包并由 IT 推送。

**Q：能同时装两台同名机器吗**
可以，`label` 只是显示名，节点 id 由服务端生成，互不冲突。

**Q：怎么彻底清除**
```powershell
powershell -File "…\fleet\uninstall.ps1" -RemoveApp
```
会停进程、删计划任务、删 Run 键、删目录、删卸载注册项。
