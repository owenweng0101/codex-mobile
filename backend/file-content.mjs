import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { extname, basename } from 'node:path';
import { workspacePath } from './core.mjs';

const mediaTypes = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif', '.bmp':'image/bmp', '.pdf':'application/pdf', '.mp3':'audio/mpeg', '.m4a':'audio/mp4', '.wav':'audio/wav', '.ogg':'audio/ogg', '.mp4':'video/mp4', '.webm':'video/webm', '.mov':'video/quicktime' };
export async function sendWorkspaceContent(res, directory, path, { download = false } = {}) {
  const location = await workspacePath(directory, path), info = await stat(location.target);
  if (!info.isFile()) throw new Error('请选择文件');
  if (info.size > (download ? 256 : 64) * 1024 * 1024) throw new Error(download ? '此文件超过 256 MB，请在电脑上打开' : '文件超过 64 MB，请下载后查看');
  const type = mediaTypes[extname(location.path).toLowerCase()];
  if (!download && !type) throw new Error('此文件使用文本预览或下载打开');
  const filename = encodeURIComponent(basename(location.path));
  res.writeHead(200, { 'Content-Type': download ? 'application/octet-stream' : type, 'Content-Length': info.size, 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${filename}`, 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' });
  await pipeline(createReadStream(location.target), res);
}
