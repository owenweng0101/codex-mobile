import {mkdir, readFile, writeFile, rename, unlink, chmod, lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readStatuses} from './status.mjs';

export const QR_NAME = '手机连接.png';
export const STATUS_NAME = '连接状态.txt';
export const RETIRED_QR_NAMES = ['Codex 手机连接.png', 'DSH 手机连接.png'];

async function remove(file) {
  try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function atomic(file, data) {
  try {
    const previous = await lstat(file);
    if (previous.isFile() && (await readFile(file)).equals(data)) {
      await chmod(file, 0o600);
      return;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(dirname(file), '.' + basename(file) + '.' + process.pid + '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, data, {mode:0o600, flag:'wx'});
    await rename(temporary, file);
  } finally { await remove(temporary); }
}

function decodePng(value) {
  if (typeof value !== 'string' || value.length > 60000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value.slice('data:image/png;base64,'.length), 'base64');
  return bytes.length >= 100 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) ? bytes : null;
}

const usable = value => ['online','local'].includes(value?.status);

export async function updateDesktopQr({home=homedir(), getStatuses=readStatuses}={}) {
  const directory = join(home, 'Desktop', '手机连接');
  await mkdir(directory, {recursive:true, mode:0o700});
  await chmod(directory, 0o700);
  // Migration is unconditional. Offline never resurrects independent QR codes.
  for (const name of RETIRED_QR_NAMES) await remove(join(directory, name));
  let states;
  try { states = await getStatuses(); } catch { states = {}; }
  const {mobile, dsh, claude} = states || {};
  const png = usable(claude) ? decodePng(claude.qr) : null;
  if (png) await atomic(join(directory, QR_NAME), png);
  else await remove(join(directory, QR_NAME));
  const lines = [
    '手机连接状态（自动更新）',
    `三合一入口：${!png?'暂不可用，等待自动恢复':claude.status==='local'?'仅同一局域网可连接':'外网连接已就绪'}`,
    `Codex：${mobile?.status==='online'?'连接已就绪':'连接暂不可用，等待恢复'}`,
    `DSH：${!usable(dsh)?'连接暂不可用，等待恢复':!dsh.upstreamReady?'请先在电脑上打开 DeepSeek Harness':'聊天可用'}`,
    `Claude：${!usable(claude)?'连接暂不可用，等待恢复':!claude.upstreamReady?'电脑端暂未就绪':'聊天可用'}`,
    '', png?'扫「手机连接.png」一张码，顶部切换 Codex / DSH / Claude。':'统一二维码会在入口恢复后重新显示。',
    '电脑需要保持开机联网。二维码包含访问凭证，请勿公开分享。', ''
  ];
  await atomic(join(directory, STATUS_NAME), Buffer.from(lines.join('\n')));
  return {available:Boolean(png), directory};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await updateDesktopQr(); }
  catch { console.error('手机二维码更新失败，请检查本机服务和目录权限。'); process.exitCode = 1; }
}
