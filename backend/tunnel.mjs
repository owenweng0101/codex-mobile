import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

export function extractTunnelUrl(output, provider) {
  const pattern = provider === 'cloudflare'
    ? /https:\/\/[-a-z0-9]+\.trycloudflare\.com\b/g
    : /tunneled with tls termination,\s*(https:\/\/[-a-z0-9]+\.lhr\.life)\b/g;
  const last = [...output.matchAll(pattern)].at(-1);
  return last ? (provider === 'cloudflare' ? last[0] : last[1]) : null;
}
export async function verifyTunnel(url, instance, fetcher = fetch) {
  const response = await fetcher(url + '/healthz', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error(`外网通道返回 ${response.status}`);
  const body = await response.json();
  if (body.service !== 'codex-mobile-local' || body.instance !== instance) throw new Error('外网通道没有连回本机服务');
  return true;
}

export class ManagedTunnel extends EventEmitter {
  constructor({ port, instance, stateDir, gateway, provider = process.env.TUNNEL_PROVIDER || 'localhostrun', spawnProcess = spawn, verify = verifyTunnel, checkInterval = 5000, retryDelay = 1500 }) {
    super(); Object.assign(this, { port, instance, stateDir, gateway, provider, spawnProcess, verify, checkInterval, retryDelay });
    this.state = { url: null, status: 'connecting', error: null, verifiedAt: null }; this.generation = 0; this.failures = 0; this.attempts = 0;
  }
  update(patch) { this.state = { ...this.state, ...patch }; this.emit('state', this.state); }
  start() { this.launch(); this.interval = setInterval(() => this.check(), this.checkInterval); return this; }
  launch() {
    if (this.stopped) return;
    const generation = ++this.generation; this.output = ''; this.candidate = null; this.failures = 0;
    this.update({ url: null, status: 'connecting', error: null });
    const command = this.provider === 'cloudflare' ? process.env.CLOUDFLARED_BIN || '/opt/homebrew/bin/cloudflared' : '/usr/bin/ssh';
    const common = ['-T', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10'];
    const args = this.provider === 'cloudflare'
      ? ['tunnel', '--url', `http://127.0.0.1:${this.port}`, '--protocol', 'http2', '--no-autoupdate']
      : this.provider === 'ssh'
      ? [...common, '-N', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-i', this.gateway.keyPath, '-R', `127.0.0.1:${this.gateway.reversePort}:127.0.0.1:${this.port}`, `${this.gateway.username}@${this.gateway.host}`]
      : [...common, '-o', 'IdentityFile=none', '-o', 'IdentitiesOnly=yes', '-o', `UserKnownHostsFile=${this.stateDir}/known_hosts`, '-o', 'StrictHostKeyChecking=accept-new', '-R', `80:127.0.0.1:${this.port}`, 'nokey@localhost.run'];
    const child = this.spawnProcess(command, args, { stdio: [this.provider === 'cloudflare' ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); this.child = child;
    const consume = chunk => {
      if (generation !== this.generation || this.stopped) return;
      this.output = (this.output + chunk.toString()).slice(-16000);
      const url = extractTunnelUrl(this.output, this.provider);
      if (url && url !== this.candidate) { this.candidate = url; this.failures = 0; this.update({ url: null, status: 'checking', error: null }); this.check(); }
    };
    if (this.provider === 'ssh') child.on('spawn', () => { if (generation !== this.generation) return; this.candidate = this.gateway.publicUrl; this.update({ status: 'checking' }); this.check(); });
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.on('error', () => { if (generation === this.generation) this.reconnect('隧道启动失败，正在重连'); });
    child.on('exit', () => { if (generation === this.generation && !this.stopped) this.reconnect('隧道已断开，正在重连'); });
    clearTimeout(this.startupTimer);
    this.startupTimer = setTimeout(() => { if (generation === this.generation && this.state.status !== 'online') this.reconnect('隧道未就绪，正在重连'); }, 30000);
  }
  async check() {
    if (this.stopped || !this.candidate || this.checking) return;
    this.checking = true; const url = this.candidate, generation = this.generation;
    try {
      await this.verify(url, this.instance);
      if (generation !== this.generation || url !== this.candidate || this.stopped) return;
      this.failures = 0; this.attempts = 0; clearTimeout(this.startupTimer);
      this.update({ url, status: 'online', error: null, verifiedAt: Date.now() });
    } catch (error) {
      if (generation !== this.generation || url !== this.candidate || this.stopped) return;
      this.failures += 1;
      this.update({ url: null, status: 'checking', error: '外网通道不可用，正在检查并重连' });
      if (this.failures >= 2) this.reconnect(error.message);
    } finally { this.checking = false; }
  }
  reconnect(reason) {
    if (this.stopped) return;
    ++this.generation; clearTimeout(this.startupTimer); clearTimeout(this.retryTimer); this.candidate = null;
    const old = this.child; this.child = null; old?.kill('SIGTERM');
    this.update({ url: null, status: 'reconnecting', error: '外网通道失效，正在自动重连', lastFailure: reason });
    this.retryTimer = setTimeout(() => this.launch(), Math.min(this.retryDelay * 2 ** this.attempts++, 30000));
  }
  stop() { this.stopped = true; ++this.generation; clearInterval(this.interval); clearTimeout(this.startupTimer); clearTimeout(this.retryTimer); this.child?.kill('SIGTERM'); this.update({ url: null, status: 'stopped' }); }
}
