import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Phone organization is persisted independently from Desktop's preferences so
// concurrent Desktop settings writes cannot overwrite a phone action.
export class MobileOrganization {
  constructor(stateDir) { this.path = join(stateDir, 'organization.json'); this.data = { pins: [], unread: [], groups: [], assignments: {} }; this.writes = Promise.resolve(); }
  async init() { try { const value = JSON.parse(await readFile(this.path, 'utf8')); this.data = { ...this.data, ...value }; } catch (error) { if (error.code !== 'ENOENT') throw error; } return this; }
  get() { return structuredClone(this.data); }
  async save() { const text = JSON.stringify(this.data); this.writes = this.writes.catch(() => {}).then(async () => { await writeFile(this.path + '.tmp', text, { mode: 0o600 }); await rename(this.path + '.tmp', this.path); }); await this.writes; return this.get(); }
  id(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{1,200}$/.test(value) || ['__proto__','constructor','prototype'].includes(value)) throw new Error('任务编号无效'); return value; }
  async handle(data) {
    if (['pin', 'unread', 'read'].includes(data.action)) {
      const id = this.id(data.threadId), key = data.action === 'pin' ? 'pins' : 'unread', enabled = data.action === 'read' ? false : data.enabled;
      if (typeof enabled !== 'boolean') throw new Error('设置无效');
      const values = new Set(this.data[key]); enabled ? values.add(id) : values.delete(id); if (values.size > 2000) throw new Error('保存的任务标记过多'); this.data[key] = [...values];
    } else if (data.action === 'groupCreate') {
      const name = String(data.name || '').trim().slice(0,80); if (!name) throw new Error('请输入分组名称'); if (this.data.groups.length >= 100) throw new Error('最多创建 100 个分组');
      this.data.groups.push({ id: randomUUID(), name, color: '#8b8b8b' });
    } else if (['groupUpdate', 'groupRemove', 'groupMove'].includes(data.action)) {
      const index = this.data.groups.findIndex(g => g.id === data.id); if (index < 0) throw new Error('分组不存在'); const group = this.data.groups[index];
      if (data.action === 'groupUpdate') { if (data.name != null) { const name = String(data.name).trim().slice(0,80); if (!name) throw new Error('请输入分组名称'); group.name = name; } if (/^#[a-fA-F0-9]{6}$/.test(data.color || '')) group.color = data.color; }
      else if (data.action === 'groupMove') { const destination = data.direction === 'up' ? Math.max(0,index - 1) : Math.min(this.data.groups.length - 1,index + 1); this.data.groups.splice(index,1); this.data.groups.splice(destination,0,group); }
      else { this.data.groups.splice(index,1); for (const [id, value] of Object.entries(this.data.assignments)) if (value === data.id) delete this.data.assignments[id]; }
    } else if (data.action === 'assign') {
      const id = this.id(data.threadId); if (data.groupId == null) delete this.data.assignments[id]; else { if (!this.data.groups.some(g => g.id === data.groupId)) throw new Error('分组不存在'); this.data.assignments[id] = data.groupId; }
    } else throw new Error('不支持的整理操作');
    return this.save();
  }
}
