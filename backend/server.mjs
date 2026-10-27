import {RolloutConversationIndex} from './conversation-index.mjs';
import {skillInputs} from './skill-input.mjs';
import {autoTitleCandidate,isDefaultThreadTitle} from './auto-title.mjs';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { displayItem, displayTurn, cleanUserText, desktopItemEvents, mergeDesktopTurns, desktopConnectionState } from './view.mjs';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { CodexCore, listWorkspaceFiles, readWorkspaceFile, workspaceGit, workspacePath, readRolloutPage, collaborationModeFor } from './core.mjs';
import { ManagedTunnel } from './tunnel.mjs';
import { sendWorkspaceContent } from './file-content.mjs';
import { TerminalManager } from './terminal.mjs';
import { MessageQueue } from './queue.mjs';
import { CapabilityCatalog } from './capabilities.mjs';
import { DesktopBridge, trimIdleDesktopSubscriptions, desktopHistory as desktopSnapshotHistory } from './desktop-bridge.mjs';
import { MobileOrganization } from './organization.mjs';
import { NativeOrganization } from './native-pins.mjs';
import { CatalogCache, includePersistedCreations } from './catalog.mjs';
import { DesktopIntent, ensureDesktopOwner } from './desktop-intent.mjs';
import { AutomationCatalog } from './automations.mjs';
import { searchWorkspaceFiles } from './file-search.mjs';
import { ProjectManager } from './projects.mjs';
import { CreationLedger } from './creation-ledger.mjs';
import { NativeArchive } from './native-archive.mjs';
import { ThreadSearch } from './search.mjs';
import { WorkspaceAccess } from './workspace-access.mjs';
import { ArchivedThreads, ensureThreadUnarchived } from './archived.mjs';
import { GoalReader } from './goals.mjs';
import { AttachmentStore, serveAttachment } from './attachments.mjs';
import { HistoryMedia } from './history-media.mjs';
import { nativeImageRoots, serveNativeMedia } from './native-media.mjs';
import { deliverMessage, messageBusy, hasPendingDelivery } from './message-delivery.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.CODEX_MOBILE_STATE_DIR || resolve(homedir(), 'Library/Application Support/CodexMobile');
const port = Number(process.env.PORT || 8787);
const cwd = process.env.CODEX_MOBILE_CWD || resolve(root, '../..');
await mkdir(stateDir, { recursive: true, mode: 0o700 });
let accessToken;
try { accessToken = (await readFile(resolve(stateDir, 'access-token'), 'utf8')).trim(); } catch {}
if (!/^[A-Za-z0-9_-]{43}$/.test(accessToken || '')) { accessToken = randomBytes(32).toString('base64url'); await writeFile(resolve(stateDir, 'access-token'), accessToken, { mode: 0o600 }); }
let gateway;
try { gateway = JSON.parse(await readFile(resolve(stateDir, 'gateway.json'), 'utf8')); } catch {}
const instance = randomBytes(12).toString('hex');
let publicUrl = null, tunnelError = null, tunnel, sequence = 0, closing = false;
const eventWaiters = new Set(), fullHistoryCache = new Map(), historyRequests = new Map();
let paginationSupported = true;
const events = [], turnsStarting = new Set(), owned = new Set(), draftThreads = new Map(), projectAssignments = new Map();
let threadSettings = {};
try { threadSettings = JSON.parse(await readFile(resolve(stateDir, 'thread-settings.json'), 'utf8')); } catch {}
const saveSettings = () => writeFile(resolve(stateDir, 'thread-settings.json'), JSON.stringify(threadSettings), { mode: 0o600 });
const core = await new CodexCore({ cwd }).start();
const terminals = new TerminalManager();
const capabilities = new CapabilityCatalog(core);
const projectManager = new ProjectManager(core);
const organization = new NativeOrganization({core,local:await new MobileOrganization(stateDir).init(),onChanged:()=>publish({method:'bridge/catalogUpdated',params:{}})});
const desktop = new DesktopBridge();
const nativeIntent = new DesktopIntent({ desktop });
const nativeArchive = new NativeArchive({ desktop, readThread: threadRead, stateDir });
let archiveUnavailable;
try { await nativeArchive.ready(); } catch (error) { archiveUnavailable = error; }
const creations = new CreationLedger(stateDir);
const automationCatalog = new AutomationCatalog({ defaultCwd: cwd });
const workspaceAccess = new WorkspaceAccess();
const historyMedia = new HistoryMedia({ core, ensureAccess:path=>workspaceAccess.ensure(path), resolveRoots:async(reference,source)=>{
  if(source.item.type!=='agentMessage')return nativeImageRoots(reference,source);
  const {thread}=await core.call('thread/read',{threadId:reference.threadId,includeTurns:false});
  return typeof thread?.cwd==='string'?[thread.cwd]:[];
}, maxBytes:20*1024*1024 });
const archivedThreads = new ArchivedThreads(core);
const goals = new GoalReader({ core });
const desktopHistories = new Map(), desktopActive = new Map(), desktopApprovals = new Map(), desktopAccess = new Map(), desktopStale = new Set(), pendingHistoryResets = new Set();
const messageQueue = await new MessageQueue({ stateDir, send: dispatchMessage, isActive: id => turnsStarting.has(id) || core.activeTurns.has(id) || desktopActive.has(id) || nativeArchive.isPending(id) }).init();
function publish(event) { events.push({ id: ++sequence, ...event }); if (events.length > 4000) events.splice(0, events.length - 4000); for (const wake of eventWaiters) wake(); }
// Poll native pins only while a phone is waiting for change notifications.
const organizationTimer=setInterval(()=>{if(eventWaiters.size)organization.get().catch(()=>{});},1500);organizationTimer.unref();
messageQueue.on('change', params => { publish({ method: 'bridge/queueUpdated', params }); pruneDesktopIdle(); });
function touchDesktop(id) { desktopAccess.delete(id); desktopAccess.set(id, Date.now()); }
function releaseDesktop(id) {
  desktop.unfollow(id); desktopHistories.delete(id); desktopActive.delete(id); desktopStale.delete(id); pendingHistoryResets.delete(id);
  for (const [requestId, approval] of desktopApprovals) if (approval.threadId === id) desktopApprovals.delete(requestId);
}
function pruneDesktopIdle() { trimIdleDesktopSubscriptions(desktopAccess, id => desktopActive.has(id) || turnsStarting.has(id) || messageQueue.get(id).items.length > 0 || nativeArchive.isPending(id), releaseDesktop); }
const forwardedEvents = new Set(['turn/started','turn/completed','turn/plan/updated','turn/diff/updated','thread/tokenUsage/updated','thread/name/updated','item/started','item/completed','item/agentMessage/delta','item/plan/delta','item/commandExecution/outputDelta','error','bridge/approval','bridge/offline','bridge/approvalResolved']);
function engineEvent(event) {
  if (!forwardedEvents.has(event.method)) return;
  if (event.params?.threadId) fullHistoryCache.delete(event.params.threadId);
  if (event.params?.item) event = { ...event, params: { ...event.params, item: displayItem(event.params.item,{threadId:event.params.threadId,turnId:event.params.turnId}) } };
  if (event.params?.turn) event = { ...event, params: { ...event.params, turn: displayTurn(event.params.turn,{threadId:event.params.threadId}) } };
  publish(event);
  if (event.method === 'turn/completed') { catalogCache?.invalidate({ patch: { id: event.params.threadId, status: { type: 'idle' }, updatedAt: Math.floor(Date.now()/1000) } }); if (event.params?.turn?.status === 'completed') setTimeout(() => messageQueue.kick(event.params.threadId), 0); else messageQueue.handle(event.params.threadId, { action: 'pause' }).catch(() => {}); }
}
core.on('event', event => { if (event.method === 'bridge/offline' && !closing) { console.error('Codex 引擎已停止，后台服务将自动重启。'); setTimeout(() => stop(1), 30); } engineEvent(event); });
function acceptDesktopHistory(threadId, history) {
  if (!history) return null;
  const wasStale = desktopStale.delete(threadId);
  history = { ...history, turns: (history.turns || []).map(turn=>displayTurn(turn,{threadId})), approvals: structuredClone(history.approvals || []) };
  const previous = desktopHistories.get(threadId), previousActive = desktopActive.get(threadId); desktopHistories.set(threadId, history);
  if (history.activeTurn) desktopActive.set(threadId, history.activeTurn); else desktopActive.delete(threadId);
  if (previousActive && previousActive !== history.activeTurn) { const completed = history.turns.find(turn => turn.id === previousActive); if (completed && completed.status !== 'inProgress') engineEvent({ method: 'turn/completed', params: { threadId, turn: completed } }); }
  if (previous) for (const event of desktopItemEvents(threadId, previous, history)) engineEvent(event);
  const approvals = new Map((history.approvals || []).map(approval => [String(approval.id), { ...approval, threadId }]));
  for (const [id, approval] of desktopApprovals) if (approval.threadId === threadId && !approvals.has(id)) { desktopApprovals.delete(id); engineEvent({ method: 'bridge/approvalResolved', params: { id, threadId } }); }
  for (const [id, approval] of approvals) { if (!desktopApprovals.has(id)) engineEvent({ method: 'bridge/approval', params: approval }); desktopApprovals.set(id, approval); }
  if (history.tokenUsage && JSON.stringify(previous?.tokenUsage) !== JSON.stringify(history.tokenUsage)) engineEvent({ method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: history.tokenUsage } });
  if (history.plan && JSON.stringify(previous?.plan) !== JSON.stringify(history.plan)) engineEvent({ method: 'turn/plan/updated', params: { threadId, ...(Array.isArray(history.plan) ? { plan: history.plan } : history.plan) } });
  if (history.turnDiff && (history.turnDiff.turnId !== previous?.turnDiff?.turnId || history.turnDiff.diff !== previous?.turnDiff?.diff)) engineEvent({ method: 'turn/diff/updated', params: { threadId, ...history.turnDiff } });
  pruneDesktopIdle(); if (wasStale) publish({ method: 'bridge/desktopOnline', params: { threadId } }); return history;
}
desktop.on('event', event => {
  if (event.method === 'bridge/desktopSnapshot') { acceptDesktopHistory(event.params.threadId, event.params.history); if (pendingHistoryResets.delete(event.params.threadId)) publish({ method: 'bridge/historyReset', params: { threadId: event.params.threadId } }); return; }
  if (event.method === 'turn/started') desktopActive.set(event.params.threadId, event.params.turn.id);
  if (event.method === 'turn/completed') desktopActive.delete(event.params.threadId);
  if (event.method === 'bridge/desktopOffline') { for (const id of event.params?.threadId ? [event.params.threadId] : desktopHistories.keys()) { desktopStale.add(id); if (messageQueue.get(id).items.length) messageQueue.handle(id, { action: 'pause' }).catch(() => {}); } publish(event); return; }
  if (event.method === 'bridge/desktopOnline') { publish(event); return; }
  engineEvent(event);
});
desktop.start().catch(() => {});
async function desktopHistoryFor(id) {
  if (owned.has(id)) return null; touchDesktop(id);
  try { const history = await desktop.history(id, { timeout: 1200 }); if (history) return acceptDesktopHistory(id, history); }
  catch {}
  const cached = desktopHistories.get(id); if (cached) desktopStale.add(id); pruneDesktopIdle(); return cached || null;
}
async function desktopOwnerFor(id) { if (owned.has(id)) return null; try { const owner = await desktop.owner(id, { timeout: 1500 }); if (!owner && desktopHistories.has(id)) throw new Error('与电脑端此会话的连接已断开，请重新连接后操作'); return owner; } catch (error) { if (desktop.owners.has(id) || desktopHistories.has(id)) throw error; return null; } }
async function nativeForOperation(id) {
  if(threadSettings[id]?.needsDesktopRefresh){try{await archivedThreads.refreshDesktop(id,desktop);}catch(error){if(error.code==='THREAD_ARCHIVED')throw error;}}
  await ensureDesktopOwner(id,{isOwned:()=>owned.has(id),isStale:()=>desktopStale.has(id),owner:()=>desktopOwnerFor(id),attach:()=>nativeIntent.attach(id)});
  let state;for(let attempt=0;attempt<2&&!state;attempt++){try{state=await desktop.snapshot(id,{fresh:true,timeout:2500});}catch{}}
  const native=state?acceptDesktopHistory(id,desktopSnapshotHistory(state)):null;
  if(!native)throw Object.assign(new Error('电脑端会话状态尚未同步，请重新连接并核对后再操作'),{statusCode:503});
  if(threadSettings[id]?.needsDesktopRefresh){threadSettings[id].needsDesktopRefresh=false;await saveSettings();}
  return native;
}
const equal = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const authorized = req => equal((req.headers.authorization || '').replace(/^Bearer /, ''), accessToken);
const local = req => /^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '') && !req.headers['cf-ray'] && !req.headers['x-forwarded-for'];
const send = (res, status, body) => { const json = JSON.stringify(body); const zipped = Buffer.byteLength(json) > 2048; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(zipped ? { 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' } : {}) }); res.end(zipped ? gzipSync(json) : json); };
const fail = (res, status, error) => send(res, status, { error });
async function body(req, maximum = 12 * 1024 * 1024) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > maximum) throw new Error('上传内容过大，请压缩文件后重试'); chunks.push(chunk); }
  return length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
let modelsCache;
async function models() {
  if (!modelsCache || Date.now() - modelsCache.time > 60000) {
    const data = []; let cursor;
    do { const page = await core.call('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }); data.push(...page.data); cursor = page.nextCursor; } while (cursor && data.length < 500);
    modelsCache = { time: Date.now(), data };
  }
  return modelsCache.data;
}
async function requestedSettings(data, previous = {}) {
  const result = { ...previous };
  if (data.mode != null) { if (!['default', 'plan'].includes(data.mode)) throw new Error('不支持的任务模式'); result.mode = data.mode; }
  if (data.model != null || data.effort != null) {
    const available = await models();
    const model = available.find(m => m.model === (data.model || previous.model) || m.id === (data.model || previous.model)) || (!data.model && !previous.model ? available.find(m => m.isDefault) : null);
    if (!model) throw new Error('模型不可用，请重新选择');
    result.model = model.model;
    if (data.effort != null) { if (!model.supportedReasoningEfforts.some(e => e.reasoningEffort === data.effort)) throw new Error('该模型不支持所选思考强度'); result.effort = data.effort; }
    else if (data.model && previous.model !== model.model) result.effort = model.defaultReasoningEffort;
  }
  if (data.approvalPolicy != null) { if (!['untrusted', 'on-request', 'never'].includes(data.approvalPolicy)) throw new Error('不支持的授权方式'); result.approvalPolicy = data.approvalPolicy; }
  if (data.sandbox != null) { if (!['read-only', 'workspace-write', 'danger-full-access'].includes(data.sandbox)) throw new Error('不支持的文件权限'); result.sandbox = data.sandbox; }
  return result;
}
async function workspace(query) {
  let directory;
  if (query.get('threadId')) directory=(draftThreads.get(query.get('threadId')) || await threadRead(query.get('threadId'))).cwd;
  else {
    const c = await catalog(), project = c.projects.find(p => p.id === query.get('projectId'));
    if (project?.roots.length) { const selected=query.get('root'); directory=selected && project.roots.includes(selected) ? selected : project.roots[0]; }
    else if (query.get('cwd') && [cwd,...c.threads.map(t=>t.cwd)].includes(query.get('cwd'))) directory=query.get('cwd');
  }
  if (!directory) throw new Error('请先选择项目或会话');
  await workspaceAccess.ensure(directory); return directory;
}
const uploadDir = resolve(stateDir, 'uploads');
const attachmentStore = new AttachmentStore({ directory:uploadDir });
let catalogCache = await new CatalogCache({ stateDir, load: loadCatalog }).init();
const threadSearch = new ThreadSearch({ core, catalog });
catalogCache.on('change', params => publish({ method: 'bridge/catalogUpdated', params }));
async function catalog(force = false) { return catalogCache.get(force); }
function catalogMeta(value) { return { version: value.version, stale: value.stale, refreshing: value.refreshing, updatedAt: value.updatedAt }; }
function updateCatalogThread(thread) {
  const assignment = projectAssignments.get(thread.id) || thread.projectId || catalogCache.value?.threads.find(t => t.id === thread.id)?.mobileProjectId || null;
  catalogCache.invalidate({ upsert: { ...thread, name: threadSettings[thread.id]?.name || thread.name, preview: cleanUserText(thread.preview || '').slice(0,200), mobileProjectId: assignment } });
}
const verifiedArchives = new Set();
function archiveResponse(result) {
  if (result.archived && !verifiedArchives.has(result.requestId)) {
    verifiedArchives.add(result.requestId); draftThreads.delete(result.threadId); owned.delete(result.threadId); fullHistoryCache.delete(result.threadId);
    desktopAccess.delete(result.threadId); releaseDesktop(result.threadId); catalogCache.invalidate({ remove: result.threadId });
    publish({ method: 'bridge/archiveUpdated', params: { ...result, verified:true } });
  }
  return { ...result, verified:result.archived === true, ...(result.archived ? { ok:true } : {}), ...(result.status === 'blocked' ? { error:result.message, blocked:true, sent:false } : {}) };
}
async function loadCatalog() {
  const [projectPage, sourceThreads, state] = await Promise.all([
    core.call('project/list', { limit: 100 }),
    (async () => { const result = []; let cursor = null; do { const page = await core.call('thread/list', { limit: 100, modelProviders: [], ...(cursor ? { cursor } : {}) }); result.push(...page.data); cursor = page.nextCursor; } while (cursor && result.length < 10000); return { data: result, truncated: !!cursor }; })(),
    readFile(resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), '.codex-global-state.json'), 'utf8').then(JSON.parse).catch(() => ({})),
  ]);
  const projects = projectPage.data.map(p => ({ id: p.id, name: p.name, roots: p.roots.map(r => r.path) }));
  const assignments = state['thread-project-assignments'] || {}, maps = {};
  for (const map of Object.values(state['app-server-project-id-by-legacy-project-id-by-host'] || {})) Object.assign(maps, map);
  const combined = new Map((await includePersistedCreations(sourceThreads.data,await creations.persistedThreadIds(),threadRead)).map(t => [t.id, t]));
  for (const [id, thread] of draftThreads) if (!combined.has(id)) combined.set(id, thread);
  const threads = [...combined.values()];
  for (const t of threads) {
    const a = assignments[t.id];
    const assigned = projectAssignments.get(t.id) || t.projectId || (a?.projectKind === 'local' ? maps[a.projectId] || a.projectId : null);
    const fallback = projects.flatMap(p => p.roots.filter(r => t.cwd === r || t.cwd?.startsWith(r + '/')).map(r => ({ id: p.id, length: r.length }))).sort((a,b) => b.length-a.length)[0];
    t.mobileProjectId = assigned && projects.some(p => p.id === assigned) ? assigned : fallback?.id || null;
    t.preview = cleanUserText(t.preview || '').slice(0,200);
  }
  return { projects, threads, truncated: sourceThreads.truncated };
}
async function threadRead(id) { return (await core.call('thread/read', { threadId: id, includeTurns: false })).thread; }
async function unarchivedThread(id) { return ensureThreadUnarchived(draftThreads.get(id) || await threadRead(id)); }
function draftHistory(id) { return { thread: { ...draftThreads.get(id), name: threadSettings[id]?.name || draftThreads.get(id)?.name }, settings: threadSettings[id] || {}, queue: messageQueue.get(id), turns: [], nextCursor: null, approvals: [], activeTurn: core.activeTurns.get(id) || null, attached: true }; }
async function readHistory(id, cursor) {
  if (draftThreads.has(id)) return draftHistory(id);
  if (cursor && desktopHistories.has(id)) touchDesktop(id);
  const nativeRequest = cursor ? Promise.resolve(desktopHistories.get(id) || null) : desktopHistoryFor(id);
  let thread, page;
  const validCache = fullHistoryCache.get(id), cached = validCache && Date.now() - validCache.time < 5000 ? validCache : null;
  try { thread = !paginationSupported && cached ? cached.thread : await threadRead(id); }
  catch (error) {
    if (draftThreads.has(id) && /no rollout|not found/i.test(error.message)) return draftHistory(id);
    throw error;
  }
  try {
    const codexHome = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'));
    if (thread.path && (thread.path.startsWith(codexHome + '/sessions/') || thread.path.startsWith(codexHome + '/archived_sessions/')) && (!cursor || cursor.startsWith('rollout:'))) {
      try { page = await readRolloutPage(thread.path, cursor, cursor ? 8 : 4); } catch (error) { if (cursor?.startsWith('rollout:')) throw error; }
    }
    if (page) { /* Local rollout already contains complete display items. */ }
    else {
    if (!paginationSupported) throw new Error('not supported');
    page = await core.call('thread/turns/list', { threadId: id, limit: cursor ? 8 : 4, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
    page.data = page.data.slice().reverse();
    }
  } catch (error) {
    if (draftThreads.has(id) && /no rollout|not found/i.test(error.message)) return draftHistory(id);
    if (!/not supported|not implemented|method not found/i.test(error.message)) throw error;
    paginationSupported = false;
    thread = cached ? cached.thread : (await core.call('thread/read', { threadId: id, includeTurns: true })).thread;
    fullHistoryCache.delete(id); fullHistoryCache.set(id, { time: Date.now(), thread });
    if (fullHistoryCache.size > 12) fullHistoryCache.delete(fullHistoryCache.keys().next().value);
    const end = cursor?.startsWith('legacy:') ? Number(cursor.slice(7)) : thread.turns.length;
    const start = Math.max(0, end - (cursor ? 8 : 4));
    page = { data: thread.turns.slice(start, end), nextCursor: start > 0 ? 'legacy:' + start : null };
    thread = { ...thread, turns: undefined };
  }
  const native = await nativeRequest;
  return {...historyMetadata(id,thread,native,page.settings),turns:(native&&!cursor?mergeDesktopTurns(page.data,native.turns):page.data).map(turn=>displayTurn(turn,{threadId:id})),nextCursor:page.nextCursor};
}
function historyMetadata(id,thread,native,pageSettings={}) {
  const connection = desktopConnectionState(native, desktop.online && !desktopStale.has(id));
  thread = { id: thread.id, archived:!!thread.path?.includes('/archived_sessions/'), name: native?.thread?.name || threadSettings[id]?.name || thread.name, preview: cleanUserText(thread.preview || ''), cwd: thread.cwd, status: native && !connection.desktopConnected ? { type: 'unavailable' } : native?.thread?.status || thread.status, model: native?.settings?.model || thread.model, reasoningEffort: native?.settings?.effort || thread.reasoningEffort, projectId: thread.projectId, createdAt: thread.createdAt, updatedAt: thread.updatedAt };
  return { thread, desktop: !!native, ...connection, queue: messageQueue.get(id), settings: { model: thread.model, effort: thread.reasoningEffort, ...threadSettings[id], ...pageSettings, ...native?.settings }, tokenUsage: native?.tokenUsage || core.tokenUsage.get(id) || null, plan: native?.plan || core.turnPlans.get(id) || null, diff: native?.diff || core.turnDiffs.get(id)?.diff || null, approvals: [...[...core.requests.values()].filter(r => r.params?.threadId === id).map(r => ({ id: String(r.id), method: r.method, ...r.params })), ...(native?.approvals || [])], activeTurn: native ? connection.activeTurn : core.activeTurns.get(id) || null, attached: !!native || owned.has(id) };
}
const conversationIndex=new RolloutConversationIndex();
async function historyWindow(id,params){
 if(draftThreads.has(id)){const page=draftHistory(id);return{...page,rows:{window:[],totalCount:0,firstRowId:null},sourceEpoch:'draft:'+id,revision:'draft:'+id};}
 const [thread,native]=await Promise.all([threadRead(id),desktopHistoryFor(id)]);
 const codexHome=resolve(process.env.CODEX_HOME||resolve(homedir(),'.codex'));
 if(!thread.path||!['sessions','archived_sessions'].some(folder=>thread.path.startsWith(codexHome+'/'+folder+'/')))throw Object.assign(new Error('此会话暂不支持索引窗口'),{code:'HISTORY_WINDOW_UNSUPPORTED',statusCode:501});
 const context=historyMetadata(id,thread,native);
 let result;
 try{result=await conversationIndex.read(thread.path,{threadId:id,thread:context.thread,nativeTurns:native?.turns||[],activeTurn:context.activeTurn,...params});}
 catch(error){if(['ENOENT','EACCES','EPERM'].includes(error.code))throw Object.assign(new Error('此历史源暂不可建立索引窗口'),{code:'HISTORY_WINDOW_UNSUPPORTED',statusCode:501});throw error;}
 return{...historyMetadata(id,thread,native,result.settings),turns:result.lastTurn?[result.lastTurn]:[],rows:result.rows,sourceEpoch:result.sourceEpoch,revision:result.revision,hasMore:result.hasMore};
}
async function history(id, cursor) {
  const key = id + ':' + (cursor || '');
  if (!historyRequests.has(key)) historyRequests.set(key, readHistory(id, cursor).finally(() => historyRequests.delete(key)));
  return historyRequests.get(key);
}
async function dispatchMessage(data, { steer = false } = {}) {
const key = `${data.threadId}:${data.requestId}`;
if (receipts.has(key)) return await receipts.get(key);
if (!steer && (turnsStarting.has(data.threadId) || core.activeTurns.has(data.threadId) || desktopActive.has(data.threadId) || data.delivery === 'startNow' && hasPendingDelivery(data,messageQueue))) throw data.delivery === 'startNow' ? messageBusy() : new Error('该任务正在运行，请先加入发送队列');
turnsStarting.add(data.threadId);
let nativeDispatched=false;
const pending = (async () => {
  const thread = await unarchivedThread(data.threadId);
  const native = await nativeForOperation(data.threadId);
  if (!steer && data.delivery === 'startNow' && (native.activeTurn || core.activeTurns.has(data.threadId) || desktopActive.has(data.threadId) || hasPendingDelivery(data,messageQueue))) throw messageBusy();
  const settings = await requestedSettings(data, { model: thread.model, effort: thread.reasoningEffort, ...threadSettings[data.threadId], ...native?.settings });
  const collaborationMode = collaborationModeFor(settings.mode || 'default', settings.model || (await models()).find(model => model.isDefault)?.model, settings.effort);
  settings.model = collaborationMode.settings.model;
  const input = [];
  if (data.text?.trim()) input.push({ type: 'text', text: data.text.trim() });
  input.push(...await attachmentStore.inputs(data.attachments || []));
  if(data.text?.includes('[$'))input.push(...skillInputs(data.text,await capabilities.skills(thread.cwd)));
  if (data.files != null && (!Array.isArray(data.files) || data.files.length > 20)) throw new Error('每条消息最多引用 20 个文件');
  if (data.files?.length) { const directory = (draftThreads.get(data.threadId) || await threadRead(data.threadId)).cwd; for (const path of data.files) { const file = await workspacePath(directory, path); input.push({ type: 'mention', name: basename(file.path), path: file.target }); } }
  const titleCandidate = autoTitleCandidate({title:thread.name || settings.name,isFirstUserInput:settings.autoTitlePending===true,customTitle:settings.customTitle===true,text:data.text,input,attachments:data.attachments,files:data.files});
  const activeTurnId = desktopActive.get(data.threadId);
  if(!steer&&(activeTurnId || data.delivery === 'startNow' && (core.activeTurns.has(data.threadId) || hasPendingDelivery(data,messageQueue))))throw data.delivery === 'startNow' ? messageBusy() : new Error('接管后的会话正在运行，本次消息尚未发送，请加入发送队列');
  if (steer && !activeTurnId) throw Object.assign(new Error('当前任务已结束，本次尚未插入'),{code:'TURN_ENDED',sent:false});
  const sandboxPolicy = settings.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : settings.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: true } : settings.sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [thread.cwd], networkAccess: true } : null;
  nativeDispatched=true;
  const result = await desktop[steer ? 'steer' : 'send'](data.threadId, { input, requestId: data.requestId, collaborationMode, ...(data.delivery === 'startNow' ? { delivery:'startNow' } : {}), ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}), ...(settings.approvalPolicy ? { approvalPolicy: settings.approvalPolicy } : {}), ...(sandboxPolicy ? { sandboxPolicy } : {}) });
  const nativeRunning=!['completed','interrupted','failed'].includes(result.turn?.status);
  if (!steer) { if(nativeRunning)desktopActive.set(data.threadId,result.turn.id);else desktopActive.delete(data.threadId); }
  if (!steer) {
    if(titleCandidate){try{const current=await threadRead(data.threadId);if(!threadSettings[data.threadId]?.customTitle&&isDefaultThreadTitle(current.name)){await core.call('thread/name/set',{threadId:data.threadId,name:titleCandidate});settings.name=titleCandidate;fullHistoryCache.delete(data.threadId);}}catch{}}
    if(threadSettings[data.threadId]?.customTitle){settings.name=threadSettings[data.threadId].name;settings.customTitle=true;}
    settings.autoTitlePending=false;threadSettings[data.threadId] = settings; await saveSettings().catch(error=>console.error('Message accepted; settings save failed:',error.code||error.message));
  }
  const projectId = projectAssignments.get(data.threadId);
  if (projectId) { try { await core.call('thread/metadata/update', { threadId: data.threadId, projectId }); } catch {} }
  if (settings.name && draftThreads.has(data.threadId)) { try { await core.call('thread/name/set', { threadId: data.threadId, name: settings.name }); } catch {} }
  draftThreads.delete(data.threadId); updateCatalogThread({ ...thread, name: settings.name || thread.name, preview: thread.preview || data.text || '', updatedAt: Math.floor(Date.now()/1000), status: { type: nativeRunning?'active':'idle' } });
  return result;
})();
receipts.set(key, pending); if (receipts.size > 300) receipts.delete(receipts.keys().next().value);
try { return await pending; } catch (error) { if(!nativeDispatched&&!error.outcomeUnknown)error.sent=false; if (!error.outcomeUnknown) receipts.delete(key); throw error; } finally { turnsStarting.delete(data.threadId); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'");
  try {
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;
    if (pathname === '/healthz' && req.method === 'GET') return send(res, 200, { service: 'codex-mobile-local', instance });
    if (pathname.startsWith('/local/')) {
      if (!local(req)) return fail(res, 403, '只允许在本机打开');
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return fail(res, 403, '来源不匹配');
      if (pathname === '/local/info' && req.method === 'GET') {
        const url = publicUrl ? `${publicUrl}/#${accessToken}` : null;
        return send(res, 200, { url, fixedGateway: !!gateway, localUrl: `http://127.0.0.1:${port}/#${accessToken}`, qr: url ? await QRCode.toDataURL(url, { width: 320, margin: 3, errorCorrectionLevel: 'M' }) : null, tunnelError, tunnelStatus: tunnel?.state.status || 'disabled', verifiedAt: tunnel?.state.verifiedAt || null, cwd, ready: !core.closed });
      }
      if (pathname === '/local/revoke' && req.method === 'POST') { accessToken = randomBytes(32).toString('base64url'); await writeFile(resolve(stateDir, 'access-token'), accessToken, { mode: 0o600 }); await writeFile(resolve(stateDir, 'connection.json'), JSON.stringify({ port, token: accessToken }), { mode: 0o600 }); return send(res, 200, { ok: true }); }
      return fail(res, 404, '不存在');
    }
    if (pathname.startsWith('/api/')) {
      if (!authorized(req)) return fail(res, 401, '请重新扫描电脑上的二维码');
      if (req.headers.origin && req.headers.origin !== `https://${req.headers.host}` && req.headers.origin !== `http://${req.headers.host}`) return fail(res, 403, '来源不匹配');
      if (req.method === 'GET' && pathname === '/api/status') {
        return send(res, 200, { online: !core.closed, desktopOnline: desktop.online, cwd, active: Object.fromEntries([...core.activeTurns, ...[...desktopActive].filter(([id]) => !desktopStale.has(id))]), ownedActive: Object.fromEntries(core.activeTurns), terminal:terminals.summary(), uncertainDesktop: [...desktopStale].filter(id => desktopActive.has(id)), epoch: instance, sequence });
      }
      if (req.method === 'GET' && pathname === '/api/organize') return send(res, 200, await organization.get());
      if (req.method === 'GET' && pathname === '/api/goal') {
        try { return send(res, 200, await goals.read(u.searchParams.get('threadId'), { fresh:u.searchParams.has('refresh') })); }
        catch (error) { return fail(res, error.statusCode || 500, error.message); }
      }
      if (req.method === 'GET' && pathname === '/api/archived') {
        try { return send(res, 200, await archivedThreads.list(u.searchParams)); }
        catch (error) { return fail(res, error.statusCode || 500, error.message); }
      }
      if (req.method === 'GET' && ['/api/search','/api/search/occurrences','/api/history/around'].includes(pathname)) {
        try {
          if (pathname === '/api/search') return send(res, 200, await threadSearch.search(u.searchParams));
          if (pathname === '/api/search/occurrences') return send(res, 200, await threadSearch.occurrences(u.searchParams));
          const result = await threadSearch.around(u.searchParams);
          if (u.searchParams.has('cursor')) return send(res, 200, result);
          const context = await history(u.searchParams.get('threadId'));
          return send(res, 200, { ...context, ...result });
        } catch (error) { return fail(res, error.statusCode || 500, error.message); }
      }
      if (req.method === 'GET' && pathname === '/api/automations') return send(res, 200, await automationCatalog.list());
      if (req.method === 'GET' && pathname === '/api/thread/archive/status') {
        if (archiveUnavailable) throw archiveUnavailable;
        return send(res, 200, archiveResponse(await nativeArchive.status({ threadId:u.searchParams.get('threadId'), requestId:u.searchParams.get('requestId') })));
      }
      if (req.method === 'GET' && pathname === '/api/queue') return send(res, 200, messageQueue.get(u.searchParams.get('threadId')));
      if (req.method === 'GET' && pathname === '/api/models') return send(res, 200, { data: (await models()).map(m => ({ id: m.id, model: m.model, displayName: m.displayName, description: m.description, isDefault: m.isDefault, defaultReasoningEffort: m.defaultReasoningEffort, supportedReasoningEfforts: m.supportedReasoningEfforts, inputModalities: m.inputModalities, serviceTiers: m.serviceTiers })), nextCursor: null });
      if (req.method === 'GET' && pathname === '/api/files') return send(res, 200, await listWorkspaceFiles(await workspace(u.searchParams), u.searchParams.get('path') || ''));
      if (req.method === 'GET' && pathname === '/api/files/search') return send(res, 200, await searchWorkspaceFiles(await workspace(u.searchParams), u.searchParams.get('q'), u.searchParams.get('path') || ''));
      if (req.method === 'GET' && pathname === '/api/file-content') return await sendWorkspaceContent(res, await workspace(u.searchParams), u.searchParams.get('path') || '', { download: u.searchParams.get('download') === '1' });
      if (req.method === 'GET' && pathname === '/api/file') return send(res, 200, await readWorkspaceFile(await workspace(u.searchParams), u.searchParams.get('path') || ''));
      if (req.method === 'GET' && pathname === '/api/git') {
        const directory=await workspace(u.searchParams),source=u.searchParams.get('source')||'all',id=u.searchParams.get('threadId');let turn;
        if(source==='turn'&&id){const native=await desktopHistoryFor(id);turn=native?native.turnDiff:core.turnDiffs.get(id);}
        return send(res, 200, await workspaceGit(directory, u.searchParams.get('path'), {source,turn}));
      }
      if (req.method === 'GET' && pathname === '/api/thread-media') { await serveNativeMedia(historyMedia,u.searchParams,res); return; }
      if (req.method === 'GET' && pathname === '/api/attachment') {
        await serveAttachment(attachmentStore,u.searchParams,res);return;
      }
      if (req.method === 'GET' && pathname === '/api/events') {
        const since = Number(u.searchParams.get('since') || 0);
        if (since === sequence && Number(u.searchParams.get('wait')) > 0) await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); eventWaiters.delete(finish); res.off('close', finish); resolve(); };
          const timer = setTimeout(finish, 20000); eventWaiters.add(finish); res.once('close', finish);
        });
        if (res.destroyed) return;
        return send(res, 200, { sequence, epoch: instance, online: !core.closed, reset: since > sequence || (!!events.length && since < events[0].id - 1), events: events.filter(e => e.id > since) });
      }
      if (req.method === 'GET' && pathname === '/api/projects') {
        const c = await catalog(u.searchParams.has('refresh'));
        return send(res, 200, { projects: c.projects, otherCount: c.threads.filter(t => !t.mobileProjectId).length, truncated: c.truncated, cache: catalogMeta(c) });
      }
      if (req.method === 'GET' && pathname === '/api/threads') {
        const c = await catalog(u.searchParams.has('refresh'));
        const info = t => ({ id: t.id, name: threadSettings[t.id]?.name || t.name, preview: cleanUserText(t.preview || '').slice(0,200), cwd: t.cwd, updatedAt: t.updatedAt, status: t.status, projectId: t.mobileProjectId, model: t.model });
        if (u.searchParams.has('ids')) { const ids = new Set(u.searchParams.get('ids').split(',').filter(Boolean).slice(0,100)); return send(res, 200, { data: c.threads.filter(t => ids.has(t.id)).map(info), nextCursor: null, cache: catalogMeta(c) }); }
        const projectId = u.searchParams.get('projectId');
        let matches = projectId === '_other' ? c.threads.filter(t => !t.mobileProjectId) : projectId ? c.threads.filter(t => t.mobileProjectId === projectId) : c.threads;
        const search = u.searchParams.get('q')?.trim().toLocaleLowerCase();
        if (search) matches = matches.filter(t => [t.name, cleanUserText(t.preview || '')].some(text => text?.toLocaleLowerCase().includes(search)));
        const offset = Math.max(0, Number(u.searchParams.get('cursor') || 0));
        return send(res, 200, { data: matches.slice(offset, offset + 50).map(info), nextCursor: offset + 50 < matches.length ? String(offset + 50) : null, cache: catalogMeta(c) });
      }
      if(req.method==='GET'&&pathname==='/api/history-window'){
        try{
          const parse=key=>{const value=u.searchParams.get(key);return value===null?undefined:/^(0|[1-9]\d*)$/.test(value)?Number(value):NaN;};
          return send(res,200,await historyWindow(u.searchParams.get('threadId'),{limit:parse('limit')??60,beforeRowId:parse('beforeRowId'),fromRowId:parse('fromRowId'),sourceEpoch:u.searchParams.get('sourceEpoch')??undefined,metadataOnly:u.searchParams.get('metadataOnly')==='1'}));
        }catch(error){return send(res,error.statusCode||500,{error:error.message,code:error.code||'HISTORY_WINDOW_FAILED'});}
      }
      if (req.method === 'GET' && pathname === '/api/history') return send(res, 200, await history(u.searchParams.get('threadId'), u.searchParams.get('cursor')));
      const data = req.method === 'POST' ? await body(req, pathname === '/api/upload' ? 30 * 1024 * 1024 : 12 * 1024 * 1024) : {};
      if (req.method === 'POST' && pathname === '/api/maintenance') {
        try {
          if (data.action === 'prepare-update') return send(res, 200, { ok:true, ...terminals.prepareUpdate() });
          if (data.action === 'cancel-update') return send(res, 200, { ok:true, ...terminals.cancelUpdate(data.token) });
          return fail(res, 400, '无效的维护操作');
        } catch (error) { return send(res, 409, { error:error.message, code:error.code, ...(Number.isInteger(error.livePTYCount) ? {livePTYCount:error.livePTYCount} : {}) }); }
      }
      if (req.method === 'POST' && pathname === '/api/thread/unarchive') {
        if (nativeArchive.isPending(data.threadId)) return fail(res, 409, '此会话正在核对归档结果，请等待确认后再恢复');
        try {
          const result = await archivedThreads.unarchive(data);
          if (result.unarchived && result.verified) {
            fullHistoryCache.delete(result.threadId); releaseDesktop(result.threadId);
            threadSettings[result.threadId]={...threadSettings[result.threadId],needsDesktopRefresh:true};await saveSettings();
            result.needsDesktopRefresh=true;result.desktopRefreshNotified=false;
            try{await archivedThreads.refreshDesktop(result.threadId,desktop);result.desktopRefreshNotified=true;}catch{}
            updateCatalogThread(result.thread);publish({ method:'bridge/archiveUpdated', params:result });
          }
          return send(res, 200, result);
        } catch (error) { return send(res, error.statusCode || 500, { error:error.message, ...(error.outcomeUnknown ? {outcomeUnknown:true} : {}), ...(error.sent === false ? {sent:false,blocked:true} : {}), ...(error.code ? {code:error.code} : {}) }); }
      }
      if (req.method === 'POST' && (pathname === '/api/projects' || /^\/api\/projects\/(create|update|read|remove)$/.test(pathname))) {
        const action = pathname === '/api/projects' ? data.action : pathname.split('/').at(-1);
        const result = await projectManager.handle(action, data);
        if (action === 'create' || action === 'update') catalogCache.invalidate({ project: { ...result.project, roots:result.project.roots.map(root => root.path) } });
        if (action === 'remove') { for (const [id, assigned] of projectAssignments) if (assigned === data.projectId) projectAssignments.delete(id); catalogCache.invalidate({ removeProject:data.projectId }); }
        return send(res, 200, result);
      }
      if (req.method === 'POST' && pathname === '/api/automations/intent') return send(res, 200, await automationCatalog.intent(data));
      if (req.method === 'POST' && pathname === '/api/organize') return send(res, 200, await organization.handle(data));
      if (['/api/skills', '/api/plugins'].includes(pathname) && ['GET', 'POST'].includes(req.method)) return send(res, 200, await capabilities.handle(pathname, req.method, u.searchParams, data, () => ['threadId', 'projectId', 'cwd'].some(key => u.searchParams.has(key)) ? workspace(u.searchParams) : cwd));
      if (req.method === 'POST' && pathname === '/api/queue') {
        const threadId = u.searchParams.get('threadId') || data.threadId;
        if (nativeArchive.isPending(threadId) && ['enqueue','resume','sendNow'].includes(data.action)) return fail(res, 409, '此会话正在核对归档结果，请等待确认后再发送');
        if (['enqueue','resume','sendNow'].includes(data.action)) await unarchivedThread(threadId);
        if (owned.has(threadId) && ['enqueue','resume','sendNow'].includes(data.action)) await nativeForOperation(threadId);
        return send(res, 200, await messageQueue.handle(threadId, data));
      }
      if (pathname === '/api/terminal' && ['GET', 'POST'].includes(req.method)) return send(res, 200, await terminals.handle(req.method, u.searchParams, data, () => workspace(u.searchParams)));
      if (req.method === 'POST' && pathname === '/api/upload') {
        try { return send(res, 200, await attachmentStore.upload(data)); }
        catch (error) { return fail(res, error.statusCode || 400, error.message); }
      }
      if (req.method === 'POST' && pathname === '/api/thread/rename') {
        const name = typeof data.name === 'string' ? data.name.trim().slice(0,200) : '';
        if (!name || !data.threadId) return fail(res, 400, '请输入任务名称');
        if (!draftThreads.has(data.threadId)) await core.call('thread/name/set', { threadId: data.threadId, name });
        threadSettings[data.threadId] = { ...threadSettings[data.threadId], name, customTitle:true, autoTitlePending:false }; await saveSettings(); catalogCache.invalidate({ patch: { id: data.threadId, name } }); fullHistoryCache.delete(data.threadId);
        return send(res, 200, { ok: true, name });
      }
      if (req.method === 'POST' && pathname === '/api/thread/archive') {
        if (archiveUnavailable) throw archiveUnavailable;
        if (messageQueue.get(data.threadId).items.length) return fail(res, 409, '请先清空该任务的发送队列再归档');
        const requestId = data.requestId || randomBytes(16).toString('hex');
        if (nativeArchive.isPending(data.threadId)) { const result = archiveResponse(await nativeArchive.status({ threadId:data.threadId, requestId })); return send(res, result.status === 'blocked' ? 409 : result.pending ? 202 : 200, result); }
        await desktopHistoryFor(data.threadId);
        if (core.activeTurns.has(data.threadId) || desktopActive.has(data.threadId) || turnsStarting.has(data.threadId)) return send(res, 409, { error:'请先停止任务再归档', status:'blocked', blocked:true, sent:false, pending:false, archived:false, verified:false, reason:'busy', threadId:data.threadId, requestId });
        if (await desktopOwnerFor(data.threadId)) {
          const result = archiveResponse(await nativeArchive.run({ threadId:data.threadId, requestId }));
          return send(res, result.status === 'blocked' ? 409 : result.pending ? 202 : 200, result);
        }
        if (!draftThreads.has(data.threadId)) await core.call('thread/archive', { threadId:data.threadId });
        const result = archiveResponse(await nativeArchive.status({ threadId:data.threadId, requestId }));
        return send(res, result.status === 'blocked' ? 409 : result.pending ? 202 : 200, result);
      }
      if (req.method === 'POST' && pathname === '/api/thread/compact') {
        await unarchivedThread(data.threadId);
        await nativeForOperation(data.threadId);
        if (desktopStale.has(data.threadId)) return fail(res, 503, '电脑端此会话的连接尚未恢复，请重新连接后压缩');
        if (core.activeTurns.has(data.threadId) || desktopActive.has(data.threadId) || turnsStarting.has(data.threadId)) return fail(res, 409, '任务正在运行，请先停止再压缩上下文');
        await desktop.compact(data.threadId, { requestId: data.requestId });
        fullHistoryCache.delete(data.threadId);
        return send(res, 200, { ok: true, started: true });
      }
      if (req.method === 'POST' && pathname === '/api/thread/edit') {
        if (data.confirmed !== true) return fail(res, 400, '编辑会替换所选消息及其后续对话，请先明确确认');
        if (typeof data.turnId !== 'string' || !data.turnId || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 160000) return fail(res, 400, '请选择消息并输入修改内容');
        await unarchivedThread(data.threadId);
        await nativeForOperation(data.threadId);
        if (desktopStale.has(data.threadId)) return fail(res, 503, '电脑端此会话的连接尚未恢复，请重新连接后编辑');
        if (core.activeTurns.has(data.threadId) || desktopActive.has(data.threadId) || turnsStarting.has(data.threadId)) return fail(res, 409, '任务正在运行，请先停止再编辑消息');
        if (messageQueue.get(data.threadId).items.length) await messageQueue.handle(data.threadId, { action: 'pause' });
        turnsStarting.add(data.threadId);
        try {
          await desktop.editUserTurn(data.threadId, { turnId: data.turnId, message: data.text.trim(), allowEarlierMessages: true, requestId: data.requestId });
          fullHistoryCache.delete(data.threadId); pendingHistoryResets.add(data.threadId);
          try { const state = await desktop.snapshot(data.threadId, { fresh: true, timeout: 2000 }); if (state) { acceptDesktopHistory(data.threadId, desktopSnapshotHistory(state)); if (pendingHistoryResets.delete(data.threadId)) publish({ method: 'bridge/historyReset', params: { threadId: data.threadId } }); } } catch {}
          catalogCache.invalidate({ patch: { id: data.threadId, updatedAt: Math.floor(Date.now()/1000) } });
          return send(res, 200, { ok: true, started: true, refreshPending: pendingHistoryResets.has(data.threadId) });
        } finally { turnsStarting.delete(data.threadId); }
      }
      if (req.method === 'POST' && pathname === '/api/thread') {
        const directory = data.cwd?.trim() || cwd;
        if (!directory.startsWith('/')) return fail(res, 400, '请输入工作目录的完整路径');
        await workspaceAccess.ensure(directory);
        if (!(await stat(await realpath(directory))).isDirectory()) return fail(res, 400, '请选择工作目录');
        const settings = {...await requestedSettings(data),customTitle:typeof data.name==='string'&&!!data.name.trim(),autoTitlePending:!(typeof data.name==='string'&&data.name.trim())&&!data.initialText?.trim()};
        const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim().slice(0,200) : cleanUserText(data.initialText || '').split('\n').map(line => line.trim()).find(Boolean)?.slice(0,80) || '新任务';
        const projectId = data.projectId && data.projectId !== '_other' ? data.projectId : null;
        try {
          const create = hooks => nativeIntent.create({ cwd: directory, name, ...settings, ...(projectId ? { projectId } : {}), ...hooks });
          const result = data.requestId ? await creations.run(data.requestId, create) : await create({});
          if (result.creation?.needsAttach) {
            const threadId = result.thread.id, persisted = !!result.desktop?.persisted, writerReleased = !!result.desktop?.writerReleased;
            threadSettings[threadId] = { ...settings, name, requiresDesktop:true, pendingDesktop:true }; await saveSettings();
            if (projectId) projectAssignments.set(threadId, projectId);
            try { updateCatalogThread({ ...await threadRead(threadId), name }); } catch {}
            return send(res, 409, { error:persisted ? '任务已保存，Codex 桌面接管尚待确认，请重试连接同一条任务' : '已分配任务编号，保存和接管状态尚待确认，请核对后恢复同一条任务', threadId, persisted, writerReleased, recoverable:true, needsAttach:persisted && writerReleased, creation:result.creation });
          }
          owned.delete(result.thread.id); draftThreads.delete(result.thread.id);
          threadSettings[result.thread.id] = { ...result.settings, ...settings, name, requiresDesktop: true, pendingDesktop: false }; await saveSettings();
          if (projectId) projectAssignments.set(result.thread.id, projectId);
          updateCatalogThread({ ...result.thread, status: { type: 'idle' } });
          return send(res, 200, { ...result, settings: threadSettings[result.thread.id] });
        } catch (error) {
          if (error.threadId) {
            threadSettings[error.threadId] = { ...settings, name, requiresDesktop: true, pendingDesktop: true }; await saveSettings();
            if (projectId) projectAssignments.set(error.threadId, projectId);
            try { updateCatalogThread({ ...await threadRead(error.threadId), name }); } catch {}
          }
          throw error;
        }
      }
      if (req.method === 'POST' && pathname === '/api/thread/attach') {
        if (owned.has(data.threadId)) return fail(res, 409, '此任务仍由手机独立服务执行，请等待完成后在电脑端处理交接');
        await unarchivedThread(data.threadId);
        if(threadSettings[data.threadId]?.needsDesktopRefresh){try{await archivedThreads.refreshDesktop(data.threadId,desktop);}catch(error){if(error.code==='THREAD_ARCHIVED')throw error;}}
        let result,state;
        try{result=await nativeIntent.attach(data.threadId);state=await desktop.snapshot(data.threadId,{fresh:true,timeout:1500});if(!state)throw new Error('missing desktop snapshot');}
        catch(cause){throw Object.assign(new Error('桌面接管后的会话状态尚未同步，请重试连接原会话'),{threadId:data.threadId,persisted:true,writerReleased:true,needsAttach:true,cause});}
        acceptDesktopHistory(data.threadId,desktopSnapshotHistory(state));
        threadSettings[data.threadId] = { ...threadSettings[data.threadId], requiresDesktop: true, pendingDesktop: false, needsDesktopRefresh:false }; await saveSettings();
        const thread = await threadRead(data.threadId); updateCatalogThread(thread); await desktopHistoryFor(data.threadId);
        return send(res, 200, { ...result, thread, settings: threadSettings[data.threadId] });
      }
      if (req.method === 'POST' && pathname === '/api/fork') {
        const boundaries = ['beforeTurnId', 'lastTurnId'].filter(key => Object.hasOwn(data,key));
        if (boundaries.length > 1) return fail(res, 400, '只能选择一个分叉位置');
        if (boundaries.some(key => typeof data[key] !== 'string' || !data[key].trim())) return fail(res, 400, '请选择明确的消息位置');
        const projectId = data.projectId && data.projectId !== '_other' ? data.projectId : null;
        try {
          const result = await nativeIntent.fork(data.threadId, { beforeTurnId:data.beforeTurnId, lastTurnId:data.lastTurnId, wholeThread:boundaries.length===0, name:data.name, ...(projectId ? { projectId } : {}) });
          owned.delete(result.thread.id); draftThreads.delete(result.thread.id);
          threadSettings[result.thread.id] = { ...threadSettings[data.threadId], ...result.settings, customTitle:!!data.name?.trim()||threadSettings[data.threadId]?.customTitle===true, autoTitlePending:false, requiresDesktop:true, pendingDesktop:false }; await saveSettings();
          if (projectId) projectAssignments.set(result.thread.id, projectId);
          updateCatalogThread(result.thread); return send(res, 200, { ...result, thread: { ...result.thread, turns: (result.thread.turns || []).map(turn=>displayTurn(turn,{threadId:result.thread.id})) }, settings:threadSettings[result.thread.id] });
        } catch (error) {
          if (error.threadId) { threadSettings[error.threadId] = { ...threadSettings[data.threadId], customTitle:!!data.name?.trim()||threadSettings[data.threadId]?.customTitle===true, autoTitlePending:false, requiresDesktop:true, pendingDesktop:true }; await saveSettings(); try { updateCatalogThread(await threadRead(error.threadId)); } catch {} }
          throw error;
        }
      }
      if (req.method === 'POST' && pathname === '/api/message') {
        if (!data.threadId || (typeof data.text !== 'string' && data.text != null) || (!data.text?.trim() && !data.attachments?.length && !data.files?.length)) return fail(res, 400, '消息不能为空');
        if (!data.requestId || typeof data.requestId !== 'string') return fail(res, 400, '消息缺少编号');
        if (nativeArchive.isPending(data.threadId)) return fail(res, 409, '此会话正在核对归档结果，请等待确认后再发送');
        return send(res, 200, await deliverMessage(data, {
          receipt:value=>receipts.get(`${value.threadId}:${value.requestId}`),
          prepare:async value=>{
            await unarchivedThread(value.threadId);
            if (owned.has(value.threadId)) await nativeForOperation(value.threadId);
            await desktopHistoryFor(value.threadId);
            if (desktopStale.has(value.threadId)) throw Object.assign(new Error('与电脑端此会话的连接已断开，任务状态待确认。请重新连接并核对会话后再发送。'), { statusCode:503, code:'DESKTOP_STALE', sent:false });
          },
          isBusy:value=>turnsStarting.has(value.threadId) || core.activeTurns.has(value.threadId) || desktopActive.has(value.threadId) || hasPendingDelivery(value,messageQueue),
          enqueue:value=>messageQueue.enqueue(value.threadId,value),
          dispatch:async value=>{const queue=messageQueue.get(value.threadId);if(queue.paused&&!queue.items.length)await messageQueue.handle(value.threadId,{action:'resume'});return dispatchMessage(value);},
        }));
      }
      if (req.method === 'POST' && pathname === '/api/interrupt') {
        if (messageQueue.get(data.threadId).items.length) await messageQueue.handle(data.threadId, { action: 'pause' });
        await desktopHistoryFor(data.threadId);
        const nativeTurn = desktopActive.get(data.threadId), turnId = nativeTurn || core.activeTurns.get(data.threadId);
        if (!turnId) return send(res, 200, { ok: true });
        if (nativeTurn) return send(res, 200, await desktop.interrupt(data.threadId, turnId));
        return send(res, 200, await core.call('turn/interrupt', { threadId: data.threadId, turnId }));
      }
      if (req.method === 'POST' && pathname === '/api/approval') {
        const nativeApproval = desktopApprovals.get(String(data.id));
        const r = nativeApproval ? { method: nativeApproval.method, params: nativeApproval } : core.requests.get(String(data.id)); if (!r) return fail(res, 404, '请求已失效');
        const respond = result => nativeApproval ? desktop.approval(nativeApproval.threadId, data.id, result).then(() => { desktopApprovals.delete(String(data.id)); engineEvent({ method: 'bridge/approvalResolved', params: { id: String(data.id), threadId: nativeApproval.threadId } }); }) : core.respond(data.id, result);
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(r.method)) {
          const decision = data.decision || (data.allow ? 'accept' : 'decline');
          if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision)) return fail(res, 400, '无效的授权选项');
          await respond({ decision });
        } else if (['execCommandApproval', 'applyPatchApproval'].includes(r.method)) {
          await respond({ decision: data.allow ? (data.scope === 'session' ? 'approved_for_session' : 'approved') : { denied: { rejection: '用户未允许此操作' } } });
        } else if (r.method === 'item/tool/requestUserInput') {
          await respond({ answers: data.answers || {} });
        } else if (r.method === 'item/permissions/requestApproval') {
          await respond({ permissions: data.allow ? r.params.permissions : {}, scope: data.scope === 'session' ? 'session' : 'turn' });
        } else if (r.method === 'mcpServer/elicitation/request') {
          await respond({ action: data.allow ? 'accept' : 'decline', content: data.content || null });
        } else return fail(res, 400, `此类请求暂未支持：${r.method}。请停止该任务后在桌面处理。`);
        return send(res, 200, { ok: true });
      }
      return fail(res, 404, '接口不存在');
    }
    if (req.method !== 'GET') return fail(res, 405, '不支持');
    const routes = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/pair': ['pair.html', 'text/html'], '/pair.js': ['pair.js', 'text/javascript'], '/vendor/marked.js': ['vendor/marked.js', 'text/javascript'], '/vendor/purify.js': ['vendor/purify.js', 'text/javascript'], '/vendor/xterm.js': ['vendor/xterm.js', 'text/javascript'], '/vendor/xterm-fit.js': ['vendor/xterm-fit.js', 'text/javascript'], '/vendor/xterm.css': ['vendor/xterm.css', 'text/css'] };
    const file = routes[pathname]; if (!file) return fail(res, 404, '页面不存在');
    if (pathname.startsWith('/pair') && !local(req)) return fail(res, 403, '请在电脑本机打开配对页面');
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` }); res.end(await readFile(resolve(root, 'public', file[0])));
  } catch (e) {
    if (!res.headersSent && e.code === 'THREAD_ARCHIVED') send(res, 409, { error:e.message, code:e.code, archived:true });
    else if (!res.headersSent && ['TERMINALS_ACTIVE','UPDATE_DRAIN_ACTIVE'].includes(e.code)) send(res, 409, { error:e.message, code:e.code, ...(Number.isInteger(e.livePTYCount) ? {livePTYCount:e.livePTYCount} : {}) });
    else if (!res.headersSent && e.code === 'WORKSPACE_PERMISSION_REQUIRED') send(res, 423, { error:e.message, code:e.code, permissionRequired:true, retryable:true });
    else if (!res.headersSent && [400,409,503].includes(e.statusCode)) send(res, e.statusCode, { error:e.message, ...(e.code?{code:e.code}:{}), ...(e.sent===false?{sent:false}:{}), ...(e.outcomeUnknown?{outcomeUnknown:true}:{}), ...(e.threadId?{threadId:e.threadId,persisted:!!e.persisted,writerReleased:!!e.writerReleased,recoverable:true,needsAttach:e.needsAttach ?? (!!e.persisted && !!e.writerReleased)}:{}) });
    else if (!res.headersSent && e.threadId) send(res, 409, { error: e.message, ...(e.code?{code:e.code}:{}), ...(e.outcomeUnknown?{outcomeUnknown:true}:{}), ...(e.stage?{stage:e.stage}:{}), threadId: e.threadId, persisted: !!e.persisted, writerReleased: !!e.writerReleased, recoverable: true, needsAttach: e.needsAttach ?? (!!e.persisted && !!e.writerReleased) });
    else if (!res.headersSent && e.outcomeUnknown) send(res, 409, { error: e.message, outcomeUnknown: true, ...(e.code?{code:e.code}:{}), ...(e.terminalId?{terminalId:e.terminalId}:{}) });
    else if (!res.headersSent && /active writer|already loaded|already running/i.test(e.message)) send(res, 409, { error: '电脑正在使用这条对话，可以接续副本，保留上下文继续操作。', needsFork: true });
    else if (!res.headersSent) send(res, 500, {error:e.message,...(e.code?{code:e.code}:{}),...(e.sent===false?{sent:false}:{})}); else res.end();
  }
});
const receipts = new Map();
await new Promise((ok, no) => { server.once('error', no); server.listen(port, process.env.CODEX_MOBILE_BIND || '127.0.0.1', ok); });
await writeFile(resolve(stateDir, 'server.pid'), String(process.pid), { mode: 0o600 });
await writeFile(resolve(stateDir, 'connection.json'), JSON.stringify({ port, token: accessToken }), { mode: 0o600 });
console.log(`Codex Mobile ready: http://127.0.0.1:${port}/pair`);
catalog().catch(() => {});
Promise.all(Object.keys(messageQueue.threads).map(desktopHistoryFor)).then(() => messageQueue.kickAll()).catch(() => {});
if (!process.argv.includes('--no-tunnel') && (gateway || process.argv.includes('--temporary-tunnel'))) {
  tunnel = new ManagedTunnel({ port, instance, stateDir, gateway, ...(gateway ? { provider: 'ssh' } : {}) });
  tunnel.on('state', state => {
    const changed = publicUrl !== state.url;
    publicUrl = state.url; tunnelError = state.error;
    if (changed && publicUrl) console.log('Phone tunnel verified; pairing QR updated.');
    if (changed && !publicUrl) console.log('Phone tunnel unavailable; reconnecting automatically.');
  });
  tunnel.start();
} else if (!gateway && !process.argv.includes('--no-tunnel')) { tunnelError = '固定服务器尚未配置'; }
function stop(code = 0) { if (closing) return; closing = true; clearInterval(organizationTimer); tunnel?.stop(); desktop.stop(); terminals.closeAll(); core.stop(); server.close(); setTimeout(() => process.exit(code), 500); }
process.on('SIGTERM', () => stop(0)); process.on('SIGINT', () => stop(0));
