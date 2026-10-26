import { opendir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { workspacePath } from './core.mjs';

export async function searchWorkspaceFiles(root, query, path = '', { limit = 200, maxEntries = 20000, maxMs = 1500 } = {}) {
  if (typeof query !== 'string' || query.trim().length < 1 || query.length > 200) throw new Error('请输入 1 至 200 字的文件名或路径');
  const base = await workspacePath(root,path), term = query.trim().toLocaleLowerCase(), pending = [base.target], entries = [], started = Date.now();
  const ignored = new Set(['.git','node_modules','.next','.cache','target','dist','build']); let scanned = 0, truncated = false;
  while (pending.length) {
    if (Date.now()-started>maxMs || scanned>=maxEntries || entries.length>=limit) { truncated=true; break; }
    const directory = pending.shift(); let handle;
    try { handle = await opendir(directory); } catch { continue; }
    try {
      for await (const entry of handle) {
        if (++scanned>maxEntries || Date.now()-started>maxMs || entries.length>=limit) { truncated=true; break; }
        if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
        const target = join(directory,entry.name), filePath = relative(base.root,target);
        if (filePath.toLocaleLowerCase().includes(term)) entries.push({ name:entry.name, path:filePath, type:entry.isDirectory()?'directory':'file' });
        if (entry.isDirectory()) pending.push(target);
      }
    } catch (error) { if (!['EACCES','ENOENT','EPERM'].includes(error.code)) throw error; }
  }
  entries.sort((a,b)=>a.path.length-b.path.length || a.path.localeCompare(b.path));
  return { root:base.root, path:base.path, query:query.trim(), entries, scanned, truncated, scope:'文件名与相对路径' };
}
