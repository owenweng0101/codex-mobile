import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * 找到正在运行的 DeepSeek Harness 网页服务端口。
 *
 * 桌面端用 `--port 0` 启动，端口每次启动都不同，因此不能写死。这里从
 * DeepSeek Harness 的宿主进程读它监听的 TCP 端口，再用一次探测确认它
 * 就是 DSH 网页服务（未认证时会回答 401 并带固定提示语）。
 */

const execFileAsync = promisify(execFile);
const HOST_MARKER = 'dsh-desktop-host/lib/index.js';
const AUTH_HINT = 'dsh web authentication required';

/** 列出命令行里带 Harness 宿主标记的进程号。 */
export async function listHarnessPids({ run = defaultRun } = {}) {
  const { stdout } = await run('ps', ['-eo', 'pid=,args=']);
  return stdout.split('\n')
    .filter((line) => line.includes(HOST_MARKER))
    .filter((line) => {
      const command = line.trim().replace(/^\d+\s+/u, '').split(/\s+/u)[0] ?? '';
      const name = command.split('/').pop() ?? '';
      return !['grep', 'pgrep', 'ps', 'awk', 'rg'].includes(name);
    })
    .map((line) => Number(line.trim().split(/\s+/u)[0]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

/** 读某个进程在回环地址上监听的端口。 */
export async function listListeningPorts(pid, { run = defaultRun } = {}) {
  try {
    const { stdout } = await run('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']);
    return stdout.split('\n')
      .filter((line) => line.startsWith('n'))
      .map((line) => Number(line.slice(1).split(':').pop()))
      .filter((port) => Number.isSafeInteger(port) && port > 0 && port < 65536);
  } catch {
    return [];
  }
}

/** 判断端口上跑的是不是 DSH 网页服务。 */
export async function probeDshPort(port, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200), redirect: 'error' });
    const text = (await response.text()).slice(0, 400);
    return response.status === 401 && text.includes(AUTH_HINT);
  } catch {
    return false;
  }
}

async function defaultRun(command, args) {
  const { stdout } = await execFileAsync(command, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
  return { stdout };
}

/**
 * 发现当前 DSH 网页端口。
 * @param {object} [options]
 * @param {number} [options.preferred] 上一步使用的端口，仍然可用时优先复用
 * @param {number[]} [options.exclude] 不应被选中的端口
 */
export async function discoverDshPort({ preferred, exclude = [], ...seams } = {}) {
  if (Number.isSafeInteger(preferred) && preferred > 0 && !exclude.includes(preferred)) {
    if (await probeDshPort(preferred, seams)) return preferred;
  }
  const pids = await listHarnessPids(seams);
  const ports = new Set();
  for (const pid of pids) {
    for (const port of await listListeningPorts(pid, seams)) ports.add(port);
  }
  for (const port of ports) {
    if (exclude.includes(port)) continue;
    if (await probeDshPort(port, seams)) return port;
  }
  return null;
}
