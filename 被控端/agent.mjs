#!/usr/bin/env node
/**
 * DSH Fleet Node Agent
 * ---------------------------------------------------------------
 * 被控端常驻程序：出站长轮询连接控制端，接收并执行任务，
 * 把输出实时回传。只用 Node 内置模块，零依赖。
 *
 * 运行方式（推荐，由 install.ps1 注册的计划任务调用）：
 *   set ELECTRON_RUN_AS_NODE=1
 *   "C:\Program Files\DSH Fleet\app\DeepSeek Harness.exe" --expose-internals "...\agent.mjs"
 * 或者任何 >=20 的 node.exe：
 *   node agent.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '1.0.0';
const LOCK = path.join(HERE, 'agent.lock');
const STATE_FILE = path.join(HERE, 'agent-state.json');
const LOG_DIR = path.join(HERE, 'logs');

fs.mkdirSync(LOG_DIR, { recursive: true });

/* ------------------------------------------------------------------ util */

let stdoutOk = true;
try { process.stdout.on('error', () => { stdoutOk = false; }); } catch { stdoutOk = false; }

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(...args) {
  const line = `[${stamp()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try {
    const logPath = path.join(LOG_DIR, 'agent.log');
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
      fs.copyFileSync(logPath, path.join(LOG_DIR, 'agent.old.log'));
      fs.truncateSync(logPath, 0);
    }
    fs.appendFileSync(logPath, line + '\n');
  } catch {}
  if (stdoutOk) {
    try { process.stdout.write(line + '\n'); } catch { stdoutOk = false; }
  }
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return text ? JSON.parse(text) : fallback;
  } catch { return fallback; }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 目录不存在时 spawn 会报 ENOENT（看起来像"找不到程序"，其实是 cwd 没了）
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/* ---------------------------------------------------------- config/state */

function loadConfig() {
  const argv = process.argv.slice(2);
  const cfgIdx = argv.indexOf('--config');
  const cfgPath = cfgIdx >= 0 ? argv[cfgIdx + 1] : path.join(HERE, 'fleet.json');
  const cfg = readJson(cfgPath, null);
  if (!cfg) {
    log('FATAL: 找不到配置', cfgPath);
    process.exit(2);
  }
  if (!cfg.control) {
    log('FATAL: fleet.json 缺少 control 字段');
    process.exit(2);
  }
  const state = readJson(STATE_FILE, {});
  const merged = {
    control: cfg.control.replace(/\/+$/, ''),
    token: cfg.token || '',
    nodeId: cfg.nodeId || state.nodeId || crypto.createHash('sha256').update(os.hostname() + os.userInfo().username).digest('hex').slice(0, 16),
    label: cfg.label || os.hostname(),
    appExe: cfg.appExe || path.join(HERE, '..', 'app', 'DeepSeek Harness.exe'),
    cliEntry: cfg.cliEntry || path.join(HERE, '..', 'app', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    patchFile: cfg.patchFile || path.join(HERE, 'fleet-patch.yml'),
    dshHome: cfg.dshHome || path.join(HERE, '..', 'dsh-home'),
    workspace: cfg.workspace || path.join(HERE, '..', 'work'),
    pollSeconds: cfg.pollSeconds || 25,
    heartbeatSeconds: cfg.heartbeatSeconds || 15,
    allowShell: cfg.allowShell !== false,
    maxConcurrent: cfg.maxConcurrent || 2,
    insecure: cfg.insecure === true,
    ...state,
  };
  writeJson(STATE_FILE, { nodeId: merged.nodeId });
  return merged;
}

const cfg = loadConfig();
fs.mkdirSync(cfg.dshHome, { recursive: true });
fs.mkdirSync(cfg.workspace, { recursive: true });
writeJson(STATE_FILE, { nodeId: cfg.nodeId });

/* ---------------------------------------------------------------单实例 */

(function singleInstance() {
  try {
    if (fs.existsSync(LOCK)) {
      const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
      if (pid && Number.isFinite(pid)) {
        try {
          process.kill(pid, 0); // 活着
          log(`已在运行（pid=${pid}），本实例退出`);
          process.exit(0);
        } catch {}
      }
    }
    fs.writeFileSync(LOCK, String(process.pid));
    process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch {} });
  } catch (e) {
    log('lock 警告', e.message);
  }
})();

/* ------------------------------------------------------------------ http */

const baseHeaders = () => ({
  'content-type': 'application/json',
  authorization: `Bearer ${cfg.token}`,
  'x-node-id': cfg.nodeId,
  'x-agent-version': VERSION,
});

async function api(pathname, { method = 'POST', body, timeout = 30000, raw = false } = {}) {
  const url = cfg.control + pathname;
  const res = await fetch(url, {
    method,
    headers: baseHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${pathname} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/* -------------------------------------------------------- 输出事件批处理 */

let outbox = [];
let outboxBytes = 0;
let flushing = false;

function emit(taskId, stream, data) {
  const chunk = String(data);
  if (!chunk) return;
  outbox.push({ taskId, stream, data: chunk });
  outboxBytes += chunk.length;
  if (outboxBytes > 480 * 1024) flushEvents();
}

async function flushEvents() {
  if (flushing || outbox.length === 0) return;
  flushing = true;
  const batch = outbox;
  outbox = [];
  outboxBytes = 0;
  try {
    await api('/api/agent/event', { body: { nodeId: cfg.nodeId, events: batch } });
  } catch (e) {
    log('event 回传失败', e.message);
    // 控制端短暂不可用时保留尾部少量事件，避免内存无限增长
    const keep = batch.slice(-50);
    outbox = keep.concat(outbox);
    outboxBytes = keep.reduce((n, e2) => n + e2.data.length, 0) + outboxBytes;
    if (outbox.length > 400) { outbox = outbox.slice(-200); outboxBytes = outbox.reduce((n, e2) => n + e2.data.length, 0); }
  } finally {
    flushing = false;
  }
}
setInterval(flushEvents, 500).unref?.();

/* ------------------------------------------------------------- 子进程工具 */

// 正在跑的进程表：taskId -> child，供 cancel 使用
const runningProcs = new Map();

function killTree(pid) {
  return new Promise((resolve) => {
    try {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('close', () => resolve(true));
      k.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

function runProcess(command, args, { cwd, env, onData, timeoutMs = 0, taskId = '' } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ code: -1, ms: 0, error: e.message });
      return;
    }
    let killed = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      killed = true;
      if (child.pid) killTree(child.pid);
      else { try { child.kill('SIGKILL'); } catch {} }
    }, timeoutMs) : null;
    child.stdout?.on('data', (d) => onData?.('stdout', d));
    child.stderr?.on('data', (d) => onData?.('stderr', d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, ms: Date.now() - started, error: e.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, ms: Date.now() - started, timedOut: killed });
    });
    if (child.pid) {
      log(`spawn pid=${child.pid} ${path.basename(command)}`);
      if (taskId) runningProcs.set(taskId, child);
    }
    child.on('close', () => { if (taskId) runningProcs.delete(taskId); });
  });
}

function resolveShell() {
  const args = (cmd) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd];
  const pwsh = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  if (fs.existsSync(pwsh)) return { exe: pwsh, args: (cmd) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd] };
  // 一定用绝对路径：计划任务/SYSTEM 环境下 PATH 可能不含 WindowsPowerShell，
  // 裸写 "powershell.exe" 会间歇性 ENOENT。
  const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  for (const p of [
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(sysRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]) {
    if (fs.existsSync(p)) return { exe: p, args };
  }
  return { exe: 'powershell.exe', args };
}

/* ---------------------------------------------------------------- 任务执行 */

const dshEnv = () => ({
  ELECTRON_RUN_AS_NODE: '1',
  DSH_HOME: cfg.dshHome,
  DSH_PERMISSION_MODE: 'danger-full-access',
  DEEPSEEK_API_KEY: cfg.token,           // 只是网关令牌；真正的上游 Key 在控制端
  DSH_FLEET_NODE_ID: cfg.nodeId,
  DSH_FLEET_CONTROL: cfg.control,
});

// 单条命令的默认上限：没有显式 timeoutMs 时也不允许无限挂着
const DEFAULT_TASK_TIMEOUT_MS = Number(process.env.DEFAULT_TASK_TIMEOUT_MS || 180000);

async function execTask(task) {
  const { id, kind } = task;
  const payload = task.payload || {};

  if (kind === 'cancel') {
    const target = String(payload.taskId || '');
    const child = runningProcs.get(target);
    if (!child || !child.pid) {
      log('cancel: 目标不在运行 ' + target);
      return { code: 0, output: 'not-running' };
    }
    log('cancel: 杀进程树 pid=' + child.pid + ' taskId=' + target);
    await killTree(child.pid);
    runningProcs.delete(target);
    return { code: 0, output: 'killed' };
  }
  const onData = (stream, buf) => emit(id, stream, buf.toString('utf8'));

  if (kind === 'shell') {
    if (!cfg.allowShell) return { code: 126, error: 'allowShell=false' };
    const shell = resolveShell();
    const command = String(payload.command || '');
    // Windows PowerShell 5.1 往管道里写的是本地代码页（GBK），Node 按 UTF-8 解会乱码。
    // 先强制把输出编码切成 UTF-8，再跑用户命令。
    const prologue = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;';
    log('shell:', command.slice(0, 200));
    return runProcess(shell.exe, shell.args(prologue + command), {
      cwd: ensureDir(payload.cwd || cfg.workspace),
      env: dshEnv(),
      onData,
      timeoutMs: Number(payload.timeoutMs || DEFAULT_TASK_TIMEOUT_MS),
      taskId: id,
    });
  }

  if (kind === 'dir') {
    try {
      const target = String(payload.path || cfg.workspace);
      const items = fs.readdirSync(target, { withFileTypes: true }).slice(0, 500).map((d) => {
        let size = 0, mtime = 0;
        try {
          const st = fs.statSync(path.join(target, d.name));
          size = st.size; mtime = st.mtimeMs;
        } catch {}
        return { name: d.name, dir: d.isDirectory(), size, mtime };
      });
      return { code: 0, output: JSON.stringify({ path: target, items }) };
    } catch (e) {
      return { code: 1, output: String(e.message) };
    }
  }

  if (kind === 'screenshot') {
    try {
      const out = path.join(os.tmpdir(), 'dsh-shot-' + Date.now() + '.png');
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
        '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;',
        '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;',
        '$g=[System.Drawing.Graphics]::FromImage($bmp);',
        '$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);',
        ("$bmp.Save('" + out + "',[System.Drawing.Imaging.ImageFormat]::Png);"),
        '$g.Dispose();$bmp.Dispose();',
        "'ok'",
      ].join(' ');
      const shell = resolveShell();
      const r = await runProcess(shell.exe, shell.args(ps), {
        cwd: ensureDir(cfg.workspace),
        env: dshEnv(),
        onData: (s, b) => emit(id, s, b.toString('utf8')),
        timeoutMs: 30000,
        taskId: id,
      });
      if (r.code !== 0 || !fs.existsSync(out)) return { code: r.code || 1, output: '截图失败' };
      const b64 = fs.readFileSync(out).toString('base64');
      try { fs.unlinkSync(out); } catch {}
      emit(id, 'stdout', 'SHOT:' + b64 + '\n');
      return { code: 0, output: 'screenshot ' + Math.round(b64.length / 1024) + ' KB' };
    } catch (e) {
      return { code: 1, output: String(e.message) };
    }
  }

  if (kind === 'dsh') {
    if (!cfg.appExe || !fs.existsSync(cfg.appExe)) {
      return {
        code: 127,
        error: 'dsh 不可用：这个节点是轻量模式（没有 Harness 本体），只能跑 shell / file 任务。'
          + '要让它自己思考，请改装完整包；或者由指挥端想好命令，用 shell 发过去。',
      };
    }
    const prompt = String(payload.prompt || '');
    const args = [];
    if (fs.existsSync(cfg.patchFile)) args.push('--patch', cfg.patchFile);
    args.push('--profile', payload.profile || 'headless');
    if (payload.json !== false) args.push('--json');
    if (payload.sessionId) args.push('--session-id', String(payload.sessionId));
    args.push(prompt);
    log('dsh:', prompt.slice(0, 200));
    return runProcess(cfg.appExe, ['--expose-internals', cfg.cliEntry, ...args], {
      cwd: payload.cwd || cfg.workspace,
      env: dshEnv(),
      onData,
      timeoutMs: Number(payload.timeoutMs || DEFAULT_TASK_TIMEOUT_MS),
    });
  }

  if (kind === 'web_start') {
    const host = String(payload.host || '127.0.0.1');
    const port = String(payload.port || 4096);
    const args = ['--expose-internals', cfg.cliEntry, '--profile', 'web', '--host', host, '--port', port, '--no-open'];
    if (payload.publicUrl) args.push('--public-url', String(payload.publicUrl));
    for (const t of payload.trustedHosts || []) args.push('--trusted-host', String(t));
    const child = spawn(cfg.appExe, args, {
      cwd: cfg.workspace,
      env: { ...process.env, ...dshEnv() },
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    emit(id, 'stdout', `web started pid=${child.pid} host=${host} port=${port}\n`);
    return { code: 0, ms: 0, pid: child.pid };
  }

  if (kind === 'file_get') {
    const file = String(payload.path || '');
    try {
      const st = fs.statSync(file);
      const max = Number(payload.maxBytes || 4 * 1024 * 1024);
      if (st.size > max) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(max);
        fs.readSync(fd, buf, 0, max, 0);
        fs.closeSync(fd);
        emit(id, 'stdout', buf.toString('base64'));
        return { code: 0, ms: 0, truncated: true, size: st.size };
      }
      emit(id, 'stdout', fs.readFileSync(file).toString('base64'));
      return { code: 0, ms: 0, size: st.size };
    } catch (e) {
      return { code: 1, error: e.message };
    }
  }

  if (kind === 'file_put') {
    try {
      const target = String(payload.path || '');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(String(payload.base64 || ''), 'base64'));
      emit(id, 'stdout', `written ${target}\n`);
      return { code: 0, ms: 0 };
    } catch (e) {
      return { code: 1, error: e.message };
    }
  }

  if (kind === 'freeze') {
    cfg.frozen = true;
    writeJson(path.join(HERE, 'frozen.flag'), { at: Date.now() });
    return { code: 0 };
  }

  if (kind === 'resume') {
    cfg.frozen = false;
    try { fs.unlinkSync(path.join(HERE, 'frozen.flag')); } catch {}
    return { code: 0 };
  }

  if (kind === 'update_agent') {
    const res = await api('/api/agent/bundle', { method: 'GET', raw: true });
    if (!res.ok) return { code: 1, error: `bundle ${res.status}` };
    const code = Buffer.from(await res.arrayBuffer());
    const next = path.join(HERE, 'agent.next.mjs');
    fs.writeFileSync(next, code);
    const cmd = `ping 127.0.0.1 -n 3 >nul & move /y "${next}" "${path.join(HERE, 'agent.mjs')}" & schtasks /end /tn "DSH Fleet Node" >nul 2>&1 & schtasks /run /tn "DSH Fleet Node"`;
    spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { code: 0, note: 'agent 已更新，3 秒后自重启' };
  }

  if (kind === 'purge') {
    const dir = path.resolve(HERE, '..');
    const cmd = [
      'ping 127.0.0.1 -n 4 >nul',
      `schtasks /end /tn "DSH Fleet Node" >nul 2>&1`,
      `schtasks /end /tn "DSH Fleet Watchdog" >nul 2>&1`,
      `schtasks /delete /tn "DSH Fleet Node" /f >nul 2>&1`,
      `schtasks /delete /tn "DSH Fleet Watchdog" /f >nul 2>&1`,
      `reg delete "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DSHFleet" /f >nul 2>&1`,
      `taskkill /f /im "DeepSeek Harness.exe" >nul 2>&1`,
      'ping 127.0.0.1 -n 3 >nul',
      `rmdir /s /q "${dir}"`,
    ].join(' & ');
    spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { code: 0, note: 'purge 已排队（4 秒后自杀并删目录）' };
  }

  return { code: 127, error: `未知任务类型 ${kind}` };
}

/* --------------------------------------------------------------- 心跳 */

let lastHeartbeat = 0;

function diskInfo() {
  const out = [];
  const seen = new Set();
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    void name; void list;
  }
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    if (seen.has(drive)) continue;
    try {
      const s = fs.statfsSync(drive + '\\');
      out.push({ drive, freeGB: +(s.bavail * s.bsize / 1e9).toFixed(1), totalGB: +(s.blocks * s.bsize / 1e9).toFixed(1) });
    } catch {}
  }
  return out;
}

async function heartbeat() {
  lastHeartbeat = Date.now();
  try {
    const res = await api('/api/agent/heartbeat', {
      body: {
        nodeId: cfg.nodeId,
        label: cfg.label,
        version: VERSION,
        metrics: {
          hostname: os.hostname(),
          user: `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`,
          platform: `${os.platform()} ${os.release()}`,
          arch: os.arch(),
          uptimeSec: Math.round(os.uptime()),
          memFreeGB: +(os.freemem() / 1e9).toFixed(1),
          memTotalGB: +(os.totalmem() / 1e9).toFixed(1),
          load: os.loadavg()[0],
          disks: diskInfo(),
          cpus: os.cpus().length,
          pid: process.pid,
          frozen: !!cfg.frozen,
        },
      },
      timeout: 15000,
    });
    // 冻结期间也要靠心跳发现"解冻"
    if (res && res.frozen === false && cfg.frozen) { cfg.frozen = false; log('控制端已解冻，恢复取任务'); }
    return res;
  } catch (e) {
    log('heartbeat 失败', e.message);
    return null;
  }
}

/* ---------------------------------------------------------------- 主循环 */

const inflight = new Set();
const done = new Set();

async function handleTask(task) {
  if (done.has(task.id)) return;
  inflight.add(task.id);
  log(`任务开始 ${task.id} kind=${task.kind}`);
  let result;
  try {
    result = await execTask(task);
  } catch (e) {
    result = { code: 1, error: e.message };
  }
  await flushEvents();
  try {
    await api('/api/agent/result', {
      body: { nodeId: cfg.nodeId, taskId: task.id, result: { ...result, finishedAt: Date.now() } },
      timeout: 20000,
    });
  } catch (e) {
    log('result 回传失败', task.id, e.message);
  }
  done.add(task.id);
  if (done.size > 500) done.delete(done.values().next().value);
  inflight.delete(task.id);
  log(`任务结束 ${task.id} code=${result?.code}`);
}

async function main() {
  log(`DSH Fleet Agent ${VERSION} 启动 node=${cfg.nodeId} control=${cfg.control}`);
  let backoff = 1000;
  let helloOk = false;

  setInterval(() => { if (Date.now() - lastHeartbeat > cfg.heartbeatSeconds * 1000) heartbeat(); }, 5000).unref?.();
  heartbeat();

  while (true) {
    try {
      if (!helloOk) {
        const hello = await api('/api/agent/hello', {
          body: {
            nodeId: cfg.nodeId, label: cfg.label, version: VERSION,
            hostname: os.hostname(), user: os.userInfo().username,
          },
          timeout: 20000,
        });
        helloOk = true;
        backoff = 1000;
        if (hello?.frozen) { cfg.frozen = true; log('控制端要求冻结，暂停取任务'); }
        else if (cfg.frozen) { cfg.frozen = false; }
      }

      if (cfg.frozen) { await sleep(10000); lastHeartbeat = 0; continue; }

      const pollUrl = `/api/agent/poll?nodeId=${encodeURIComponent(cfg.nodeId)}&wait=${cfg.pollSeconds}&slots=${Math.max(0, cfg.maxConcurrent - inflight.size)}`;
      const body = await api(pollUrl, { method: 'GET', timeout: cfg.pollSeconds * 1000 + 20000 });

      if (body?.frozen) { cfg.frozen = true; continue; }
      for (const task of body?.tasks || []) {
        // cancel 是控制指令，永远立刻处理（不受并发槽限制）
        if (task.kind === 'cancel') { handleTask(task); continue; }
        if (inflight.size >= cfg.maxConcurrent) break;
        handleTask(task); // 不阻塞轮询
      }
      if (body?.revoked) { log('令牌被吊销，退避重试'); await sleep(60000); helloOk = false; }
    } catch (e) {
      const status = e.status;
      log('主循环异常', status || '', e.message);
      if (status === 401 || status === 403) {
        await sleep(30000);
        helloOk = false;
        continue;
      }
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

process.on('uncaughtException', (e) => {
  if (e && (e.code === 'EPIPE' || e.code === 'ERR_STREAM_DESTROYED' || e.code === 'EBADF')) { stdoutOk = false; return; }
  log('uncaught', (e && e.stack) || String(e));
});
process.on('unhandledRejection', (e) => log('unhandledRejection', String(e?.stack || e)));

main();
