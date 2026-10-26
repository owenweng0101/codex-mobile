const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const attachmentPattern = /^[a-f0-9]{48}$/;
const nativeKeys = ['threadId', 'turnId', 'itemId', 'index'];
const badImage = () => Object.assign(new Error('图片不属于这页会话历史，请重新打开会话后再试。'), { statusCode: 403, code: 'MOBILE_IMAGE_SCOPE' });
const validId = value => typeof value === 'string' && idPattern.test(value) && !/^(?:data|file|https?):/i.test(value);

function exactKeys(params, keys) {
  return [...params.keys()].length === keys.length && keys.every(key => params.getAll(key).length === 1);
}

function reference(value, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !nativeKeys.includes(key))
    || ![value.threadId, value.turnId, value.itemId].every(validId)
    || !Number.isSafeInteger(value.index) || value.index < 0 || value.index > 2048
    || value.threadId !== context.threadId || value.turnId !== context.turnId || value.itemId !== context.itemId) return null;
  return { threadId: value.threadId, turnId: value.turnId, itemId: value.itemId, index: value.index };
}

function backendMedia(value, context) {
  const name = typeof value?.name === 'string' && value.name ? value.name.slice(0, 150) : undefined;
  if (typeof value?.url === 'string' && value.url.startsWith('/api/')) {
    let parsed;
    try { parsed = new URL(value.url, 'http://mobile.invalid'); } catch { return null; }
    if (parsed.origin !== 'http://mobile.invalid' || parsed.hash) return null;
    const params = parsed.searchParams;
    if (parsed.pathname === '/api/attachment' && exactKeys(params, ['id']) && attachmentPattern.test(params.get('id'))) {
      return { backendPath: '/api/attachment?id=' + params.get('id'), query: { threadId: context.threadId, attachmentId: params.get('id') }, ...(name ? { name } : {}) };
    }
    if (parsed.pathname === '/api/thread-media' && exactKeys(params, nativeKeys) && /^(?:0|[1-9]\d{0,3})$/.test(params.get('index') || '')) {
      const ref = reference({ threadId: params.get('threadId'), turnId: params.get('turnId'), itemId: params.get('itemId'), index: Number(params.get('index')) }, context);
      if (!ref) return null;
      return { backendPath: '/api/thread-media?' + new URLSearchParams(ref), query: ref, ...(name ? { name } : {}) };
    }
    return null;
  }
  const ref = reference(value?.reference, context);
  if (ref) return { backendPath: '/api/thread-media?' + new URLSearchParams(ref), query: ref, ...(name ? { name } : {}) };
  return null;
}

function pageMedia(page, { cursor } = {}) {
  const threadId = page?.thread?.id;
  if (!validId(threadId)) throw Object.assign(new Error('会话历史缺少真实编号。'), { statusCode: 400 });
  const output = [];
  for (const turn of page.turns || []) {
    if (!validId(turn?.id)) continue;
    for (const item of turn.items || []) {
      if (!validId(item?.id)) continue;
      const context = { threadId, turnId: turn.id, itemId: item.id };
      let values = [];
      if (item.type === 'userMessage') values = (item.content || []).filter(value => value?.type === 'image' || value?.type === 'attachment' && value.kind === 'image');
      else if (item.type === 'imageGeneration' && item.media) values = [item.media];
      else if (item.type === 'agentMessage') values = item.inlineImages || [];
      for (const value of values) {
        const media = backendMedia(value, context);
        if (!media) continue;
        const params = new URLSearchParams(media.query);
        if (typeof cursor === 'string' && cursor) params.set('cursor', cursor);
        const inline=item.type==='agentMessage'&&Number.isSafeInteger(value.start)&&Number.isSafeInteger(value.end)&&value.start>=0&&value.end>value.start&&value.end<=item.text.length?{start:value.start,end:value.end,alt:String(value.alt||'图片')}:undefined;
        output.push({ turnId: turn.id, itemId: item.id, ...media,...(inline?{inline}:{}), url: '/mobile/api/image?' + params });
      }
    }
  }
  return output;
}

// Backend desktop turns use seconds for startedAt; tolerate epoch milliseconds
// and ISO timestamps from other history sources without inventing a start time.
function timestampMs(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const ms = Math.round(value < 1e11 ? value * 1000 : value);
  return Number.isSafeInteger(ms) && ms <= 8640000000000000 ? ms : null;
}

const toolLabels = new Map([
  ['commandExecution', '执行命令'], ['fileChange', '修改文件'],
  ['mcpToolCall', '调用工具'], ['dynamicToolCall', '调用工具'],
  ['webSearch', '搜索网页'], ['collabAgentToolCall', '子任务'],
  ['contextCompaction', '整理上下文'],
]);
const statuses = new Set(['inProgress', 'in_progress', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'declined', 'generating', 'queued', 'sending', 'uncertain']);
const safeStatus = value => statuses.has(value) ? value : null;

function projectQueue(queue, threadId) {
  if (!queue || queue.threadId !== threadId || !Array.isArray(queue.items)) return null;
  return {
    threadId, paused: queue.paused === true,
    error: queue.error ? '队列发送异常，请检查待发送消息。' : null,
    items: queue.items.filter(item => validId(item?.id)).map(item => ({
      id: item.id, text: typeof item.text === 'string' ? item.text : '',
      status: safeStatus(item.status), createdAt: timestampMs(item.createdAt),
      error: item.error ? '发送未完成，请核对后重试。' : null,
      attachmentCount: Array.isArray(item.attachments) ? item.attachments.length : 0,
      fileCount: Array.isArray(item.files) ? item.files.length : 0,
    })),
  };
}

// Backend /api/history has already stripped system envelopes and projected
// media to native references. Commentary is conversational text, not a tool log.
export function projectMobileHistory(page, options = {}) {
  const media = pageMedia(page, options), messages = [];
  for (const turn of page.turns || []) for (const item of turn.items || []) {
    if (!validId(item?.id)) continue;
    const kind = item.type === 'reasoning' ? 'reasoning' : toolLabels.has(item.type) ? 'tool' : 'message';
    const role = item.type === 'userMessage' ? 'user' : kind !== 'message' || ['agentMessage', 'plan', 'imageGeneration'].includes(item.type) ? 'assistant' : null;
    if (!role) continue;
    const status = safeStatus(item.status) || (role === 'user' ? 'completed' : safeStatus(turn.status));
    const text = role === 'user'
      ? (item.content || []).filter(value => value?.type === 'text' && typeof value.text === 'string').map(value => value.text).join('\n')
      : kind === 'reasoning' ? (Array.isArray(item.summary) ? item.summary.filter(value => typeof value === 'string').join('\n') : '')
      : kind === 'tool' ? toolLabels.get(item.type)
      : typeof item.text === 'string' ? item.text : '';
    const images = media.filter(image => image.turnId === turn.id && image.itemId === item.id).map(({ url, name, inline }) => ({ url, ...(name ? { name } : {}),...(inline?{inline}:{}) }));
    if (text || images.length) messages.push({ id: item.id, ...(validId(item.clientUserMessageId) ? { requestId: item.clientUserMessageId } : {}), turnId: turn.id, role, kind, status, createdAt: timestampMs(item.createdAt), text, images });
  }
  const thread = Object.fromEntries(['id', 'name', 'preview', 'cwd', 'model', 'reasoningEffort', 'projectId', 'status', 'archived', 'createdAt', 'updatedAt'].filter(key => page.thread[key] !== undefined).map(key => [key, page.thread[key]]));
  const settings = Object.fromEntries(['model', 'effort', 'reasoningEffort', 'mode'].filter(key => page.settings?.[key] !== undefined).map(key => [key, page.settings[key]]));
  const active = (page.turns || []).find(turn => turn.id === page.activeTurn);
  return { thread, messages, nextCursor: page.nextCursor ?? null, activeTurn: page.activeTurn ?? null, activeTurnStartedAt: timestampMs(active?.startedAt), queue: projectQueue(page.queue, thread.id), settings, desktopConnected: page.desktopConnected === true };
}

export function projectAssistantText(item,images){
  let text=item.text||'';
  for(const image of images.filter(image=>image.inline).sort((a,b)=>b.inline.start-a.inline.start)){
    const {start,end,alt}=image.inline;
    text=text.slice(0,start)+'!['+alt.replace(/[\[\]\\\r\n]/g,'')+']('+image.url+'&preview=1)'+text.slice(end);
  }
  return text;
}

// Only proxies a concrete image already represented in this page. The caller
// reads the cursor named in the image URL, then forwards this exact backend
// path using its server-side credential; no caller-controlled URL is accepted.
export function resolveMobileImagePath(page, query) {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams(query);
  const keys = params.has('attachmentId') ? ['threadId', 'attachmentId'] : [...nativeKeys];
  if (params.has('cursor')) keys.push('cursor');
  if (!exactKeys(params, keys) || params.get('threadId') !== page?.thread?.id) throw badImage();
  const cursor = params.get('cursor');
  const match = pageMedia(page, { cursor }).find(image => {
    const expected = new URL(image.url, 'http://mobile.invalid').searchParams;
    return keys.every(key => expected.get(key) === params.get(key));
  });
  if (!match) throw badImage();
  return match.backendPath;
}
