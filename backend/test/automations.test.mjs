import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationCatalog, describeSchedule } from '../automations.mjs';

test('automation labels are human-readable and unknown schedules remain explicit', () => {
  assert.equal(describeSchedule('FREQ=DAILY;BYHOUR=4;BYMINUTE=0;BYSECOND=0'),'每天 04:00');
  assert.equal(describeSchedule('FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=30'),'每周 周一、周五 09:30');
  assert.equal(describeSchedule('FREQ=YEARLY'),'自定义时间安排');
});
test('automation page reads definitions and produces a request without modifying native configuration', async () => {
  const root = await mkdtemp(join(tmpdir(),'codex-mobile-automation-'));
  try {
    const directory=join(root,'automations');await mkdir(join(directory,'fixture'),{recursive:true});
    const file=join(directory,'fixture','automation.toml'),source='id="fixture"\nname="隔离任务"\nprompt="只读测试"\nstatus="PAUSED"\nrrule="FREQ=DAILY;BYHOUR=4;BYMINUTE=0"\nsecret_field="never-project-this"\n';
    await writeFile(file,source);const service=new AutomationCatalog({directory,defaultCwd:root});
    const list=await service.list();assert.equal(list.data.length,1);assert.equal(list.schedulerVerified,false);assert.ok(!JSON.stringify(list).includes('never-project-this'));
    const request=await service.intent({action:'resume',id:'fixture'});assert.equal(request.dispatch,'native-chat');assert.match(request.prompt,/Codex 的正常自动化功能/);assert.match(request.summary,/状态：启用/);assert.equal(await readFile(file,'utf8'),source);
    const created=await service.intent({action:'create',fields:{name:'新任务',prompt:'检查项目',frequency:'weekly',time:'08:30',weekdays:['MO'],cwd:root}});assert.match(created.prompt,/周一/);assert.equal((await service.list()).data.length,1);
    await assert.rejects(service.intent({action:'create',fields:{name:'x',prompt:'x',frequency:'daily',time:'29:99'}}),/有效时间/);
    await assert.rejects(service.intent({action:'pause',id:'../other'}),/找不到/);
    const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'automation.toml'),source.replace('fixture','outside'));await symlink(outside,join(directory,'symlink'));
    assert.equal((await service.list()).data.length,1);
  } finally { await rm(root,{recursive:true,force:true}); }
});
