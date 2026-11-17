import {mkdir, writeFile, rename, chmod, stat, unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

export const LABEL = 'com.wengqiang.mobile-qr';
const repository = fileURLToPath(new URL('../../', import.meta.url));
const xml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');

export function launchAgentPlan({root=process.env.MOBILE_CHATS_ROOT || repository, home=homedir(), node=process.execPath}={}) {
  if (!isAbsolute(root) || !isAbsolute(node)) throw Error('Repository and Node paths must be absolute');
  root = resolve(root);
  const script = join(root, 'desktop/mobile-qr/update.mjs');
  const state = join(home, 'Library/Application Support/MobileQR');
  const path = join(home, 'Library/LaunchAgents', LABEL + '.plist');
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(script)}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>MOBILE_CHATS_ROOT</key><string>${xml(root)}</string></dict>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>60</integer>
<key>StandardErrorPath</key><string>${xml(join(state,'error.log'))}</string>
</dict></plist>
`;
  return {label:LABEL, root, script, state, path, contents};
}

export async function installQrAgent({apply=false, run=execFileSync, platform=process.platform, uid=process.getuid?.(), ...options}={}) {
  const plan = launchAgentPlan(options);
  for (const file of [plan.script, join(plan.root,'connection/control-client.mjs')]) {
    if (!(await stat(file)).isFile()) throw Error('QR source is incomplete');
  }
  if (!apply) return {...plan, applied:false};
  if (platform !== 'darwin' || !Number.isInteger(uid)) throw Error('LaunchAgent installation requires macOS');
  const domain = `gui/${uid}`, service = domain + '/' + LABEL;
  await mkdir(plan.state, {recursive:true, mode:0o700});
  await mkdir(join(options.home || homedir(), 'Library/LaunchAgents'), {recursive:true});
  const temporary = plan.path + '.' + process.pid + '.tmp';
  try {
    await writeFile(temporary, plan.contents, {mode:0o600});
    run('plutil', ['-lint', temporary], {stdio:'pipe'});
    await rename(temporary, plan.path);
    await chmod(plan.path, 0o600);
  } finally {
    await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});
  }
  try { run('launchctl', ['bootout', service], {stdio:'pipe'}); }
  catch (error) { if (![3,113].includes(error.status)) throw error; }
  run('launchctl', ['enable', service], {stdio:'pipe'});
  run('launchctl', ['bootstrap', domain, plan.path], {stdio:'pipe'});
  return {...plan, applied:true};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--apply','--dry-run'].includes(arg)) || (args.includes('--apply') && args.includes('--dry-run'))) {
    console.error('用法：node desktop/mobile-qr/install.mjs [--dry-run | --apply]');
    process.exitCode = 1;
  } else {
    try {
      const plan = await installQrAgent({apply:args.includes('--apply')});
      console.log(`${plan.applied?'已安装':'安装预览（未写入或操作服务）'}：${plan.label}\n脚本：${plan.script}\nLaunchAgent：${plan.path}`);
    } catch { console.error('二维码维护任务安装失败；请检查仓库路径与本机 LaunchAgent 状态。'); process.exitCode = 1; }
  }
}
