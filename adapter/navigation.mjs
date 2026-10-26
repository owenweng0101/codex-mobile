import {basename} from 'node:path';
const invalid=message=>Object.assign(Error(message),{statusCode:400,code:'CODEX_NAVIGATION_INVALID'});
export function workspaceInfo(tree,status,{readOnly=true}={}){
  const paths=new Map();
  const add=(path,label)=>{if(typeof path==='string'&&path.startsWith('/')&&!path.includes('\0'))paths.set(path,paths.get(path)||{path,workspacePath:path,label:label||basename(path)||path,kind:'local'});};
  add(status.cwd,'Codex 本机');
  add(tree.conversationWorkspacePath,'独立对话');
  for(const project of tree.projects)for(const root of project.roots||[])add(root.rootPath,project.name);
  for(const task of tree.tasks)add(task.workspacePath);
  return{authenticated:true,deviceId:'codex-local-app',deviceName:'Codex · 当前 Mac',devicePlatform:process.platform,appVersion:'3.16.3',codexBridge:true,readOnly,desktopOnline:!!status.desktopOnline,workspaces:[...paths.values()],initialWorkspaceAbsPath:status.cwd};
}
export async function resolveNavigation(request,{tree,status,getTaskMeta}){
  if(!request||!['workspace','draft','reconnect','project-draft'].includes(request.action))throw invalid('导航动作无效');
  const info=workspaceInfo(tree,status);let context;
  if(request.action==='project-draft'||request.action==='draft'){
    let target=request.project;
    if(request.action==='draft'){
      const workspace=info.workspaces.find(value=>value.path===request.workspaceKey);
      if(!workspace)throw invalid('工作区不在真实 Codex 目录中');
      const options=request.options||{};
      if(options.taskHostId&&options.taskHostId!=='local')throw invalid('当前只连接本机 Codex');
      // startDraft is workspace-scoped; an explicit null detaches from it.
      let projects=tree.projects.filter(p=>p.roots?.some(root=>root.rootPath===workspace.path));
      if(!projects.length&&workspace.path!==tree.conversationWorkspacePath){
        const memberships=new Set(tree.tasks.filter(task=>task.workspacePath===workspace.path).map(task=>task.projectId??null));
        if(options.projectId===undefined&&memberships.size>1)throw invalid('工作区属于多个项目，请选择项目');
        projects=tree.projects.filter(p=>memberships.has(p.id));
      }
      if(options.projectId===undefined&&projects.length>1)throw invalid('工作区属于多个项目，请选择项目');
      target={...options,projectId:options.projectId===undefined?projects[0]?.id??null:options.projectId};
    }
    if(target?.hostId&&target.hostId!=='local')throw invalid('当前只连接本机 Codex');
    if(target?.projectId==null){
      const workspace=info.workspaces.find(value=>value.path===tree.conversationWorkspacePath);
      if(!workspace)throw invalid('本机独立对话目录不可用');
      context={workspacePath:workspace.path,initialTaskDraft:{projectId:null,hostId:'local'}};
    }else{
      const project=tree.projects.find(p=>p.id===target.projectId);
      if(!project?.roots?.[0])throw invalid('项目已不存在，请刷新项目列表');
      context={workspacePath:project.roots[0].rootPath,initialTaskDraft:{projectId:project.id,projectName:project.name,hostId:'local'}};
    }
    for(const field of ['provider','taskGroupId','draftId','initialPrompt','initialPromptMention']){
      if(target?.[field]!==undefined)context.initialTaskDraft[field]=target[field];
    }
  }else{
    const workspace=info.workspaces.find(value=>value.path===request.workspaceKey);
    if(!workspace)throw invalid('工作区不在真实 Codex 目录中');
    const options=request.options||{};
    if(options.taskHostId&&options.taskHostId!=='local')throw invalid('当前只连接本机 Codex');
    const id=options.taskId||options.fileTreeTaskId;
    if(id){
      const task=tree.tasks.find(t=>t.taskId===id)||await getTaskMeta({taskId:id});
      if(!task||!info.workspaces.some(w=>w.path===task.workspacePath))throw invalid('会话目录已变化，请刷新页面');
      const project=tree.projects.find(p=>p.id===task.projectId);
      if(task.workspacePath!==workspace.path&&!project?.roots.some(root=>root.rootPath===workspace.path))throw invalid('所选会话不属于该工作区');
      context={workspacePath:task.workspacePath,initialTaskId:task.taskId};
    }else context={workspacePath:workspace.path};
    if(options.openFileManager)context.fileTreeOpen=true;
    if(options.mobileNavigationIntent==='chat')context.navigationIntent='chat';
  }
  if(['draft','project-draft'].includes(request.action)||context.initialTaskId)context.navigationIntent='chat';
  return{...context,navigationKey:crypto.randomUUID()};
}
