import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 停止并移除手机网关的 LaunchAgent（保留访问口令与日志）。 */
const label = 'com.wengqiang.dsh-mobile';
const domain = `gui/${process.getuid()}`;
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
try {
  execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' });
  console.log('已停止手机网关');
} catch {
  console.log('手机网关未在运行');
}
await rm(plistPath, { force: true });
