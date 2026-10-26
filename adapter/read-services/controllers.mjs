import {randomUUID} from 'node:crypto';
import {a as Emitter} from '../vendor/chunk-CM2YMK3U.js';
import {createOriginalControllerProjection} from './original-controller.mjs';

const unsupported=method=>Object.assign(new Error('Readonly Codex controller does not support '+method),{code:'CODEX_READ_ONLY_METHOD_UNAVAILABLE'});
const topics=new Set(['controller/workspaces','controller/tasks-index']);
const key=scope=>scope.workspaceIdentity?.trim()||scope.workspacePath;

export function wrapReadControllers(input,{api}={}){
  const channels={...input},frames=new Emitter(),unread=new Emitter(),controller=createOriginalControllerProjection({createId:randomUUID}),subscriptions=new Map();
  const sourceKeys=new Map();let disposed=false,pending=null;
  async function refresh(){
    if(disposed)return;if(pending)return pending;
    pending=(async()=>{
      const [tree,runtime]=await Promise.all([channels.project.readTree(),api?.get?api.get('/api/status').catch(()=>null):null]),groups=new Map();
      for(const task of tree.tasks){const scope={kind:'local',workspacePath:task.workspacePath,...(task.workspaceIdentity?{workspaceIdentity:task.workspaceIdentity}:{})};const id=key(scope);let value=groups.get(id);if(!value){value={scope,taskIndex:[]};groups.set(id,value);}value.taskIndex.push({meta:task,membership:{pinned:!!task.pinned,archived:!!task.archived,active:!task.archived}});}
      for(const project of tree.projects)for(const root of project.roots){if(!groups.has(root.rootPath))groups.set(root.rootPath,{scope:{kind:'local',workspacePath:root.rootPath},taskIndex:[]});}
      if(tree.conversationWorkspacePath&&!groups.has(tree.conversationWorkspacePath))groups.set(tree.conversationWorkspacePath,{scope:{kind:'local',workspacePath:tree.conversationWorkspacePath},taskIndex:[]});
      if(disposed)return;
      for(const [id,old]of sourceKeys)if(!groups.has(id)){controller.removeSource(old);sourceKeys.delete(id);}
      for(const [id,value]of groups){
        controller.registerSource({scope:value.scope,mutate:async()=>{throw unsupported('mutate');}});
        // The original UI reads activity from the session overlay. A running
        // membership alone falls back to idle in the original projection.
        const sessionsIndex=value.taskIndex.filter(({meta})=>!meta.archived&&!(runtime?.uncertainDesktop||[]).includes(meta.taskId)&&(meta.status==='running'||typeof runtime?.active?.[meta.taskId]==='string')).map(({meta})=>({taskId:meta.taskId,liveStatus:'running',activity:{phase:'running',lastActivityAt:meta.updatedAt}}));
        controller.replaceSourceSnapshot({...value,sessionsIndex});sourceKeys.set(id,value.scope);
      }
    })().finally(()=>{pending=null;});return pending;
  }
  const previous=channels['window-controller'];
  const service={
    async mutateTask(params){
      const address=params?.address,mutation=params?.mutation;
      if(!address||address.sourceServerId||address.remoteSessionId||address.workspaceIdentity||typeof address.workspacePath!=='string'||typeof address.taskId!=='string')throw unsupported('remote task mutation');
      const target={taskId:address.taskId,workspacePath:address.workspacePath};let result;
      if(mutation?.kind==='pin'&&typeof mutation.pinned==='boolean')result=await channels['zcode-task'].setTaskPinned({...target,pinned:mutation.pinned});
      else if(mutation?.kind==='archive'&&typeof mutation.archived==='boolean')result=await channels['zcode-task'][mutation.archived?'archiveTask':'unarchiveTask'](target);
      else throw unsupported('task mutation '+String(mutation?.kind));
      if(pending)await pending;
      await refresh();return result;
    },
    async subscribeControllerV4(params){
      if(disposed)throw Error('Controller connection disposed');if(!topics.has(params?.topic))throw Error('Unsupported controller topic');
      await refresh();
      const subscription=controller.subscribe({topic:params.topic,onFrame:frame=>frames.fire(frame)});
      subscriptions.set(subscription.subscriptionId,subscription);return{ack:subscription.ack};
    },
    async resyncControllerV4(params){if(!subscriptions.has(params?.subscriptionId))throw Error('Unknown controller subscription');await refresh();return{ack:controller.resync(params.subscriptionId)};},
    async unsubscribeControllerV4(params){subscriptions.get(params?.subscriptionId)?.dispose();subscriptions.delete(params?.subscriptionId);},
    onDynamicControllerFrame(){return frames.event;},
    onDynamicTaskUnreadSignal(){return unread.event;},
    async listTaskList(params={}){
      if(!Array.isArray(params.workspaceScopes))throw Error('Controller list requires explicit workspace scopes');
      if(!params.workspaceScopes.length)return{items:[],total:0,hasMore:false};
      for(const scope of params.workspaceScopes)if(scope.sourceServerId||scope.remoteSessionId)throw Error('Remote controller sources are not supported');
      await refresh();let rows=controller.getTasks();
      if(params.kind==='archived')rows=(await channels['zcode-task'].listArchivedTasks()).map(meta=>({meta,address:{taskId:meta.taskId,workspacePath:meta.workspacePath,...(meta.workspaceIdentity?{workspaceIdentity:meta.workspaceIdentity}:{})},membership:{archived:true,pinned:false,active:false},sourceAvailability:'online',liveStatus:meta.status==='completed'?'completed':meta.status==='error'?'error':'idle'}));
      rows=rows.filter(row=>params.workspaceScopes.some(scope=>key(scope)===key(row.address))&&
        (params.kind==='pinned'?row.membership.pinned&&!row.membership.archived:params.kind==='archived'?row.membership.archived:params.kind==='timeline'?!row.membership.pinned&&!row.membership.archived:!row.membership.archived));
      const query=params.search?.trim().toLocaleLowerCase();if(query)rows=rows.filter(row=>row.meta.title?.toLocaleLowerCase().includes(query));
      rows.sort((a,b)=>(params.sortBy==='created'?b.meta.createdAt-a.meta.createdAt:0)||b.meta.updatedAt-a.meta.updatedAt||a.meta.taskId.localeCompare(b.meta.taskId));
      const total=rows.length,limited=params.limit==null?rows:rows.slice(0,Math.max(0,Number(params.limit)||0));
      return{items:limited.map(row=>({...row.meta,sourceAvailability:row.sourceAvailability,liveStatus:row.liveStatus,...(row.activity?{activity:row.activity}:{})})),total,hasMore:limited.length<total};
    },
    async getTaskMeta(params){const address=params?.address||params;if(address?.sourceServerId||address?.remoteSessionId)throw Error('Remote task address unavailable');return channels['zcode-task'].getTaskMeta(address);},
  };
  channels['window-controller']=new Proxy(service,{get(target,name,receiver){if(name in target)return Reflect.get(target,name,receiver);if(previous)return Reflect.get(previous,name);return()=>{throw unsupported('window-controller.'+String(name));};}});
  const taskGroups=channels['task-groups'];
  channels['task-groups']=new Proxy(taskGroups,{get(target,name,receiver){
    if(name!=='admit')return Reflect.get(target,name,receiver);
    return async params=>{
      if(!Array.isArray(params?.tasks)||params.tasks.length>5000)throw Error('Invalid task group admission request');
      const tree=await channels.project.readTree(),known=new Map(tree.tasks.map(task=>[JSON.stringify([task.workspaceIdentity?.trim()||task.workspacePath,task.taskId]),task]));
      const ids=[];
      for(const task of params.tasks){if(task.hostId&&task.hostId!=='local')throw Error('Remote host unavailable in Codex read adapter');const value=known.get(JSON.stringify([task.workspaceIdentity?.trim()||task.workspacePath,task.taskId]));if(!value||value.workspacePath!==task.workspacePath)throw Error('Task was not found in the actual Codex catalog');ids.push(task.taskId);}
      return{readOnly:true,alreadyKnownTaskIds:ids,admittedTaskIds:[],groupsCreated:0};
    };
  }});
  return{channels,refresh,capabilities:{originalControllerProjection:true,readsOnly:true,taskGroupAdmission:'validate-existing-only',liveSessionOverlays:false,unreadSignals:false},dispose(){if(disposed)return;disposed=true;for(const subscription of subscriptions.values())subscription.dispose();subscriptions.clear();frames.dispose();unread.dispose();}};
}
