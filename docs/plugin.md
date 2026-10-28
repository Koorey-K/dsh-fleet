# 作为 DeepSeek Harness 插件安装

装完之后，远程机器面板直接挂在 Harness 界面里，**不用另开浏览器、不用点任何启动脚本**（插件会在后台自动把指挥端拉起来）。

---

## 一、插件是什么

一个普通的 DSH 插件包，两半：

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | Node 半边：检查 7800 端口，没在跑就后台启动 `control/server.mjs` |
| `lib/client.js` | 浏览器半边：往 Harness 的 slot 里注册「远程机器」按钮 + 悬浮面板 |
| `cordis.patch.yml` | 声明要插入的插件行 |

---

## 二、安装

### 1. 找到 Harness 的 profile 目录

```powershell
# 桌面版（Electron）的 DSH_HOME 不一定是 ~/.dsh，看进程参数最准
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" |
  Where-Object { $_.CommandLine -like '*dsh-desktop-host*' } |
  ForEach-Object { $_.CommandLine }
# 参数里 F:\...\dsh-home\profiles\desktop 就是目标目录
```

常见位置：

| 形态 | profile 路径 |
| --- | --- |
| 桌面版 | `<DSH_HOME>\profiles\desktop` |
| `dsh web` | `~/.dsh/profiles/web` |

### 2. 复制插件

```powershell
$prof = 'F:\dsh-workspace\dsh-home\profiles\desktop'
$dst  = Join-Path $prof 'node_modules\dsh-fleet-plugin'
New-Item -ItemType Directory -Force -Path "$dst\lib" | Out-Null
Copy-Item 主控端\plugin\package.json, 主控端\plugin\cordis.patch.yml $dst -Force
Copy-Item 主控端\plugin\lib\index.js, 主控端\plugin\lib\client.js "$dst\lib" -Force
```

### 3. 登记到 profile

**`package.json`**：依赖 + bundles 各加一项

```json
{
  "dependencies": { "dsh-fleet-plugin": "file:../../../dsh-fleet/plugin" },
  "dsh": { "profile": { "bundles": ["…原有…", "dsh-fleet-plugin"] } }
}
```

**`cordis.patch.yml`**：末尾追加

```yaml
- insert:
    - id: fleet-panel
      name: dsh-fleet-plugin
```

> **这一步不能省。** 列在 `bundles` 里的包只会被当作补丁层，**不会**自动变成插件条目；
> 必须用 `insert` 显式插一行，它的 Node 半边和浏览器半边才会挂载。

### 4. 重启 Harness

完全退出（不是关窗口）再启动。会话头部或侧栏会出现 **「● 远程机器」**。

第一次点开要输控制台口令（见 `主控端\data\password.txt`）。

---

## 三、卸载

```powershell
$prof = 'F:\dsh-workspace\dsh-home\profiles\desktop'
Remove-Item "$prof\node_modules\dsh-fleet-plugin" -Recurse -Force
# 再把 package.json 的依赖/bundles 和 cordis.patch.yml 里的 insert 行删掉
```

改之前先备份这两个文件：

```powershell
Copy-Item "$prof\package.json" "$prof\package.json.bak" -Force
Copy-Item "$prof\cordis.patch.yml" "$prof\cordis.patch.yml.bak" -Force
```

---

## 四、插件做了什么

| 行为 | 说明 |
| --- | --- |
| 自动起服务 | 启动时探测 `127.0.0.1:7800`，没在跑就 `spawn` 一个隐藏进程 |
| 面板 | 机器列表（备注名 / 用户 / 磁盘）+ 搜索 + 对话 + 快捷动作 |
| 双击改名 | `PATCH /api/nodes/:id`，改成"张伟-前台"这种好认的名字 |
| 实时反馈 | 发送后立刻显示"正在思考… Ns"，每条命令执行状态与输出实时刷新 |
| 停止 | 运行中「发送」变「停止」，调 `/api/ai/job/:id/stop` |

跨域：面板从 Harness 的端口访问 `127.0.0.1:7800`，服务端已开 CORS。

---

## 五、排错

| 现象 | 处理 |
| --- | --- |
| 没出现按钮 | 确认 `cordis.patch.yml` 有 `insert` 行；完全重启 Harness；看开发者工具 Console |
| 按钮在，面板空白 | 口令错 / 服务没起来：`Get-NetTCPConnection -LocalPort 7800` |
| 面板能开但没有机器 | 被控端没接入，或不在同一网络 |
| Harness 起不来 | 用备份的 `package.json.bak` / `cordis.patch.yml.bak` 还原，再删掉 `node_modules\dsh-fleet-plugin` |
