import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 安装/更新本机手机网关的 LaunchAgent，并等待它就绪。
 *
 * 只动自己的 label（com.wengqiang.dsh-mobile），不影响 Codex 的手机连接服务。
 */

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const state = join(homedir(), 'Library', 'Application Support', 'DshMobile');
const agents = join(homedir(), 'Library', 'LaunchAgents');
const label = 'com.wengqiang.dsh-mobile';
const port = Number(process.env.DSHM_PORT ?? 18902);
const basePath = process.env.DSHM_BASE_PATH ?? '/dsh';
const domain = `gui/${process.getuid()}`;

const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const args = [node, join(project, 'backend', 'server.mjs')].map((value) => `<string>${escape(value)}</string>`).join('');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args}</array>
  <key>WorkingDirectory</key><string>${escape(project)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSHM_PORT</key><string>${port}</string>
    <key>DSHM_BASE_PATH</key><string>${escape(basePath)}</string>
    <key>DSHM_TUNNEL</key><string>off</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(join(state, 'dsh-mobile.log'))}</string>
  <key>StandardErrorPath</key><string>${escape(join(state, 'dsh-mobile.error.log'))}</string>
</dict>
</plist>
`;

await mkdir(state, { recursive: true, mode: 0o700 });
await mkdir(agents, { recursive: true });
const plistPath = join(agents, `${label}.plist`);
await writeFile(plistPath, plist, { mode: 0o600 });
await chmod(plistPath, 0o600);
execFileSync('plutil', ['-lint', plistPath], { stdio: 'pipe' });

try {
  execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
} catch {}
// 先结束手动启动的副本：只认工作目录就是本项目的进程，别碰其它程序。
try {
  const ids = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  for (const id of ids) {
    let cwd = '';
    try {
      const listing = execFileSync('lsof', ['-a', '-p', id, '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
      cwd = listing.split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? '';
    } catch {}
    if (cwd !== project) {
      console.error(`端口 ${port} 被其它程序占用，未做处理（pid ${id}，cwd ${cwd || '未知'}）`);
      continue;
    }
    try {
      process.kill(Number(id), 'SIGTERM');
    } catch {}
  }
} catch {}
await new Promise((resolveWait) => setTimeout(resolveWait, 600));

execFileSync('launchctl', ['enable', `${domain}/${label}`], { stdio: 'pipe' });
// 端口还没释放时 bootstrap 会失败；等一会儿再试一次，最后用 kickstart 兜底。
const bootstrap = () => {
  try {
    execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' });
    return true;
  } catch (error) {
    return false;
  }
};
for (let attempt = 0; attempt < 20; attempt++) {
  const busy = (() => {
    try {
      const ids = execFileSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
      return ids.length > 0;
    } catch {
      return false;
    }
  })();
  if (!busy && bootstrap()) break;
  if (attempt === 19) {
    try {
      execFileSync('launchctl', ['kickstart', '-k', `${domain}/${label}`], { stdio: 'pipe' });
    } catch {}
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
}

let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_dsh/status`, { signal: AbortSignal.timeout(600) });
    if (response.ok) {
      const value = await response.json();
      if (value.service === 'dsh-mobile') {
        ready = true;
        console.log('DSH 手机组件已就绪；请使用桌面「手机连接」统一二维码。');
        break;
      }
    }
  } catch {}
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
}
if (!ready) {
  console.error('手机网关安装了但未就绪，请查看日志：' + join(state, 'dsh-mobile.error.log'));
  process.exitCode = 1;
} else {
  console.log('二维码文件夹：~/Desktop/手机连接/');
}
