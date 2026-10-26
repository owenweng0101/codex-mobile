import { projectHistoryMedia, assistantImageReferences, validateMediaReference, MEDIA_REASONS } from './history-media.mjs';

function mediaContext(context) { return context && typeof context === 'object' && !Array.isArray(context) ? context : {}; }
function publicMedia(value, context, itemId) {
  const reference=validateMediaReference(value?.reference), ctx=mediaContext(context);
  if (!reference || reference.itemId!==itemId || ctx.invalid || ctx.threadId!=null&&ctx.threadId!==reference.threadId || ctx.turnId!=null&&ctx.turnId!==reference.turnId) return { type:'image',status:'unresolved',reason:'INVALID_REFERENCE',message:MEDIA_REASONS.INVALID_REFERENCE,reference:null };
  if (value.status==='unresolved') { const reason=Object.hasOwn(MEDIA_REASONS,value.reason)?value.reason:'MEDIA_UNAVAILABLE'; return { type:'image',status:'unresolved',reason,message:MEDIA_REASONS[reason],reference }; }
  return { type:'image',status:'candidate',reference,url:'/api/thread-media?'+new URLSearchParams(Object.entries(reference).map(([key,entry])=>[key,String(entry)])) };
}

function attachmentMetadata(value) {
  if (!value || !/^[a-f0-9]{48}$/.test(value.id || '') || typeof value.name !== 'string' || !['image','document','text','archive'].includes(value.kind) || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 20*1024*1024) return null;
  return { type:'attachment', id:value.id, name:value.name.slice(0,150), kind:value.kind, mime:typeof value.mime==='string'?value.mime.slice(0,100):'application/octet-stream', size:value.size, url:'/api/attachment?id='+value.id };
}
function projectAttachmentText(text) {
  const attachments=[];
  text=text.replace(/(?:^|\n)<codex-mobile-attachments version="1">\n([^\r\n]*)\n<\/codex-mobile-attachments>(?=\n|$)/g,(_,json)=>{
    try { const manifest=JSON.parse(json); if(Array.isArray(manifest.attachments)&&manifest.attachments.length<=6){const items=manifest.attachments.map(attachmentMetadata);if(items.every(Boolean))attachments.push(...items);} } catch {}
    return '';
  });
  return {text,attachments};
}
export function cleanUserText(text = '') {
  text=projectAttachmentText(text).text;
  if (text.includes('## Referenced chats with Codex:') && text.includes('## My request:')) text = text.slice(text.lastIndexOf('## My request:') + 14);
  text = text.replace(/# AGENTS\.md instructions\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, '');
  for (const tag of ['environment_context','external_codex_apps_open_page','in-app-browser-context']) text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  text = text.replace(/<send_user_message_question_reply>([\s\S]*?)<\/send_user_message_question_reply>/g, (_, json) => {
    try { return JSON.parse(json).map(q => q.answer).filter(Boolean).join('\n'); } catch { return ''; }
  });
  text = text.replace(/^\s*## My request:\s*/i, '');
  text = text.replace(/<codex_mobile_plan>[\s\S]*?<\/codex_mobile_plan>\s*/g, '');
  return text.trim();
}
export function displayItem(item, context = {}) {
  const { id, type } = item;
  if (type === 'userMessage') {
    const native=new Map(projectHistoryMedia({ ...item,content:(item.content||[]).map(c=>c?.type==='local_image'?{...c,type:'localImage'}:c) },mediaContext(context)).map(media=>[media.reference.index,media]));
    const content = (item.content || []).flatMap((c,index) => {
      if (!c || typeof c!=='object') return [];
      if (c.type === 'text') { const projected=projectAttachmentText(c.text||''); return [{ type:'text', text:cleanUserText(projected.text) },...projected.attachments]; }
      if (c.type === 'attachment') return attachmentMetadata(c) || [];
      if (c.type === 'localImage' || c.type === 'local_image') { const uploadId = /\/uploads\/([a-f0-9]{48})\.(png|jpg|gif|webp)$/.exec(c.path || '')?.[1]; return uploadId?{type:'image',url:'/api/attachment?id='+uploadId}:native.has(index)?publicMedia(native.get(index),context,id):{type:'image'}; }
      if (c.type === 'image') { if (/^\/api\/attachment\?id=[a-f0-9]{48}$/.test(c.url || '')) return {type:'image',url:c.url}; if (c.reference) return publicMedia(c,context,id); return native.has(index)?publicMedia(native.get(index),context,id):{type:'image'}; }
      if (c.type === 'mention') return { type:'mention', name:c.name };
      return { type:c.type };
    }).filter(c => c.type !== 'text' || c.text);
    return content.length ? { id, type, content, ...(typeof item.clientUserMessageId==='string'&&item.clientUserMessageId?{clientUserMessageId:item.clientUserMessageId}:{}) } : null;
  }
  if (type === 'imageGeneration') {
    const projected=item.media&&typeof item.media==='object'?publicMedia(item.media,context,id):projectHistoryMedia(item,mediaContext(context))[0];
    const status=['completed','failed','inProgress','in_progress','generating'].includes(item.status)?item.status:'unknown';
    return {id,type,status,media:publicMedia(projected,context,id)};
  }
  if (type === 'agentMessage' || type === 'plan') {
    const images=assistantImageReferences(item),refs=projectHistoryMedia(item,mediaContext(context));
    const media=Array.isArray(item.inlineImages)?item.inlineImages.map(value=>({...publicMedia(value,context,id),start:value.start,end:value.end,alt:value.alt})):refs.map((value,index)=>({...publicMedia(value,context,id),start:images[index].start,end:images[index].end,alt:images[index].alt}));
    return { id, type, text: item.text, phase: item.phase,...(media.length?{inlineImages:media}:{}) };
  }
  if (type === 'commandExecution') return { id, type, command: (item.command || "").slice(0,1200), cwd: item.cwd, durationMs: item.durationMs, status: item.status, exitCode: item.exitCode, aggregatedOutput: (item.aggregatedOutput || '').slice(-2000) };
  if (type === 'fileChange') return { id, type, status: item.status, changes: (item.changes || []).map(c => ({ path: c.path, kind: c.kind, diff: (c.diff || '').slice(0,30000) })) };
  if (type === 'mcpToolCall') return { id, type, server: item.server, tool: item.tool, status: item.status };
  if (type === 'webSearch') return { id, type, query: item.query, status: item.status };
  if (type === 'dynamicToolCall') return { id, type, namespace: item.namespace, tool: item.tool, status: item.status, success: item.success, durationMs: item.durationMs };
  if (type === 'reasoning') return item.summary?.length ? { id, type, summary: item.summary.slice(0,10).map(s => String(s).slice(0,4000)) } : null;
  if (type === 'collabAgentToolCall') return { id, type, tool: item.tool, status: item.status, agentsStates: Object.fromEntries(Object.entries(item.agentsStates || {}).map(([id, state]) => [id, { status: state.status }])) };
  if (type === 'contextCompaction') return { id, type, completed: item.completed, source: item.source, status: item.status || (item.completed === true ? 'completed' : item.completed === false ? 'inProgress' : undefined) };
  return null;
}
export function displayTurn(turn, context = {}) { const input=mediaContext(context),ctx=input.turnId!=null&&input.turnId!==turn.id?{invalid:true}:{...input,turnId:turn.id}; return { id: turn.id, status: turn.status, error: turn.error, startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs, items: (turn.items || []).map(item=>displayItem(item,ctx)).filter(Boolean) }; }

export function desktopItemEvents(threadId, previous, history) {
  const events = [], oldTurns = new Map((previous?.turns || []).map(turn => [turn.id, turn]));
  for (const turn of history.turns || []) {
    const context={threadId,turnId:turn.id};
    const oldItems = new Map((oldTurns.get(turn.id)?.items || []).map(item => [item.id, displayItem(item,context)]));
    for (const raw of turn.items || []) {
      const item = displayItem(raw,context); if (!item) continue;
      const old = oldItems.get(item.id); if (JSON.stringify(old) === JSON.stringify(item)) continue;
      if (old?.type === 'agentMessage' && item.type === 'agentMessage' && item.text?.startsWith(old.text || '')) events.push({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: item.id, delta: item.text.slice((old.text || '').length) } });
      else events.push({ method: old ? 'item/completed' : 'item/started', params: { threadId, turnId: turn.id, item } });
    }
  }
  return events;
}

export function mergeDesktopTurns(turns, nativeTurns = []) {
  if (!nativeTurns.length) return turns;
  const native = new Map(nativeTurns.map(turn => [turn.id, turn]));
  const result = turns.map(turn => native.get(turn.id) || turn);
  const last = nativeTurns.findIndex(turn => turn.id === turns.at(-1)?.id);
  if (last >= 0) result.push(...nativeTurns.slice(last + 1));
  else if (!turns.length) result.push(...nativeTurns.slice(-4));
  return result;
}

export function desktopConnectionState(history, connected) {
  return { desktopConnected: !!history && connected, activeTurn: history && connected ? history.activeTurn : null, notice: history && !connected ? '与电脑端此会话的连接已断开，任务状态待确认。这里显示断开前的消息，请等待重新连接后操作。' : null };
}
