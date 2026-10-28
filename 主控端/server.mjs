#!/usr/bin/env node
/**
 * DSH Fleet Control Server（指挥端）
 * ---------------------------------------------------------------
 * - 节点注册 / 心跳 / 长轮询派发任务 / 输出回传
 * - 浏览器控制台（/）：看节点、下发任务、实时看输出、冻结/卸载
 * - LLM 网关（/llm/*）：把被控端的模型调用转给真正的上游 Key，
 *   被控端拿到的只是节点令牌 —— 冻结/吊销即断供，这就是"总控制权"。
 *
 * 零依赖，Node >= 20：
 *   node server.mjs            # 默认 0.0.0.0:7800
 * 环境变量：
 *   FLEET_PORT=7800
 *   FLEET_HOST=0.0.0.0
 *   FLEET_PASSWORD=<控制台登录口令>      (缺省会生成并打印到 data/password.txt)
 *   UPSTREAM_BASE=https://api.deepseek.com/anthropic
 *   UPSTREAM_API_KEY=<真正的 DeepSeek API Key>
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data');
const TASKS = path.join(DATA, 'tasks');
fs.mkdirSync(TASKS, { recursive: true });

const PORT = Number(process.env.FLEET_PORT || 7800);
const HOST = process.env.FLEET_HOST || '0.0.0.0';
const UPSTREAM_BASE = (process.env.UPSTREAM_BASE || 'https://api.deepseek.com/anthropic').replace(/\/+$/, '');
const UPSTREAM_KEY = process.env.UPSTREAM_API_KEY || '';

const PASSWORD_FILE = path.join(DATA, 'password.txt');
if (!process.env.FLEET_PASSWORD && !fs.existsSync(PASSWORD_FILE)) {
  fs.writeFileSync(PASSWORD_FILE, crypto.randomBytes(9).toString('base64url'));
}
const PASSWORD = process.env.FLEET_PASSWORD || fs.readFileSync(PASSWORD_FILE, 'utf8').trim();

// 安装包自助登记用的共享密钥：目标机器拿着它换自己的节点令牌
const ENROLL_FILE = path.join(DATA, 'enroll-key.txt');
if (!process.env.ENROLL_KEY && !fs.existsSync(ENROLL_FILE)) {
  fs.writeFileSync(ENROLL_FILE, crypto.randomBytes(9).toString('base64url'));
}
const ENROLL_KEY = process.env.ENROLL_KEY || fs.readFileSync(ENROLL_FILE, 'utf8').trim();

/* ------------------------------------------------------------------ state */

const STATE_FILE = path.join(DATA, 'state.json');
const state = (() => {
  try {
    const text = fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch { return { nodes: {}, seq: 0 }; }
})();
state.nodes ||= {};
state.seq ||= 0;

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function findNodeByToken(token) {
  if (!token) return null;
  const h = sha(token);
  for (const node of Object.values(state.nodes)) {
    if (node.tokenHash && crypto.timingSafeEqual(Buffer.from(node.tokenHash, 'hex'), Buffer.from(h, 'hex'))) return node;
  }
  return null;
}

/* ------------------------------------------------------------------ tasks */

const waiters = new Map(); // nodeId -> resolve fn

function taskFile(id) { return path.join(TASKS, id + '.json'); }
function logFile(id) { return path.join(TASKS, id + '.log'); }

// 任务目录轮转：超过 MAX_TASKS 个就删最老的（连同 json 与 log）
const MAX_TASKS = Number(process.env.MAX_TASKS || 2000);

function rotateTasks() {
  try {
    const files = fs.readdirSync(TASKS).filter((f) => f.endsWith('.json'));
    if (files.length <= MAX_TASKS) return;
    const withTime = files.map((f) => {
      const full = path.join(TASKS, f);
      let ms = 0;
      try { ms = fs.statSync(full).mtimeMs; } catch {}
      return { f, full, ms };
    }).sort((a, b) => a.ms - b.ms);
    const drop = withTime.slice(0, files.length - MAX_TASKS);
    for (const d of drop) {
      try { fs.unlinkSync(d.full); } catch {}
      try { fs.unlinkSync(logFile(path.basename(d.f, '.json'))); } catch {}
    }
    if (drop.length) console.log('[rotate] 清理任务记录 ' + drop.length + ' 条');
  } catch (e) { void e; }
}

function createTask(nodeId, kind, payload) {
  const id = 't' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const task = { id, nodeId, kind, payload: payload || {}, status: 'queued', created: Date.now() };
  fs.writeFileSync(taskFile(id), JSON.stringify(task, null, 2));
  fs.writeFileSync(logFile(id), '');
  const node = state.nodes[nodeId];
  if (node) {
    node.queue ||= [];
    node.queue.push(id);
    save();
  }
  const w = waiters.get(nodeId);
  if (w) { waiters.delete(nodeId); w(); }
  return task;
}

function readTask(id) {
  try { return JSON.parse(fs.readFileSync(taskFile(id), 'utf8')); } catch { return null; }
}

function updateTask(id, patch) {
  const task = readTask(id);
  if (!task) return null;
  Object.assign(task, patch);
  fs.writeFileSync(taskFile(id), JSON.stringify(task, null, 2));
  return task;
}

function takeQueued(nodeId, slots) {
  const node = state.nodes[nodeId];
  if (!node) return [];
  node.queue ||= [];
  const out = [];
  // cancel 是控制指令，不受并发槽限制；先把它挑出来
  const rest = [];
  for (const id of node.queue) {
    const tk = readTask(id);
    if (tk && tk.kind === 'cancel') {
      tk.status = 'running';
      tk.startedAt = Date.now();
      fs.writeFileSync(taskFile(id), JSON.stringify(tk, null, 2));
      out.push({ id: tk.id, kind: tk.kind, payload: tk.payload });
    } else if (tk && tk.kind === 'update_agent') {
      rest.push(id);
    } else {
      rest.push(id);
    }
  }
  node.queue = rest;
  while (out.length < slots && node.queue.length) {
    const id = node.queue.shift();
    const task = readTask(id);
    if (!task) continue;
    task.status = 'running';
    task.startedAt = task.startedAt || Date.now();
    fs.writeFileSync(taskFile(id), JSON.stringify(task, null, 2));
    out.push({ id: task.id, kind: task.kind, payload: task.payload });
  }
  if (out.length) node.running = (node.running || 0) + out.length;
  save();
  return out;
}

/* -------------------------------------------------------------------- http */

const SESSIONS_FILE = path.join(DATA, 'sessions.json');
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 60) * 24 * 3600 * 1000;

const sessions = new Map(); // token -> { at }

/** 从磁盘恢复登录会话（服务重启后插件不用重新输口令） */
function loadSessions() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [tok, rec] of Object.entries(obj || {})) {
      if (rec && now - (rec.at || 0) < SESSION_TTL_MS) sessions.set(tok, rec);
    }
    if (sessions.size) console.log('[sessions] 恢复登录会话 ' + sessions.size + ' 条');
  } catch (e) { void e; }
}

function saveSessions() {
  try {
    const obj = {};
    for (const [tok, rec] of sessions) obj[tok] = rec;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
  } catch (e) { void e; }
}

/** 会话是否仍然有效（带过期判断） */
function sessionValid(tok) {
  const rec = sessions.get(tok);
  if (!rec) return false;
  if (Date.now() - (rec.at || 0) > SESSION_TTL_MS) { sessions.delete(tok); return false; }
  return true;
}

function json(res, code, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// 登录失败限速：同一 IP 10 分钟内最多 8 次失败
const loginFails = new Map(); // ip -> { count, first }
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;

function loginBlocked(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) { loginFails.delete(ip); return false; }
  return rec.count >= LOGIN_MAX_FAILS;
}

function loginFail(ip) {
  const rec = loginFails.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) loginFails.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}

function controlAuth(req) {
  const header = String(req.headers['x-ctl-token'] || '');
  if (header && sessionValid(header)) return true;
  const cookie = parseCookies(req).fleet;
  return !!(cookie && sessionValid(cookie));
}

function agentAuth(req, url) {
  const header = String(req.headers.authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = bearer || url.searchParams.get('token') || '';
  const node = findNodeByToken(token);
  return node;
}

/* ------------------------------------------------------------ 节点工具函数 */

/** 队列里最早那条任务已经等了多久（毫秒） */
function oldestQueuedMs(node) {
  try {
    const ids = node.queue || [];
    if (!ids.length) return 0;
    let oldest = Infinity;
    for (const id of ids) {
      const tk = readTask(id);
      if (tk && tk.created) oldest = Math.min(oldest, tk.created);
    }
    if (oldest === Infinity) return 0;
    return Date.now() - oldest;
  } catch { return 0; }
}

/** 这台机器当前有几条任务处于 running */
function runningCount(nodeId) {
  try {
    let n = 0;
    for (const tk of tasks.values()) if (tk.nodeId === nodeId && tk.status === 'running') n++;
    return n;
  } catch { return 0; }
}

function nodeSummary(node) {
  return {
    id: node.id,
    label: node.label,
    version: node.version,
    online: Date.now() - (node.lastSeen || 0) < 90_000,
    lastSeen: node.lastSeen || 0,
    lastPoll: node.lastPoll || 0,
    frozen: !!node.frozen,
    queue: (node.queue || []).length,
    queuedMs: oldestQueuedMs(node),
    busy: runningCount(node.id),
    metrics: node.metrics || {},
    llmRequests: node.llmRequests || 0,
  };
}

function upsertNode({ id, label, version, meta }) {
  const node = state.nodes[id] || (state.nodes[id] = { id, created: Date.now(), queue: [], tokenHash: '' });
  if (label) node.label = label;
  if (version) node.version = version;
  if (meta) node.meta = { ...(node.meta || {}), ...meta };
  node.lastSeen = Date.now();
  save();
  return node;
}

/* ------------------------------------------------------------- AI 执行器 */

// 用户一句话 → 模型自己决定跑哪些命令 → 汇总答复
const AI_DIR = path.join(DATA, 'ai');
fs.mkdirSync(AI_DIR, { recursive: true });

const AI_BASE = (process.env.AI_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
const AI_MODEL = process.env.AI_MODEL || 'deepseek-chat';
// 没配 API Key 时自动进入模拟模式：循环和"真实命令"照跑，只有最后的"分析"是套话
const AI_MOCK = process.env.AI_MOCK === '1' || !UPSTREAM_KEY;
const AI_MAX_STEPS = Number(process.env.AI_MAX_STEPS || 40);
const AI_TASK_TIMEOUT_MS = Number(process.env.AI_TASK_TIMEOUT_MS || 120000);
const AI_OUTPUT_LIMIT = Number(process.env.AI_OUTPUT_LIMIT || 8000);   // 单条命令回给模型的字符上限
const AI_LIVE_LIMIT = Number(process.env.AI_LIVE_LIMIT || 20000);     // 面板实时看到的字符上限

const jobs = new Map(); // id -> job

/**
 * 启动时恢复历史 job：
 * - 能读到的都塞回内存，面板「历史」和 /stop 才能正常用
 * - 上次进程退出时还处于 running 的，标成 interrupted（不会假装还在跑）
 */
function restoreJobs() {
  try {
    if (!fs.existsSync(AI_DIR)) return;
    for (const f of fs.readdirSync(AI_DIR)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(AI_DIR, f);
      try {
        const job = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (!job || !job.id) continue;
        if (job.status === 'running' || job.status === 'stopping') {
          job.status = 'interrupted';
          job.error = '主控端重启，这条任务被中断';
          job.finishedAt = job.finishedAt || Date.now();
          for (const st of job.steps || []) {
            if (st.status === 'running') st.status = 'done';
          }
          fs.writeFileSync(full, JSON.stringify(job, null, 2));
        }
        jobs.set(job.id, job);
      } catch {}
    }
    if (jobs.size) console.log('[restore] 恢复历史任务 ' + jobs.size + ' 条');
  } catch (e) { void e; }
}
const aiFile = (id) => path.join(AI_DIR, id + '.json');
function saveJob(job) {
  try { if (Math.random() < 0.02) rotateTasks(); } catch {} try { fs.writeFileSync(aiFile(job.id), JSON.stringify(job, null, 2)); } catch {} }

const AI_SYSTEM = [
  '你是 DSH 运维助手，正在通过一台远程代理操作 Windows 电脑（SYSTEM 权限）。',
  '用户会用一句人话描述需求，你自己决定跑哪些 PowerShell 命令，直到能给出结论。',
  '硬性规则（违反会超时失败）：',
  '1. 只能通过 run_shell 工具执行命令，它会返回 stdout/stderr 与退出码。',
  '2. 单条命令必须能在 20 秒内返回。禁止对 C:\\、C:\\Windows、C:\\Users 做整盘递归统计（Get-ChildItem -Recurse 会跑几分钟）。',
  '   想看大小就用：Get-ChildItem <具体目录> -Depth 2；或只看一层：Get-ChildItem C:\\ -Force。',
  '3. 一次一条命令；需要更多信息就分多次跑。',
  '4. 输出收敛：Select-Object -First N / Measure-Object / Format-Table，别把几万行拉回来。',
  '5. 先只读、后改动：删除/卸载/修改类操作必须先列清单，并在最终回答里说明你做了什么。',
  '6. 最终回答用中文：先给结论，再给关键数据（路径、大小、数量），最后给建议。不要贴大段原始输出。',
  '7. 如果用户只是问"有什么"，只做只读查询即可，不要顺手清理。',
].join('\n');

const AI_TOOLS = [{
  type: 'function',
  function: {
    name: 'run_shell',
    description: '在目标 Windows 机器上执行一条 PowerShell 命令，返回 stdout/stderr 与退出码',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 PowerShell 命令' },
        reason: { type: 'string', description: '为什么跑这条（给人看的一句话）' },
      },
      required: ['command'],
    },
  },
}];

async function callModel(messages) {
  if (AI_MOCK) return mockModel(messages);
  if (!UPSTREAM_KEY) {
    throw new Error('指挥端没有配置 UPSTREAM_API_KEY，模型没法思考。请在启动前设置该环境变量。');
  }
  const res = await fetch(AI_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${UPSTREAM_KEY}` },
    body: JSON.stringify({ model: AI_MODEL, messages, tools: AI_TOOLS, tool_choice: 'auto', temperature: 0.2, max_tokens: 2000 }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`模型接口 ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  const msg = data?.choices?.[0]?.message || {};
  return { content: msg.content || '', toolCalls: msg.tool_calls || [] };
}

// 没有 API Key 时也能把链路跑通：脚本化的假模型
async function mockModel(messages) {
  const toolResults = messages.filter((m) => m.role === 'tool');
  if (toolResults.length === 0) {
    return {
      content: '',
      toolCalls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'run_shell',
          arguments: JSON.stringify({
            command: 'Get-ChildItem C:\\ -Force -ErrorAction SilentlyContinue | Sort-Object Length -Descending | Select-Object -First 8 Name,@{n="MB";e={[math]::Round($_.Length/1MB,1)}} | Format-Table -AutoSize',
            reason: '先看 C 盘根目录占用最大的文件',
          }),
        },
      }],
    };
  }
  return {
    content: '（模拟模式）C 盘根目录已经扫过，上面是占用最大的几个条目。配置 UPSTREAM_API_KEY 后这里会是模型的真实分析。',
    toolCalls: [],
  };
}

function waitTask(id, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const t = readTask(id);
      if (t && (t.status === 'done' || t.status === 'failed')) return resolve(t);
      if (Date.now() - started > timeoutMs) return resolve(t || { status: 'timeout' });
      setTimeout(tick, 400);
    };
    tick();
  });
}

async function runAiJob(job) {
  const messages = [
    { role: 'system', content: AI_SYSTEM },
    { role: 'user', content: job.prompt },
  ];
  try {
    for (let step = 0; step < AI_MAX_STEPS; step++) {
      if (job.stopRequested) {
        job.status = 'stopped';
        job.finishedAt = Date.now();
        job.steps.push({ type: 'answer', text: '（已手动停止）' });
        saveJob(job);
        return;
      }
      if (step === 12) {
        messages.push({ role: 'system', content: '已经执行了不少命令。信息够用就直接给结论，不要再跑新命令。' });
      }
      const reply = await callModel(messages);
      if (reply.toolCalls && reply.toolCalls.length) {
        messages.push({ role: 'assistant', content: reply.content || '', tool_calls: reply.toolCalls });
        for (const tc of reply.toolCalls) {
          let args = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
          const command = String(args.command || '').trim();
          const reason = String(args.reason || '').trim();
          if (!command) {
            messages.push({ role: 'tool', tool_call_id: tc.id, content: '错误：命令为空' });
            continue;
          }
          if (job.stopRequested) { job.status = 'stopped'; job.finishedAt = Date.now(); saveJob(job); return; }
          const stepRef = { type: 'tool', command, reason, status: 'running', at: Date.now() };
          job.steps.push(stepRef);
          saveJob(job);

          const task = createTask(job.nodeId, 'shell', { command, timeoutMs: 120000 });
          // 关键：taskId 必须在"下发后、等待前"就写到 step 上，
          // 否则点停止时找不到正在跑的任务，cancel 发不出去
          stepRef.taskId = task.id;
          saveJob(job);

          const done = await waitTask(task.id, AI_TASK_TIMEOUT_MS);
          let output = '';
          try { output = fs.readFileSync(logFile(task.id), 'utf8'); } catch {}
          stepRef.status = 'done';
          stepRef.exitCode = done?.result?.code ?? null;
          stepRef.ms = done?.result?.ms ?? null;
          stepRef.output = output.slice(-6000);
          if (stepRef.cancelled) stepRef.status = 'cancelled';
          saveJob(job);

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: (output || '(无输出)').slice(-AI_OUTPUT_LIMIT) + `\n\n[exit ${stepRef.exitCode}]`,
          });
        }
        continue;
      }
      job.steps.push({ type: 'answer', text: reply.content || '(模型没有给出结论)' });
      job.status = 'done';
      job.finishedAt = Date.now();
      saveJob(job);
      return;
    }
    job.status = 'stopped';
    job.steps.push({ type: 'answer', text: '（已经跑了很多步，先停在这里。需要继续就说"继续"，或直接补充要求。）' });
    saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    saveJob(job);
  }
}

// 计划缓存：planId -> { nodeId, prompt, commands, at }
const plans = new Map();

/** 只让模型出计划，不执行 */
async function makePlan(nodeId, prompt) {
  const messages = [
    { role: 'system', content: AI_SYSTEM },
    { role: 'system', content: '现在只做计划，不要执行任何命令。只输出一个 JSON 对象，形如 {"commands":[{"command":"Get-PSDrive C","reason":"看剩余空间"}]}，最多 5 条，不要输出别的文字。' },
    { role: 'user', content: prompt },
  ];
  const reply = await callModel(messages);
  let calls = [];
  const raw = String(reply.content || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]);
      calls = (obj.commands || []).slice(0, 5).map((c) => ({
        command: String(c.command || c.cmd || ''),
        reason: String(c.reason || ''),
      })).filter((c) => c.command);
    } catch {}
  }
  if (!calls.length) {
    // 模型没按格式来：退化成用 tool_calls 里的命令
    calls = (reply.toolCalls || []).slice(0, 5).map((c) => {
      let args = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
      return { command: String(args.command || ''), reason: String(args.reason || '') };
    }).filter((c) => c.command);
  }

  const planId = 'p' + crypto.randomBytes(6).toString('hex');
  plans.set(planId, { nodeId, prompt, commands: calls, at: Date.now() });
  if (plans.size > 200) plans.delete(plans.keys().next().value);
  return { planId, steps: calls, note: reply.content || '' };
}

/** 按人工确认过的命令清单执行，最后统一总结 */
async function runPlanJob(job) {
  const plan = plans.get(job.planId);
  if (!plan) {
    job.status = 'error';
    job.error = '计划已过期，请重新生成';
    saveJob(job);
    return;
  }
  try {
    for (const cmd of plan.commands) {
      if (job.stopRequested) { job.status = 'stopped'; saveJob(job); return; }
      const stepRef = { type: 'tool', command: cmd.command, reason: cmd.reason, status: 'running', at: Date.now() };
      job.steps.push(stepRef);
      saveJob(job);
      const task = createTask(job.nodeId, 'shell', { command: cmd.command, timeoutMs: 120000 });
      stepRef.taskId = task.id;
      const done = await waitTask(task.id, AI_TASK_TIMEOUT_MS);
      stepRef.status = 'done';
      stepRef.ms = done?.result?.ms;
      stepRef.exitCode = done?.result?.code;
      try { stepRef.output = fs.readFileSync(logFile(task.id), 'utf8').slice(-AI_LIVE_LIMIT); } catch { stepRef.output = ''; }
      saveJob(job);
    }

    // 收尾：让模型基于真实输出给结论
    const transcript = job.steps.map((s, i) => `#${i + 1} ${s.command}\n[exit ${s.exitCode}]\n${(s.output || '').slice(0, 3000)}`).join('\n\n');
    const reply = await callModel([
      { role: 'system', content: AI_SYSTEM },
      { role: 'user', content: `用户需求：${job.prompt}\n\n下面是已经执行完的命令和输出：\n${transcript}\n\n请用中文给结论。` },
    ]);
    job.steps.push({ type: 'answer', text: reply.content || '（模型没有给出结论）' });
    job.status = 'done';
    job.finishedAt = Date.now();
    saveJob(job);
  } catch (e) {
    job.status = 'error';
    job.error = String(e.message || e);
    saveJob(job);
  }
}

function startAiJob(nodeId, prompt) {
  const id = 'a' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const job = { id, nodeId, prompt, status: 'running', steps: [], createdAt: Date.now() };
  jobs.set(id, job);
  saveJob(job);
  runAiJob(job); // 后台跑，HTTP 立刻返回
  return job;
}
/* --------------------------------------------------------------- LLM 网关 */

async function proxyLlm(req, res, url) {
  const key = String(req.headers['x-api-key'] || '');
  const node = findNodeByToken(key);
  if (!node) return json(res, 401, { error: { message: '节点令牌无效' } });
  if (node.frozen) return json(res, 403, { error: { message: '节点已被冻结，模型通道关闭' } });
  if (!UPSTREAM_KEY) return json(res, 503, { error: { message: '指挥端未配置 UPSTREAM_API_KEY' } });

  node.llmRequests = (node.llmRequests || 0) + 1;
  node.lastLlmAt = Date.now();
  save();

  const target = UPSTREAM_BASE + url.pathname.replace(/^\/llm/, '') + (url.search || '');
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        accept: req.headers.accept || '*/*',
        'x-api-key': UPSTREAM_KEY,
        authorization: `Bearer ${UPSTREAM_KEY}`,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      },
      body,
    });
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      'cache-control': 'no-store',
      'x-fleet-node': node.id,
    });
    if (!upstream.body) return res.end();
    for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (e) {
    json(res, 502, { error: { message: '上游转发失败: ' + e.message } });
  }
}

/* ------------------------------------------------------------------ router */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // CORS：给 Harness 插件（不同端口）直接调用
  res.setHeader('access-control-allow-origin', req.headers.origin || '*');
  res.setHeader('access-control-allow-headers', 'content-type,x-ctl-token');
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('vary', 'origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    /* ---------- 静态面板 ---------- */
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(HERE, 'panel.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    }

    /* ---------- LLM 网关 ---------- */
    if (p.startsWith('/llm/')) return proxyLlm(req, res, url);

    /* ---------- 登录 ---------- */
    if (p === '/api/login' && req.method === 'POST') {
      const ip = String(req.socket.remoteAddress || '');
      if (loginBlocked(ip)) return json(res, 429, { error: '口令错误次数过多，请 10 分钟后再试' });
      const body = await readBody(req);
      if (sha(body?.password || '') !== sha(PASSWORD)) {
        loginFail(ip);
        return json(res, 401, { error: '口令错误' });
      }
      loginFails.delete(ip);
      const token = crypto.randomBytes(24).toString('base64url');
      sessions.set(token, { at: Date.now() });
      saveSessions();
      return json(res, 200, { token });
    }

    /* ---------- 一键接入（给同事用，无需任何配置） ---------- */
    if (p === '/download/lite.zip' && (req.method === 'GET' || req.method === 'HEAD')) {
      // 兼容旧布局（dist 在主控端旁边）和新布局（dist 在 被控端 下）
      const candidates = [
        path.join(HERE, '..', '被控端', 'dist', '_source', 'lite', 'payload.zip'),
        path.join(HERE, '..', 'dist', '_source', 'lite', 'payload.zip'),
        path.join(HERE, '..', 'node', 'dist', '_source', 'lite', 'payload.zip'),
      ];
      const zip = candidates.find((p) => fs.existsSync(p));
      if (!zip) return json(res, 404, { error: '安装包还没生成：在被控端\build 里跑 build.ps1 -Target lite' });
      const st = fs.statSync(zip);
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': st.size, 'cache-control': 'no-store' });
      return fs.createReadStream(zip).pipe(res);
    }

    if (p === '/join' && req.method === 'GET') {
      const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
      const base = `${proto}://${req.headers.host}`;
      const script = [
        '# DSH Fleet 一键接入（免管理员，装到当前用户目录）',
        "$ErrorActionPreference = 'Stop'",
        '$ProgressPreference = "SilentlyContinue"',
        'Write-Host "正在下载（33MB）..." -ForegroundColor Cyan',
        '$tmp = Join-Path $env:TEMP "dsh-fleet-lite.zip"',
        `Invoke-WebRequest -Uri '${base}/download/lite.zip' -OutFile $tmp -UseBasicParsing`,
        'Write-Host "正在解压..." -ForegroundColor Cyan',
        '$dir = Join-Path $env:LOCALAPPDATA "DSH Fleet"',
        'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
        '& tar.exe -xf $tmp -C $dir',
        'if ($LASTEXITCODE -ne 0) { throw "解压失败" }',
        'Remove-Item $tmp -Force -ErrorAction SilentlyContinue',
        'Write-Host "正在注册（当前用户，不需要管理员）..." -ForegroundColor Cyan',
        `& "$dir\\fleet\\install.ps1" -Mode user -NoElevate -ControlUrl '${base}'`,
        'Write-Host ""',
        'Write-Host "[完成] 这台机器已经接入，回去看控制台就行。" -ForegroundColor Green',
        'Write-Host "  卸载：powershell -File "$env:LOCALAPPDATA\\DSH Fleet\\fleet\\uninstall.ps1" -RemoveApp"',
      ].join("\r\n");
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(script);
    }

    /* ---------- 安装包自助登记 ---------- */
    if (p === '/api/agent/enroll' && req.method === 'POST') {
      const body = await readBody(req);
      const key = String(body?.key || req.headers['x-enroll-key'] || '').trim();
      if (!key || key !== ENROLL_KEY) return json(res, 403, { error: 'enroll key 不正确' });
      const id = 'n' + crypto.randomBytes(5).toString('hex');
      const token = crypto.randomBytes(24).toString('base64url');
      state.nodes[id] = {
        id,
        label: String(body?.label || body?.hostname || id).slice(0, 60),
        tokenHash: sha(token),
        tokenPreview: token.slice(0, 6) + '…',
        created: Date.now(),
        queue: [],
        frozen: false,
        version: null,
      };
      save();
      const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
      return json(res, 200, { nodeId: id, token, control: `${proto}://${req.headers.host}` });
    }

    /* ---------- 节点侧 ---------- */
    if (p === '/api/agent/hello' && req.method === 'POST') {
      const body = await readBody(req);
      const node = agentAuth(req, url);
      if (!node) return json(res, 401, { error: 'unknown token' });
      upsertNode({ id: node.id, label: body?.label, version: body?.version, meta: { hostname: body?.hostname, user: body?.user } });
      node.online = true;
      save();
      return json(res, 200, { ok: true, nodeId: node.id, frozen: !!node.frozen, serverTime: Date.now() });
    }

    if (p === '/api/agent/heartbeat' && req.method === 'POST') {
      const body = await readBody(req);
      const node = agentAuth(req, url);
      if (!node) return json(res, 401, { error: 'unknown token' });
      upsertNode({ id: node.id, label: body?.label, version: body?.version });
      node.metrics = body?.metrics || node.metrics;
      node.lastSeen = Date.now();
      save();
      return json(res, 200, { ok: true, frozen: !!node.frozen });
    }

    if (p === '/api/agent/poll' && req.method === 'GET') {
      const node = agentAuth(req, url);
      if (!node) return json(res, 401, { error: 'unknown token' });
      node.lastSeen = Date.now();
      node.lastPoll = Date.now();
      if (node.frozen) return json(res, 200, { frozen: true, tasks: [] });
      const slots = Math.max(1, Number(url.searchParams.get('slots') || 1));
      const wait = Math.min(30, Math.max(0, Number(url.searchParams.get('wait') || 0)));

      const immediate = takeQueued(node.id, slots);
      if (immediate.length || wait === 0) return json(res, 200, { tasks: immediate });

      const replied = await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        waiters.set(node.id, finish);
        setTimeout(() => { if (waiters.get(node.id) === finish) waiters.delete(node.id); finish(); }, wait * 1000);
      });
      void replied;
      if (node.frozen) return json(res, 200, { frozen: true, tasks: [] });
      return json(res, 200, { tasks: takeQueued(node.id, slots) });
    }

    if (p === '/api/agent/event' && req.method === 'POST') {
      const body = await readBody(req);
      const node = agentAuth(req, url);
      if (!node) return json(res, 401, { error: 'unknown token' });
      for (const ev of body?.events || []) {
        try { fs.appendFileSync(logFile(String(ev.taskId)), ev.stream === 'stderr' ? `\u0001ERR ${ev.data}` : ev.data); } catch {}
      }
      node.lastSeen = Date.now();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/agent/result' && req.method === 'POST') {
      const body = await readBody(req);
      const node = agentAuth(req, url);
      if (!node) return json(res, 401, { error: 'unknown token' });
      const task = updateTask(String(body?.taskId), { status: 'done', result: body?.result || {}, finishedAt: Date.now() });
      node.lastSeen = Date.now();
      save();
      return json(res, 200, { ok: true, task: task?.id });
    }

    if (p === '/api/agent/bundle' && req.method === 'GET') {
      const node = agentAuth(req, url);
      if (!node) return json(res, 401, { error: 'unknown token' });
      const code = fs.readFileSync(path.join(HERE, '..', 'agent', 'agent.mjs'));
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': code.length });
      return res.end(code);
    }

    /* ---------- 控制台侧 ---------- */
    if (!controlAuth(req)) return json(res, 401, { error: '需要登录' });

    // 强制清空这台机器的队列（卡死时用）
    if (p.match(/^\/api\/nodes\/([^/]+)\/reset$/) && req.method === 'POST') {
      const node = state.nodes[p.match(/^\/api\/nodes\/([^/]+)\/reset$/)[1]];
      if (!node) return json(res, 404, { error: '没有这个节点' });
      const cleared = (node.queue || []).length;
      node.queue = [];
      node.resetAt = Date.now();
      save();
      return json(res, 200, { ok: true, cleared });
    }

    // 给节点改个备注名（面板里双击机器名用）
    const renameMatch = p.match(/^\/api\/nodes\/([^/]+)$/);
    if (renameMatch && req.method === 'PATCH') {
      const node = state.nodes[renameMatch[1]];
      if (!node) return json(res, 404, { error: '没有这个节点' });
      const body = await readBody(req);
      const label = String(body?.label || '').trim().slice(0, 60);
      if (label) node.label = label;
      save();
      return json(res, 200, { ok: true, node });
    }

    if (p === '/api/nodes' && req.method === 'GET') {
      const nodes = Object.values(state.nodes).map(nodeSummary).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
      return json(res, 200, { nodes, serverTime: Date.now() });
    }

    if (p === '/api/enroll' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const id = body.nodeId || 'n' + crypto.randomBytes(5).toString('hex');
      const token = crypto.randomBytes(24).toString('base64url');
      state.nodes[id] = {
        id,
        label: body.label || id,
        tokenHash: sha(token),
        tokenPreview: token.slice(0, 6) + '…',
        created: Date.now(),
        queue: [],
        frozen: false,
        version: null,
      };
      save();
      const proto = String(req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
      return json(res, 200, { nodeId: id, token, control: `${proto}://${req.headers.host}` });
    }

    if (p === '/api/ai/run' && req.method === 'POST') {
      // 带 planId = 执行人工确认过的计划

      const body = await readBody(req);
      const node = state.nodes[body?.nodeId];
      if (!node) return json(res, 404, { error: '节点不存在' });
      if (!body?.prompt || !String(body.prompt).trim()) return json(res, 400, { error: '说点什么再发' });
      if (Date.now() - (node.lastSeen || 0) > 90000) return json(res, 409, { error: '这台机器当前离线，先让它连上' });

      // 执行确认过的计划
      if (body?.planId) {
        const plan = plans.get(String(body.planId));
        if (!plan) return json(res, 404, { error: '计划已过期，请重新生成' });
        if (plan.nodeId !== node.id) return json(res, 400, { error: '计划与节点不匹配' });
        const job = {
          id: 'amv' + crypto.randomBytes(6).toString('hex'),
          nodeId: node.id,
          prompt: String(body.prompt).trim() || plan.prompt,
          status: 'running',
          steps: [],
          createdAt: Date.now(),
          planId: String(body.planId),
        };
        jobs.set(job.id, job);
        saveJob(job);
        runPlanJob(job).catch((e) => { job.status = 'error'; job.error = String(e.message || e); saveJob(job); });
        return json(res, 200, { job });
      }

      const job = startAiJob(node.id, String(body.prompt).trim());
      return json(res, 200, { job });
    }

    const stopMatch = p.match(/^\/api\/ai\/job\/([^/]+)\/stop$/);
    if (stopMatch && req.method === 'POST') {
      const job = jobs.get(stopMatch[1]);
      if (!job) return json(res, 404, { error: '没有这个任务' });
      job.stopRequested = true;
      if (job.status === 'running') job.status = 'stopping';

      // 关键：把正在执行的远端进程杀掉，而不是等它超时
      let killed = 0;
      for (const st of job.steps || []) {
        if (st.type === 'tool' && st.status === 'running' && st.taskId) {
          try {
            createTask(job.nodeId, 'cancel', { taskId: st.taskId });
            killed++;
          } catch {}
        }
      }

      saveJob(job);
      return json(res, 200, { ok: true, killed, job });
    }

    if (p === '/api/ai/plan' && req.method === 'POST') {
      const body = await readBody(req);
      const nodeId = String(body?.nodeId || '');
      const prompt = String(body?.prompt || '').trim();
      if (!state.nodes[nodeId]) return json(res, 404, { error: '没有这个节点' });
      if (!prompt) return json(res, 400, { error: 'prompt 为空' });
      try {
        const plan = await makePlan(nodeId, prompt);
        return json(res, 200, plan);
      } catch (e) {
        return json(res, 500, { error: String(e.message || e) });
      }
    }

    const aiMatch = p.match(/^\/api\/ai\/job\/([^/]+)$/);
    if (aiMatch && req.method === 'GET') {
      let job = jobs.get(aiMatch[1]);
      if (!job) { try { job = JSON.parse(fs.readFileSync(aiFile(aiMatch[1]), 'utf8')); } catch {} }
      if (!job) return json(res, 404, { error: '没有这个任务' });

      // 运行中的命令：把已产生的输出实时带上，面板就能像终端一样刷新
      for (const st of job.steps || []) {
        if (st.type === 'tool' && st.status === 'running' && st.taskId) {
          try {
            const txt = fs.readFileSync(logFile(st.taskId), 'utf8');
            st.output = txt.slice(-AI_LIVE_LIMIT);
          } catch {}
        }
      }

      return json(res, 200, { job });
    }

    if (p === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        model: AI_MODEL,
        hasKey: !!UPSTREAM_KEY,
        mock: AI_MOCK,
        enrollKey: ENROLL_KEY,
        upstream: UPSTREAM_BASE,
      });
    }

    if (p === '/api/tasks' && req.method === 'GET') {
      const nodeId = url.searchParams.get('node') || '';
      const files = fs.readdirSync(TASKS).filter((f) => f.endsWith('.json')).slice(-400);
      const out = [];
      for (const f of files) {
        try {
          const tk = JSON.parse(fs.readFileSync(path.join(TASKS, f), 'utf8'));
          if (nodeId && tk.nodeId !== nodeId) continue;
          out.push({ id: tk.id, nodeId: tk.nodeId, kind: tk.kind, status: tk.status, created: tk.created, code: tk.result?.code, ms: tk.result?.ms });
        } catch {}
      }
      out.sort((a, b) => b.created - a.created);
      return json(res, 200, { tasks: out.slice(0, 20) });
    }

    if (p === '/api/ai/jobs' && req.method === 'GET') {
      const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
      return json(res, 200, { jobs: list });
    }
    let m = p.match(/^\/api\/nodes\/([^/]+)\/task$/);
    if (m && req.method === 'POST') {
      const body = await readBody(req);
      const node = state.nodes[m[1]];
      if (!node) return json(res, 404, { error: '节点不存在' });
      const task = createTask(node.id, body?.kind || 'shell', body?.payload || {});
      return json(res, 200, { task });
    }

    m = p.match(/^\/api\/nodes\/([^/]+)\/(freeze|resume|purge|update)$/);
    if (m && req.method === 'POST') {
      const node = state.nodes[m[1]];
      if (!node) return json(res, 404, { error: '节点不存在' });
      const action = m[2];
      if (action === 'freeze') node.frozen = true;
      if (action === 'resume') node.frozen = false;
      save();
      if (action === 'freeze' || action === 'resume') {
        return json(res, 200, { ok: true, frozen: !!node.frozen });
      }
      const kind = action === 'purge' ? 'purge' : 'update_agent';
      const task = createTask(node.id, kind, {});
      return json(res, 200, { ok: true, task });
    }

    m = p.match(/^\/api\/tasks\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const task = readTask(m[1]);
      if (!task) return json(res, 404, { error: '任务不存在' });
      return json(res, 200, { task });
    }

    m = p.match(/^\/api\/tasks\/([^/]+)\/log$/);
    if (m && req.method === 'GET') {
      const file = logFile(m[1]);
      if (!fs.existsSync(file)) return json(res, 404, { error: '任务不存在' });
      const offset = Number(url.searchParams.get('offset') || 0);
      const buf = fs.readFileSync(file);
      const chunk = buf.subarray(Math.min(offset, buf.length)).toString('utf8');
      const task = readTask(m[1]);
      return json(res, 200, { offset: buf.length, chunk, status: task?.status, result: task?.result });
    }

    m = p.match(/^\/api\/nodes\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      delete state.nodes[m[1]];
      save();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    try { json(res, 500, { error: e.message }); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  restoreJobs();
  rotateTasks();
  loadSessions();
  console.log(`DSH Fleet 控制台: http://127.0.0.1:${PORT}/   （口令见 data/password.txt 或 FLEET_PASSWORD）`);
  console.log(`LLM 网关: ${UPSTREAM_KEY ? '已配置上游 Key' : '未配置 UPSTREAM_API_KEY（/llm 将返回 503）'} -> ${UPSTREAM_BASE}`);
  console.log(`监听: ${HOST}:${PORT}`);
});
