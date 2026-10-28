# HTTP 接口

所有接口都在主控端 `control/server.mjs` 里，零依赖（`node:http`）。

三类鉴权：

| 场景 | 头部 |
| --- | --- |
| 控制台（人操作） | `x-ctl-token: <登录后拿到的 token>` |
| 被控端（机器） | `authorization: Bearer <节点令牌>` |
| 公开（安装/下载） | 无 |

---

## 一、公开接口

### `GET /`

网页面板（`panel.html`）。

### `GET /join`

返回一段可直接 `iex` 执行的 PowerShell 引导脚本（自动适配请求里的 host）。

```powershell
irm http://192.168.16.8:7800/join | iex
```

### `GET /download/lite.zip`

下发被控端负载（约 33 MB，`content-type: application/zip`）。

### `POST /api/agent/enroll`

被控端首次安装时用它换取专属令牌。

```json
// 请求
{ "key": "<ENROLL_KEY>", "hostname": "DX002043B", "label": "张伟-前台" }

// 响应
{ "nodeId": "n6116c63027", "token": "…", "control": "http://192.168.16.8:7800" }
```

钥匙不对返回 `403`。

### `ALL /llm/*`

模型网关：把被控端的模型调用转发到上游（`UPSTREAM_BASE`），注入真实 Key。
被控端因此**永远拿不到 API Key**。

---

## 二、控制台接口

### `POST /api/login`

```json
{ "password": "majunjie123" }   →  { "token": "…" }
```

后续所有控制台接口都带 `x-ctl-token`。失败 `401 {"error":"需要登录"}`。

### `GET /api/nodes`

```json
{
  "nodes": [
    {
      "id": "n6116c63027",
      "label": "zyf",
      "online": true,
      "frozen": false,
      "lastSeen": 1761537000000,
      "version": "1.0.0",
      "metrics": {
        "hostname": "DX002043B",
        "user": "DX\\SYSTEM",
        "platform": "Windows 11 专业版",
        "memFreeGB": 10.9,
        "memTotalGB": 34.2,
        "uptimeSec": 88000,
        "disks": [{ "drive": "C", "freeGB": 644.4, "totalGB": 953.6 }]
      }
    }
  ]
}
```

### `POST /api/enroll`

控制台里手动生成一个节点令牌（不想用自助登记时）。

```json
{ "label": "手动接入" } → { "nodeId": "n…", "token": "…", "control": "http://…" }
```

### `PATCH /api/nodes/:id`

改备注名。

```json
{ "label": "张伟-前台" }
```

### `DELETE /api/nodes/:id`

删节点（令牌立即失效）。

### `POST /api/nodes/:id/freeze` / `resume`

冻结 / 恢复：冻结期间不派发任务，模型调用返回 `403`。

### `POST /api/nodes/:id/update`

推新代理：下一轮 poll 时下发 `update_agent`，代理自我重启。

### `POST /api/nodes/:id/purge`

远程自毁：删计划任务 + 删目录 + 退出。

### `PATCH /api/nodes/:id`

改节点备注名（面板里双击机器名调它）。

```json
{ "label": "张伟-前台" }
```

### `POST /api/nodes/:id/reset`

清空该节点的排队任务（卡死时用）。

### `POST /api/nodes/:id/task`

直接下发一条任务（面板的"快捷动作"和"取文件"用它）。

```json
{ "kind": "shell", "payload": { "command": "hostname" } }
{ "kind": "file_get", "payload": { "path": "C:\\Users\\Public\\a.txt" } }
{ "kind": "screenshot", "payload": {} }
{ "kind": "dir", "payload": { "path": "C:\\Users" } }
{ "kind": "cancel", "payload": { "taskId": "tmv…" } }   // 杀掉正在跑的任务
```

响应：`{ "task": { "id": "tmv…", "kind": "shell", "status": "queued" } }`

### `GET /api/tasks/:id/log?offset=N`

增量拉取任务输出（长轮询替代品，前端 600–800 ms 轮询一次）。

```json
{ "chunk": "…新输出…", "offset": 1234, "status": "running|done|failed", "result": { "code": 0, "ms": 432 } }
```

### `GET /api/tasks?node=<id>`

该节点最近 20 条任务（面板"最近任务"用）。

### `POST /api/ai/run`

**核心接口**：一句话驱动。

```json
{ "nodeId": "n6116c63027", "prompt": "看看 C 盘哪些目录最占空间" }
```

立即返回（毫秒级）：

```json
{ "job": { "id": "amv…", "status": "running", "steps": [] } }
```

后台流程：模型决定命令 → 下发 shell 任务 → 等结果 → 继续 → 直到给出结论（最多 `AI_MAX_STEPS` 步）。

### `GET /api/ai/job/:id`

```json
{
  "job": {
    "id": "amv…",
    "status": "running|stopped|done|error",
    "steps": [
      { "type": "tool", "command": "Get-PSDrive C …", "reason": "为什么跑这条", "status": "running|done", "ms": 756, "exitCode": 0, "output": "…" },
      { "type": "answer", "text": "C 盘用了 309 GB，剩 644 GB…" }
    ]
  }
}
```

前端每 800 ms 拉一次即可实现"实时打字"效果。

### `POST /api/ai/job/:id/stop`

手动停止：不再派新命令，剩余步骤丢弃。

> 注意：只对进程内还活着的任务有效；主控端重启后旧任务查不到。

### `POST /api/ai/plan`

计划模式：只让模型出"打算执行哪些命令"，不执行。

```json
// 请求
{ "nodeId": "n6116c63027", "prompt": "清理临时目录" }

// 响应
{
  "planId": "p774374b8374e",
  "steps": [{ "command": "Get-ChildItem $env:TEMP …", "reason": "先看有多大" }],
  "note": ""
}
```

确认后把 `planId` 一起发给 `/api/ai/run`，就会按这份清单逐条执行并给出总结：

```json
{ "nodeId": "n6116c63027", "prompt": "清理临时目录", "planId": "p774374b8374e" }
```

### `GET /api/ai/jobs`

最近的任务列表（面板"历史会话"用）。

### `GET /api/config`

```json
{ "model": "deepseek-chat", "hasKey": true, "mock": false, "enrollKey": "…", "upstream": "https://api.deepseek.com/anthropic" }
```

前端据此显示"模型 / 模拟模式"徽章。

---

## 三、被控端接口

全部需要 `authorization: Bearer <节点令牌>`，令牌不对返回 `401 {"error":"unknown token"}`。

| 接口 | 说明 |
| --- | --- |
| `POST /api/agent/hello` | 上线：回报主机名、用户、系统、内存、磁盘、版本 |
| `GET /api/agent/poll?wait=25&slots=2` | **长轮询领任务**；没任务时挂起最多 `wait` 秒 |
| `POST /api/agent/heartbeat` | 每 15 秒心跳（顺带更新指标） |
| `POST /api/agent/event` | 流式回传任务输出片段 |
| `POST /api/agent/result` | 任务结束：`{ taskId, code, ms, timedOut }` |
| `GET /api/agent/bundle` | 热更新：拉取最新 `agent.mjs` |

`poll` 的响应：

```json
{ "tasks": [ { "id": "tmv…", "kind": "shell", "payload": { "command": "…", "timeoutMs": 120000 } } ] }
{ "frozen": true, "tasks": [] }
```

---

## 四、错误约定

| 状态码 | 含义 |
| --- | --- |
| `401` | 控制台未登录 / 节点令牌无效 |
| `403` | 登记钥匙错误 / 节点被冻结 |
| `404` | 节点或任务不存在 |
| `500` | 服务端异常（看 `主控端\server.err.log`） |

响应体统一 `{ "error": "中文说明" }`。
