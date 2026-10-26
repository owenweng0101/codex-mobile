import test from 'node:test';import assert from 'node:assert/strict';import {workspaceInfo,resolveNavigation} from '../navigation.mjs';
const tree={projects:[{id:'P',name:'Real Project',roots:[{rootPath:'/project'}]}],tasks:[{taskId:'T',workspacePath:'/project/sub',projectId:'P'},{taskId:'OTHER',workspacePath:'/other',projectId:null}]},status={cwd:'/configured',desktopOnline:true};
const context={tree,status,getTaskMeta:async()=>null};
test('workspace list is derived from real configured cwd, project roots and task metadata',()=>{const info=workspaceInfo(tree,status);assert(info.authenticated);assert.deepEqual(info.workspaces.map(w=>w.path),['/configured','/project','/project/sub','/other']);});
test('task navigation returns the actual task cwd and cannot move arbitrary tasks across projects',async()=>{const result=await resolveNavigation({action:'workspace',workspaceKey:'/project',options:{taskId:'T'}},context);assert.equal(result.workspacePath,'/project/sub');assert.equal(result.initialTaskId,'T');await assert.rejects(resolveNavigation({action:'workspace',workspaceKey:'/project',options:{taskId:'OTHER'}},context));await assert.rejects(resolveNavigation({action:'workspace',workspaceKey:'/etc'},context));await assert.rejects(resolveNavigation({action:'workspace',workspaceKey:'/project',options:{taskId:'T',taskHostId:'remote'}},context));});
test('new project draft resolves real metadata only and never creates a Codex task',async()=>{const result=await resolveNavigation({action:'project-draft',project:{projectId:'P',projectName:'forged'}},context);assert.equal(result.initialTaskDraft.projectName,'Real Project');assert.equal(result.initialTaskId,undefined);await assert.rejects(resolveNavigation({action:'project-draft',project:{projectId:'missing'}},context));});

test('mobile draft and existing-task navigation always enter the original chat view',async()=>{
 const tree={projects:[{id:'p',name:'P',roots:[{rootPath:'/work'}]}],tasks:[{taskId:'00000000-0000-0000-0000-000000000001',workspacePath:'/work'}]};
 const base={tree,status:{cwd:'/work'},getTaskMeta:async()=>null};
 for(const request of [{action:'draft',workspaceKey:'/work'},{action:'project-draft',project:{projectId:'p'}},{action:'workspace',workspaceKey:'/work',options:{taskId:tree.tasks[0].taskId}}])assert.equal((await resolveNavigation(request,base)).navigationIntent,'chat');
});

test('global new task opens a projectless draft in the registered conversation workspace',async()=>{
 const base={...context,tree:{...tree,conversationWorkspacePath:'/conversations'}};
 assert(workspaceInfo(base.tree,status).workspaces.some(w=>w.path==='/conversations'));
 for(const project of [{},{projectId:null},{projectId:null,hostId:'local'}]){
  const result=await resolveNavigation({action:'project-draft',project},base);
  assert.equal(result.workspacePath,'/conversations');
  assert.deepEqual(result.initialTaskDraft,{projectId:null,hostId:'local'});
  assert.equal(result.navigationIntent,'chat');
  assert.equal(result.initialTaskId,undefined);
 }
 await assert.rejects(resolveNavigation({action:'project-draft',project:{projectId:null,hostId:'remote'}},base));
 await assert.rejects(resolveNavigation({action:'project-draft',project:{projectId:'missing'}},base));
});

test('workspace drafts resolve project membership explicitly and discard stale task selections',async()=>{
 const base={...context,tree:{...tree,conversationWorkspacePath:'/conversations'}};
 for(const [workspaceKey,options,projectId,path] of [
  ['/project',{},'P','/project'],
  ['/project/sub',{},'P','/project'],
  ['/project',{projectId:null,taskId:'T',fileTreeTaskId:'T'},null,'/conversations'],
  ['/other',{},null,'/conversations'],
  ['/conversations',{},null,'/conversations'],
 ]){
  const result=await resolveNavigation({action:'draft',workspaceKey,options},base);
  assert.equal(result.initialTaskDraft.projectId,projectId);
  assert.equal(result.workspacePath,path);
  assert.equal(result.initialTaskId,undefined);
  assert.equal(result.navigationIntent,'chat');
 }
 for(const options of [{projectId:'missing'},{hostId:'remote'},{taskHostId:'remote'}])await assert.rejects(resolveNavigation({action:'draft',workspaceKey:'/project',options},base));
 await assert.rejects(resolveNavigation({action:'draft',workspaceKey:'/outside'},base));
});

test('draft navigation preserves original initialization while metadata remains authoritative',async()=>{
 const options={projectId:'P',projectName:'forged',hostId:'local',taskGroupId:null,provider:'codex-app',draftId:'draft-1',initialPrompt:'hello',initialPromptMention:{id:'skill',category:'skills',label:'Skill',value:'skill',markdown:'$skill'}};
 for(const request of [{action:'project-draft',project:options},{action:'draft',workspaceKey:'/project',options}]){
  const result=await resolveNavigation(request,context);
  assert.deepEqual(result.initialTaskDraft,{...options,projectName:'Real Project'});
 }
});

test('a workspace shared by projects requires explicit membership',async()=>{
 const base={...context,tree:{...tree,projects:[...tree.projects,{id:'P2',name:'Other',roots:[{rootPath:'/project'}]}]}};
 await assert.rejects(resolveNavigation({action:'draft',workspaceKey:'/project'},base),/多个项目/);
 assert.equal((await resolveNavigation({action:'draft',workspaceKey:'/project',options:{projectId:'P2'}},base)).initialTaskDraft.projectId,'P2');
});
