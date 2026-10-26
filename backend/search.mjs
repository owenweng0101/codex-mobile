import { createHash } from 'node:crypto';
import { displayItem, displayTurn, cleanUserText } from './view.mjs';

const fail = message => Object.assign(new Error(message), { statusCode:400 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function query(value) { if (typeof value !== 'string' || !value.trim() || value.length > 200) throw fail('请输入 1 至 200 字的搜索内容'); return value.trim(); }
function limit(value, fallback, maximum = 50) { if (value == null || value === '') return fallback; const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > maximum) throw fail(`每页数量应为 1 至 ${maximum}`); return n; }
function id(value) { if (typeof value !== 'string' || !value || value.length > 160) throw fail('请选择明确的会话或消息位置'); return value; }
function encode(kind, binding, state) { return Buffer.from(JSON.stringify({ kind, binding:hash(binding), ...state })).toString('base64url'); }
function decode(cursor, kind, binding) {
  if (typeof cursor !== 'string' || cursor.length > 16000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw fail('搜索分页位置无效，请重新搜索');
  try { const state = JSON.parse(Buffer.from(cursor,'base64url').toString()); if (state.kind !== kind || state.binding !== hash(binding) || typeof state.native !== 'string') throw Error(); return state; }
  catch { throw fail('搜索内容或范围已变化，请重新搜索'); }
}
function matches(text, term, maximum = 5000) { const found=[]; for (const match of text.matchAll(new RegExp(escape(term),'giu'))) { found.push({start:match.index,end:match.index+match[0].length}); if(found.length>=maximum)break; } return found; }
function visibleText(item) { return item?.type === 'userMessage' ? item.content.filter(c => c.type === 'text').map(c => c.text).join('\n') : item?.type === 'agentMessage' ? item.text || '' : ''; }
function safeThread(thread) { return { id:thread.id, name:cleanUserText(thread.name || '') || null, preview:cleanUserText(thread.preview || '').slice(0,200), cwd:thread.cwd, updatedAt:thread.updatedAt, model:thread.model, status:thread.status?.type ? { type:thread.status.type } : thread.status }; }
async function mapLimit(values, operation, concurrency = 3) { let index = 0; const out = Array(values.length); await Promise.all(Array.from({ length:Math.min(concurrency,values.length) }, async () => { while (index < values.length) { const current = index++; out[current] = await operation(values[current]); } })); return out; }

export function visibleOccurrence(raw, turn, term, threadId) {
  const item = displayItem((turn.items || []).find(item => item.id === raw.itemId) || { type:'hidden' },{threadId,turnId:turn.id});
  const text = visibleText(item), hits = matches(text,term); if (!hits.length || turn.id !== raw.turnId) return null;
  const snippet = raw.snippet || '', range = raw.snippetMatchRange || {};
  let left = snippet.startsWith('...') ? 3 : snippet.startsWith('…') ? 1 : 0, right = snippet.endsWith('...') ? snippet.length - 3 : snippet.endsWith('…') ? snippet.length - 1 : snippet.length;
  while (left < right && /\s/.test(snippet[left])) left++; while (right > left && /\s/.test(snippet[right-1])) right--;
  const body = snippet.slice(left,right), location = body ? text.indexOf(body) : -1;
  const direct = { start:location + range.start - left, end:location + range.end - left };
  let hit = location >= 0 && direct.start>=0 && direct.end<=text.length && new RegExp('^(?:'+escape(term)+')$','iu').test(text.slice(direct.start,direct.end)) ? direct : null;
  if (!hit) {
    const before = snippet.slice(left,range.start).trimStart(), after = snippet.slice(range.end,right).trimEnd(); let best = -1;
    for (const candidate of hits) { let score = 0; for (let n=1;n<=Math.min(40,before.length,candidate.start);n++) { if (before.at(-n) !== text[candidate.start-n]) break; score++; } for (let n=0;n<Math.min(60,after.length,text.length-candidate.end);n++) { if (after[n] !== text[candidate.end+n]) break; score++; } if (score > best) { best=score; hit=candidate; } }
  }
  let start = Math.max(0,hit.start-60), end = Math.min(text.length,Math.max(hit.end+90,start+180));
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start--;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end++;
  const prefix = start ? '…' : '', rendered = prefix + text.slice(start,end) + (end < text.length ? '…' : '');
  return { key:hash([threadId,turn.id,item.id,hit.start,hit.end]), threadId, turnId:turn.id, itemId:item.id, turnCursor:raw.turnCursor, snippet:rendered, snippetMatchRange:{ start:prefix.length+hit.start-start, end:prefix.length+hit.end-start }, ranges:matches(text.slice(start,end),term).map(h=>({start:prefix.length+h.start,end:prefix.length+h.end})) };
}

export class ThreadSearch {
  constructor({ core, catalog, now = Date.now }) { this.core=core; this.catalog=catalog; this.now=now; this.turnCache=new Map(); this.turnRequests=new Map(); }
  invalidate(threadId) { for (const key of this.turnCache.keys()) if (key.startsWith(threadId+'|')) this.turnCache.delete(key); }
  async targetTurn(threadId, occurrence) {
    const key = threadId+'|'+occurrence.turnCursor, cached = this.turnCache.get(key);
    if (cached && this.now()-cached.time < 3000 && cached.turn.id===occurrence.turnId) return cached.turn;
    if (!this.turnRequests.has(key)) {
      const pending = this.core.call('thread/turns/list',{ threadId,cursor:occurrence.turnCursor,limit:1,sortDirection:'asc',itemsView:'full' }).then(page=>{
        const raw=page.data.find(turn=>turn.id===occurrence.turnId); if (!raw) return null;
        const turn=displayTurn(raw,{threadId}); this.turnCache.delete(key); this.turnCache.set(key,{ time:this.now(),turn }); if (this.turnCache.size>24) this.turnCache.delete(this.turnCache.keys().next().value); return turn;
      }).finally(()=>this.turnRequests.delete(key)); this.turnRequests.set(key,pending);
    }
    return this.turnRequests.get(key);
  }
  async verified(threadId, raw, term) { if (!raw?.turnId || !raw.itemId || typeof raw.turnCursor!=='string') return null; const turn=await this.targetTurn(threadId,raw); return turn ? visibleOccurrence(raw,turn,term,threadId) : null; }
  scope(thread, projectId, catalog) {
    if (!projectId) return true;
    const known=catalog.threads.find(row=>row.id===thread.id); if (known) return projectId==='_other' ? !known.mobileProjectId : known.mobileProjectId===projectId;
    const fallback=catalog.projects.flatMap(p=>p.roots.filter(root=>thread.cwd===root||thread.cwd?.startsWith(root+'/')).map(root=>({ id:p.id,length:root.length }))).sort((a,b)=>b.length-a.length)[0];
    const resolved=thread.projectId||fallback?.id||null; return projectId==='_other' ? !resolved : resolved===projectId;
  }
  async firstVisible(threadId, term) {
    let cursor; for (let page=0;page<2;page++) { const response=await this.core.call('thread/searchOccurrences',{ threadId,searchTerm:term,limit:5,...(cursor?{cursor}:{}) }); for (const raw of response.data) { const verified=await this.verified(threadId,raw,term); if (verified) return {match:verified,limited:false}; } cursor=response.nextCursor; if (!cursor) break; } return {match:null,limited:!!cursor};
  }
  async search(params) {
    const term=query(params.get('q')), projectId=params.get('projectId')||null, archived=params.get('archived')==='true', count=limit(params.get('limit'),20), binding={ term,projectId,archived };
    const catalog=await this.catalog(); if (projectId&&projectId!=='_other'&&!catalog.projects.some(p=>p.id===projectId)) throw fail('项目不存在或已移除');
    let cursor=params.get('cursor') ? decode(params.get('cursor'),'search',binding).native : null, data=[], pages=0,verificationLimited=false;
    do {
      const response=await this.core.call('thread/search',{ searchTerm:term,archived,limit:Math.min(10,count-data.length),sortKey:'updated_at',sortDirection:'desc',...(cursor?{cursor}:{}) });
      const candidates=response.data.filter(row=>row.thread?.id&&this.scope(row.thread,projectId,catalog));
      const rows=await mapLimit(candidates,async row=>{ const check=await this.firstVisible(row.thread.id,term); verificationLimited ||= check.limited; const occurrence=check.match; if (!occurrence) return null; return { thread:safeThread(row.thread),threadId:row.thread.id,threadName:cleanUserText(row.thread.name||'')||null,...occurrence,anchor:{turnId:occurrence.turnId,itemId:occurrence.itemId,turnCursor:occurrence.turnCursor} }; });
      data.push(...rows.filter(Boolean)); cursor=response.nextCursor; pages++;
    } while (cursor&&data.length<count&&pages<8);
    return { data,nextCursor:cursor?encode('search',binding,{native:cursor}):null,partial:verificationLimited||!!cursor&&data.length<count,verificationLimited,query:term };
  }
  async occurrences(params) {
    const threadId=id(params.get('threadId')),term=query(params.get('q')),count=limit(params.get('limit'),30),binding={threadId,term};
    let cursor=params.get('cursor')?decode(params.get('cursor'),'occurrences',binding).native:null,data=[],pages=0; const keys=new Set();
    do {
      const page=await this.core.call('thread/searchOccurrences',{threadId,searchTerm:term,limit:count-data.length,...(cursor?{cursor}:{})});
      const verified=await mapLimit(page.data,raw=>this.verified(threadId,raw,term));
      for(const row of verified)if(row&&!keys.has(row.key)){keys.add(row.key);data.push(row);}
      cursor=page.nextCursor;pages++;
    } while(cursor&&data.length<count&&pages<8);
    return { data,nextCursor:cursor?encode('occurrences',binding,{native:cursor}):null,partial:!!cursor&&data.length<count,query:term,threadId };
  }
  async around(params) {
    const threadId=id(params.get('threadId')),binding={threadId},continuation=params.get('cursor'),count=limit(params.get('limit'),continuation?6:3,10);
    const thread=safeThread((await this.core.call('thread/read',{threadId,includeTurns:false})).thread);
    if (continuation) {
      const direction=params.get('direction'); if(!['older','newer'].includes(direction))throw fail('请选择继续加载更早或更新的历史');
      const cursor=decode(continuation,'around',binding);if(cursor.direction!==direction)throw fail('历史分页方向已变化，请重新定位');
      const page=await this.core.call('thread/turns/list',{threadId,cursor:cursor.native,limit:count,sortDirection:direction==='older'?'desc':'asc',itemsView:'full'});
      const turns=(direction==='older'?page.data.slice().reverse():page.data).map(turn=>displayTurn(turn,{threadId})),next=page.nextCursor?encode('around',binding,{native:page.nextCursor,direction,anchor:cursor.anchor}):null;
      return {thread,turns,anchor:cursor.anchor,anchored:true,...(direction==='older'?{olderCursor:next,hasOlder:!!next}:{newerCursor:next,hasNewer:!!next})};
    }
    const turnCursor=params.get('turnCursor'); if (typeof turnCursor!=='string'||!turnCursor||turnCursor.length>8192)throw fail('匹配位置无效，请重新搜索');
    const turnId=id(params.get('turnId')),itemId=params.get('itemId')||null,anchor={turnId,itemId,turnCursor};
    const [older,newer]=await Promise.all(['desc','asc'].map(sortDirection=>this.core.call('thread/turns/list',{threadId,cursor:turnCursor,limit:count,sortDirection,itemsView:'full'})));
    const merged=new Map();for(const turn of [...older.data.slice().reverse(),...newer.data])if(!merged.has(turn.id))merged.set(turn.id,displayTurn(turn,{threadId}));
    const turns=[...merged.values()],target=turns.find(turn=>turn.id===turnId);if(!target||itemId&&!target.items.some(item=>item.id===itemId&&['userMessage','agentMessage'].includes(item.type)))throw fail('匹配位置已变化或不属于可见正文，请重新搜索');
    const olderCursor=older.nextCursor?encode('around',binding,{native:older.nextCursor,direction:'older',anchor}):null,newerCursor=newer.nextCursor?encode('around',binding,{native:newer.nextCursor,direction:'newer',anchor}):null;
    return {thread,turns,anchor,olderCursor,newerCursor,hasOlder:!!olderCursor,hasNewer:!!newerCursor,anchored:true};
  }
}
