# 安全模型

**先说清楚**：DSH Fleet 给你的是一台远程电脑上的 shell，只是入口换成了自然语言。
它的能力边界等于"你能在那台机器上敲 PowerShell"。请只在自己的设备或明确授权的设备上使用。

---

## 一、信任边界

```
你（浏览器 / Harness）
   │  口令 → x-ctl-token
   ▼
主控端 control/server.mjs ──── DeepSeek API（只有这里有 Key）
   │  节点令牌（Bearer）
   ▼
被控端 agent ──── 该机器的 PowerShell（用户或 SYSTEM 权限）
```

| 资产 | 存在哪 | 泄露后果 |
| --- | --- | --- |
| 控制台口令 | `主控端/data/password.txt` | 别人能操作**所有**已接入机器 |
| 节点令牌 | 被控端 `fleet.json` | 别人能操作**这一台**机器 |
| 登记钥匙 | `主控端/data/enroll-key.txt` | 别人能把自己的机器接进来（不能反过来控制） |
| 模型 Key | `control/upstream-key.txt` | 别人能刷你的 API 额度 |

**模型 Key 不会下发给被控端**：被控端的模型请求走主控端 `/llm/*` 网关，Key 只注入在网关侧。

---

## 二、已有的防护

| 机制 | 说明 |
| --- | --- |
| 每节点独立令牌 | 服务端只存哈希；一台泄露不影响其它 |
| 冻结 | 立刻停止派单，模型调用返回 403 |
| 吊销 | 删节点即失效 |
| 远程自毁 | 删任务 + 删目录 |
| 命令超时 | 默认 180 s，防一条命令把机器占死 |
| `allowShell=false` | 完全禁止 shell 任务 |
| 日志留痕 | 每条任务在 `主控端/data/tasks/<id>.log` 有完整输出 |

---

## 三、没有做的（别指望）

- **没有传输加密**：全链路是明文 HTTP。跨不可信网络请套 VPN / SSH 隧道 / TLS 反代。
- **没有细粒度权限**：拿到节点令牌 = 拿到该权限下的完整 shell。
- **没有审计导出**：日志在本地文件，没有集中审计。
- **没有多用户**：一个控制台口令，没有账号体系。
- **没有防重放**：令牌是长期有效的 bearer。

---

## 四、部署建议

1. **只在内网 / VPN 内跑**，不要直接暴露到公网。
2. 主控端端口限制来源 IP：

   ```powershell
   New-NetFirewallRule -DisplayName "DSH Fleet" -Direction Inbound -Protocol TCP `
     -LocalPort 7800 -RemoteAddress 192.168.16.0/24 -Action Allow
   ```

3. 口令用强口令；定期轮换：

   ```powershell
   # 换口令：改文件后重启
   Set-Content 主控端\data\password.txt '新口令'
   # 换登记钥匙：删文件后重启自动重建（旧安装包会失效，需重新打包）
   Remove-Item 主控端\data\enroll-key.txt
   ```

4. 定期清 `主控端\data\tasks\`（会一直增长）。
5. 离职/换机：面板里删掉节点，并在那台机器上跑 `uninstall.ps1 -RemoveApp`。

---

## 五、被控端用户需要知道什么

安装时应当明确告知对方：

- 装了什么（`%LOCALAPPDATA%\DSH Fleet`）
- 谁能操作（持有控制台口令的人）
- 能做什么（以他的身份执行命令、读写文件）
- 怎么卸载（`uninstall.ps1 -RemoveApp` 或面板远程自毁）

**不要在对方不知情的情况下安装。** 这是工具，不是后门。

---

## 六、漏洞报告

发现安全问题请开 issue 或私下联系维护者，不要公开 PoC。
