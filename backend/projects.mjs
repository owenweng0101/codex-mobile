import {realpath,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';

function projectId(data) {
  if (typeof data.projectId !== 'string' || !data.projectId.trim()) throw new Error('请选择项目');
  return data.projectId.trim();
}
function projectName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || value.includes('\0')) throw new Error('项目名称需为 1–200 个字符');
  return value.trim();
}
async function projectRoots(roots) {
  if (!Array.isArray(roots) || !roots.length) throw new Error('请至少选择一个项目目录');
  const paths = new Set(),result=[];
  for (const root of roots) {
    if (!root || typeof root !== 'object' || Array.isArray(root) || typeof root.path !== 'string' || root.path.includes('\0') || !isAbsolute(root.path)) throw new Error('项目目录需使用完整绝对路径');
    let path;
    try { path = await realpath(root.path); if (!(await stat(path)).isDirectory()) throw new Error(); }
    catch { throw new Error('项目目录不存在或不是文件夹'); }
    if (paths.has(path)) throw new Error('项目目录不能重复');
    paths.add(path);result.push({path});
  }
  return result;
}
function projectMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v=>typeof v!=='string')) throw new Error('项目元数据格式无效');
  return {...value};
}

// All persistence goes through the installed app-server's official Project RPCs.
// project/delete deletes the project record and clears member threads' projectId;
// it neither deletes their chats nor removes any filesystem directories.
export class ProjectManager {
  constructor(core) {
    if (!core || typeof core.call !== 'function') throw new Error('需要 Codex 项目服务');
    this.core = core;
  }
  async handle(action,data={}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('项目请求格式无效');
    if (action === 'create') {
      const params={name:projectName(data.name),roots:await projectRoots(data.roots),idempotencyKey:typeof data.idempotencyKey==='string'&&data.idempotencyKey.trim()?data.idempotencyKey.trim():randomUUID()};
      if (data.metadata !== undefined && data.metadata !== null) params.metadata=projectMetadata(data.metadata);
      return this.core.call('project/create',params);
    }
    if (action === 'read') return this.core.call('project/read',{projectId:projectId(data)});
    if (action === 'update') {
      const params={projectId:projectId(data)};
      if (data.name !== undefined) params.name=projectName(data.name);
      if (data.roots !== undefined) params.roots=await projectRoots(data.roots);
      if (data.metadata !== undefined && data.metadata !== null) params.metadata=projectMetadata(data.metadata);
      if (Object.keys(params).length===1) throw new Error('请提供需要修改的项目名称或目录');
      return this.core.call('project/update',params);
    }
    if (action === 'remove') {
      const id=projectId(data);
      await this.core.call('project/delete',{projectId:id});
      return {ok:true,projectId:id};
    }
    throw new Error('不支持的项目操作');
  }
}
