import { execFileSync } from 'node:child_process';

const unavailable = () => new Error('无法核对运行中的后台状态，未停止服务。请稍后重试。');
export function inspectLegacyService({ execute = execFileSync, port = 8787 } = {}) {
  let listeners;
  try { listeners = execute('/usr/sbin/lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding:'utf8', stdio:['ignore','pipe','ignore'] }); }
  catch (error) { if (error.status === 1) return { running:false }; throw unavailable(); }
  const pids = [...new Set(listeners.trim().split(/\s+/).map(Number))];
  if (pids.length !== 1 || !Number.isInteger(pids[0]) || pids[0] < 1) throw unavailable();
  const output = execute('/bin/ps', ['-axo', 'pid,ppid,comm'], { encoding:'utf8', stdio:['ignore','pipe','ignore'] });
  const children = output.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean).filter(row => Number(row[2]) === pids[0]);
  const codex = children.filter(row => row[3] === '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const ssh = children.filter(row => row[3] === '/usr/bin/ssh');
  if (children.length !== codex.length + ssh.length || codex.length > 1 || ssh.length > 1) throw new Error('旧后台仍有终端或未完成的子进程，未停止服务。请先结束手机终端或等待操作完成，再更新。');
  return { running:true, pid:pids[0], livePTYCount:0 };
}

export async function prepareLocalUpdate({ baseUrl = 'http://127.0.0.1:8787', request = fetch, inspectLegacy = inspectLegacyService, now = Date.now } = {}) {
  const json = async (path, options = {}) => {
    const response = await request(baseUrl + path, { ...options, signal:AbortSignal.timeout(3000) });
    const value = await response.json(); return { response, value };
  };
  let info, status;
  try {
    const health = await json('/healthz');
    if (!health.response.ok || health.value.service !== 'codex-mobile-local') throw unavailable();
    const local = await json('/local/info'); if (!local.response.ok) throw unavailable(); info = local.value;
    const token = new URL(info.localUrl).hash.slice(1); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw unavailable();
    const result = await json('/api/status', { headers:{ authorization:'Bearer ' + token } });
    if (!result.response.ok || !result.value || typeof result.value !== 'object') throw unavailable(); status = result.value;
  } catch {
    if (inspectLegacy().running) throw unavailable();
    return { mode:'offline' };
  }
  if (Object.keys(status.ownedActive || status.active || {}).length) throw new Error('还有手机任务正在运行，等待任务完成后再更新服务。');
  if (!Object.hasOwn(status, 'terminal')) {
    const legacy = inspectLegacy(); return { mode:legacy.running ? 'legacy-verified' : 'offline', ...legacy };
  }
  if (!Number.isInteger(status.terminal?.livePTYCount) || status.terminal.livePTYCount < 0) throw unavailable();
  if (status.terminal.livePTYCount) throw new Error('手机终端仍在运行，未停止服务。请先明确结束终端，再更新后台。');
  const token = new URL(info.localUrl).hash.slice(1);
  const { response, value } = await json('/api/maintenance', { method:'POST', headers:{ authorization:'Bearer ' + token, 'content-type':'application/json' }, body:JSON.stringify({ action:'prepare-update' }) });
  if (!response.ok) throw new Error(value.error || '后台尚未准备好更新，未停止服务。');
  if (value.ok !== true || value.livePTYCount !== 0 || !/^[a-f0-9]{48}$/.test(value.token || '') || !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) throw unavailable();
  return { mode:'drained', token:value.token, expiresAt:value.expiresAt };
}

export function assertUpdatePermit(permit, now = Date.now()) {
  if (!permit || !['offline','legacy-verified','drained'].includes(permit.mode)) throw unavailable();
  if (permit.mode === 'drained' && permit.expiresAt <= now) throw new Error('后台更新准备已过期，未停止服务。请重新运行更新。');
}
