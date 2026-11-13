import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 打印当前手机网关状态与手机地址。 */
const port = Number(process.env.DSHM_PORT ?? 18902);
const label = 'com.wengqiang.dsh-mobile';
const domain = `gui/${process.getuid()}`;
let loaded = false;
try {
  execFileSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'pipe' });
  loaded = true;
} catch {}
console.log(loaded ? 'LaunchAgent：已加载' : 'LaunchAgent：未加载');
const state = join(homedir(), 'Library', 'Application Support', 'DshMobile');
// 与桌面二维码使用相同的连接状态来源，不依赖旧模型网关。
try {
  const { readMobileStatus, readDshStatus } = await import('../../desktop/mobile-qr/status.mjs');
  const mobile = await readMobileStatus();
  const value = await readDshStatus({ mobileStatus: mobile });
  if (value.status === 'online' || value.status === 'local') {
    console.log('状态：' + value.status + (value.provider ? '（' + value.provider + '）' : ''));
    console.log('Harness：' + (value.upstreamReady ? '运行中' : '未运行'));
    console.log('手机地址：' + (value.phoneUrl ?? '未取到'));
    process.exit(0);
  }
} catch {}
try {
  const response = await fetch(`http://127.0.0.1:${port}/_dsh/status`, { signal: AbortSignal.timeout(1500) });
  const value = await response.json();
  console.log('状态：' + value.status + '（' + value.provider + '）');
  console.log('上游：' + value.upstream);
  console.log('手机地址：' + value.phoneUrl);
} catch {
  console.log('网关未响应，请查看日志：' + join(state, 'dsh-mobile.error.log'));
  process.exitCode = 1;
}
