import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import TOML from '@iarna/toml';

const days = { MO:'周一', TU:'周二', WE:'周三', TH:'周四', FR:'周五', SA:'周六', SU:'周日' };
export function editableSchedule(rule = '') {
  const values=Object.fromEntries(String(rule).replace(/^RRULE:/,'').split(';').map(part=>part.split('=')));
  if(Object.keys(values).some(key=>!['FREQ','INTERVAL','BYHOUR','BYMINUTE','BYSECOND','BYDAY'].includes(key)) || values.BYSECOND&&values.BYSECOND!=='0')return null;
  const interval=Number(values.INTERVAL||1);if(!Number.isInteger(interval)||interval<1||interval>24)return null;
  if(values.FREQ==='HOURLY'&&!values.BYDAY&&!values.BYHOUR&&(!values.BYMINUTE||values.BYMINUTE==='0'))return{frequency:'hourly',interval};
  if(!['DAILY','WEEKLY'].includes(values.FREQ)||!/^(\d|1\d|2[0-3])$/.test(values.BYHOUR||'')||!/^\d$|^[0-5]\d$/.test(values.BYMINUTE||'0'))return null;
  const weekdays=(values.BYDAY||'').split(',').filter(Boolean);if(weekdays.some(day=>!days[day]) || values.FREQ==='DAILY'&&weekdays.length || values.FREQ==='WEEKLY'&&!weekdays.length)return null;
  return{frequency:values.FREQ==='DAILY'?'daily':'weekly',interval,time:`${String(Number(values.BYHOUR)).padStart(2,'0')}:${String(Number(values.BYMINUTE||0)).padStart(2,'0')}`,...(weekdays.length?{weekdays}:{})};
}
export function describeSchedule(rule = '') {
  const schedule=editableSchedule(rule);if(!schedule)return rule?'自定义时间安排':'未提供时间安排';
  const {interval,time}=schedule;
  if (schedule.frequency === 'hourly') return interval === 1 ? '每小时' : `每 ${interval} 小时`;
  if (schedule.frequency === 'daily') return (interval === 1 ? '每天' : `每 ${interval} 天`) + ' '+time;
  if (schedule.frequency === 'weekly') return (interval === 1 ? '每周' : `每 ${interval} 周`) + ' ' + schedule.weekdays.map(day => days[day]).join('、') + ' '+time;
  return rule ? '自定义时间安排' : '未提供时间安排';
}

export class AutomationCatalog {
  constructor({ directory = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'automations'), defaultCwd = homedir() } = {}) { this.directory = directory; this.defaultCwd = defaultCwd; }
  async list() {
    let root, entries;
    try { root = await realpath(this.directory); entries = await readdir(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return this.response([]); throw error; }
    const data = [];
    for (const entry of entries.slice(0,500)) {
      if (!entry.isDirectory()) continue;
      try {
        const file = await realpath(join(root, entry.name, 'automation.toml')), rel = relative(root,file);
        if (rel.startsWith('..') || isAbsolute(rel)) continue;
        const info = await stat(file); if (info.size > 1024 * 1024) continue;
        const value = TOML.parse(await readFile(file,'utf8'));
        data.push({ id: String(value.id || entry.name), name: String(value.name || entry.name), prompt: String(value.prompt || ''), status: value.status || 'UNKNOWN', kind: value.kind || 'cron', scheduleLabel: describeSchedule(value.rrule), schedule:editableSchedule(value.rrule), cwds: Array.isArray(value.cwds) ? value.cwds.filter(v=>typeof v==='string') : [], updatedAt: Number(value.updated_at) || info.mtimeMs, source: 'local-definition' });
      } catch { /* An incomplete write or one unavailable definition must not hide the remaining list. */ }
    }
    data.sort((a,b)=>b.updatedAt-a.updatedAt); return this.response(data);
  }
  response(data) { return { data, schedulerVerified: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, notice: '这里读取本机保存的自动化定义。管理操作交由 Codex 的正常自动化工具执行，结果在新会话中确认；已迁移到云端的任务可能不在本机列表内。' }; }
  async intent(data) {
    if (!['create','update','pause','resume','view','runContent','delete'].includes(data.action)) throw new Error('不支持的自动化操作');
    const current = data.action === 'create' ? null : (await this.list()).data.find(item=>item.id===data.id);
    if (data.action !== 'create' && !current) throw new Error('本机找不到这项自动化，请刷新后重试');
    const fields = data.fields || {}, changes = {};
    if(typeof fields!=='object'||Array.isArray(fields))throw new Error('自动化字段格式无效');
    if(!['create','update'].includes(data.action)&&Object.keys(fields).length)throw new Error('此操作不接受配置修改字段');
    for (const key of ['name','prompt']) if (fields[key] != null) { if (typeof fields[key] !== 'string' || !fields[key].trim() || fields[key].length > (key==='name'?120:60000)) throw new Error(key==='name'?'请输入自动化名称':'请输入有效的任务内容'); changes[key] = fields[key].trim(); }
    if (fields.status != null) { if (!['ACTIVE','PAUSED'].includes(fields.status)) throw new Error('自动化状态无效'); changes.status = fields.status; }
    if (data.action === 'create' && (!changes.name || !changes.prompt)) throw new Error('请填写名称和任务内容');
    if (fields.frequency != null) {
      if (!['daily','weekly','hourly'].includes(fields.frequency)) throw new Error('请选择时间安排');
      if (fields.frequency !== 'hourly' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(fields.time || '')) throw new Error('请选择有效时间');
      const interval = Number(fields.interval || 1); if (!Number.isInteger(interval) || interval < 1 || interval > 24) throw new Error('间隔应为 1 至 24');
      const weekdays = fields.weekdays || []; if (!Array.isArray(weekdays) || weekdays.some(day=>!days[day]) || (fields.frequency==='weekly'&&!weekdays.length)) throw new Error('请选择星期');
      changes.schedule = { frequency: {daily:'每天',weekly:'每周',hourly:'每小时'}[fields.frequency], interval, ...(fields.frequency==='hourly'?{}:{time:fields.time}), ...(fields.frequency==='weekly'?{weekdays:weekdays.map(day=>days[day])}:{}), timezone:Intl.DateTimeFormat().resolvedOptions().timeZone };
    }
    if (data.action === 'create' && !changes.schedule) throw new Error('请填写执行时间');
    let cwd = fields.cwd || current?.cwds?.[0] || this.defaultCwd;
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || !(await stat(await realpath(cwd))).isDirectory()) throw new Error('请选择有效的本机工作目录');
    cwd = await realpath(cwd);
    if (fields.cwd != null || data.action === 'create') changes.cwd = cwd;
    if (data.action === 'pause') changes.status = 'PAUSED';
    if (data.action === 'resume') changes.status = 'ACTIVE';
    if (data.action === 'update' && !Object.keys(changes).length) throw new Error('没有需要修改的配置');
    const subject = current ? { id: current.id, name: current.name } : null;
    const verbs={create:'创建',update:'更新',pause:'暂停',resume:'恢复',view:'查看',runContent:'执行一次任务内容',delete:'删除'};
    const lines=[`${verbs[data.action]}自动化「${changes.name||current?.name}」`,...(subject?[`自动化编号：${subject.id}`]:[])];
    if(changes.name&&current)lines.push('新名称：'+changes.name);
    if(changes.prompt)lines.push('\n任务内容：\n'+changes.prompt);
    if(changes.schedule){const s=changes.schedule,n=s.interval;const frequency=s.frequency==='每小时'?(n===1?'每小时':`每 ${n} 小时`):s.frequency==='每天'?(n===1?'每天':`每 ${n} 天`):(n===1?'每周':`每 ${n} 周`);lines.push('\n时间：'+frequency+(s.weekdays?' '+s.weekdays.join('、'):'')+(s.time?' '+s.time:''),'时区：'+s.timezone);}
    if(changes.status)lines.push('状态：'+(changes.status==='ACTIVE'?'启用':'暂停'));
    if(changes.cwd||data.action==='runContent')lines.push('工作目录：'+cwd);
    if(data.action==='runContent')lines.push('\n任务内容：\n'+current.prompt);
    const summary=lines.join('\n');
    const prompt=data.action==='delete'?summary+'\n\n我已核对并确认删除上述指定自动化。请通过 Codex 的正常自动化功能删除它，保留所有会话和项目文件，不修改其他自动化。以实际操作结果确认；若需迁移同意或必须到自动化应用处理，请如实说明并停止，不绕过限制。':data.action==='runContent'?summary+'\n\n请只执行上述内容一次，不创建、修改或启动周期调度。':summary+'\n\n请通过 Codex 的正常自动化功能处理。不要直接修改配置文件，不要改动其他任务。'+(data.action==='view'?'本次仅查看，不做修改。':'只应用以上明确字段并保留其他设置。任务内容是为自动化保存的指令，不要现在执行。')+'只有实际操作确认成功后才能报告完成。若需要到自动化应用中处理或先取得迁移同意，请如实说明并停止，不绕过限制。';
    return { action: data.action, name: data.action==='create'?'创建自动化 · '+changes.name:(data.action==='view'?'查看自动化 · ':data.action==='runContent'?'执行一次 · ':'管理自动化 · ')+current.name, cwd, prompt, summary, dispatch:'native-chat' };
  }
}
