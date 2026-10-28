/**
 * DSH Fleet 插件的 Node 半边。
 * 职责：确保主控端在后台跑着，用户不需要点任何东西。
 * 界面在 lib/client.js。
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const CONTROL_PORT = Number(process.env.FLEET_PORT || 7800);
const SERVER_DIR = process.env.FLEET_SERVER_DIR || 'F:\\dsh-fleet\\主控端';
const SERVER_JS = path.join(SERVER_DIR, 'server.mjs');

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(600, () => { s.destroy(); resolve(false); });
  });
}

function keyFileValue(file) {
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    return v || '';
  } catch {
    return '';
  }
}

async function ensureServer() {
  if (await portOpen(CONTROL_PORT)) return;
  if (!fs.existsSync(SERVER_JS)) {
    console.warn('[dsh-fleet] 找不到主控端: ' + SERVER_JS);
    return;
  }

  const env = { ...process.env, FLEET_PORT: String(CONTROL_PORT) };
  const key = keyFileValue(path.join(SERVER_DIR, 'upstream-key.txt'));
  if (key) env.UPSTREAM_API_KEY = key;
  env.ELECTRON_RUN_AS_NODE = '1';

  // 纯插件模式：真的在 Harness 进程里跑服务（关掉 Harness 就断）
  if (process.env.FLEET_EMBED === '1') {
    try {
      await import(pathToFileURL(SERVER_JS).href);
      console.log('[dsh-fleet] 已在 Harness 进程内启动主控端（纯插件模式）');
    } catch (e) {
      console.warn('[dsh-fleet] 进程内启动失败，回退到子进程: ' + e.message);
    }
    return;
  }

  try {
    const child = spawn(process.execPath, ['--expose-internals', SERVER_JS], {
      cwd: SERVER_DIR,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    console.log('[dsh-fleet] 已在后台启动主控端, pid=' + child.pid);
  } catch (e) {
    console.warn('[dsh-fleet] 启动主控端失败: ' + e.message);
  }
}

export function apply(ctx) {
  ensureServer().catch(() => {});
}
