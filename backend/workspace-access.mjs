import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, basename } from 'node:path';

export function workspacePermissionError(root) {
  const folder={Documents:'“文稿”(Documents)',Desktop:'“桌面”(Desktop)',Downloads:'“下载”(Downloads)'}[basename(root || 'Documents')] || '所选';
  return Object.assign(new Error('需要在电脑端 macOS 提示中允许 Codex 手机后台的“node”访问'+folder+'文件夹。请点“允许”后重试。'), { code:'WORKSPACE_PERMISSION_REQUIRED', statusCode:423, retryable:true });
}

// A timeout must not start another readdir: the original macOS authorization
// request can still occupy a libuv worker until the user answers the prompt.
export class WorkspaceAccess {
  constructor({ protectedRoots = ['Documents','Desktop','Downloads'].map(name=>resolve(homedir(),name)), probe = root => readdir(root).then(() => undefined), timeoutMs = 1800 } = {}) {
    this.protectedRoots = protectedRoots.map(root => resolve(root)); this.probe = probe; this.timeoutMs = timeoutMs; this.pending = new Map();
  }
  protectedRoot(directory) { const absolute=resolve(directory); return this.protectedRoots.find(root=>absolute===root||absolute.startsWith(root+'/')) || null; }
  async ensure(directory) {
    const root=this.protectedRoot(directory); if(!root)return;
    let operation=this.pending.get(root);
    if(!operation) {
      operation=Promise.resolve().then(()=>this.probe(root)).catch(error=>{if(['EACCES','EPERM'].includes(error.code))throw workspacePermissionError(root);throw error;}).finally(()=>{if(this.pending.get(root)===operation)this.pending.delete(root);});
      this.pending.set(root,operation);
    }
    let timer;
    try { await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(workspacePermissionError(root)),this.timeoutMs);})]); }
    finally { clearTimeout(timer); }
  }
}
