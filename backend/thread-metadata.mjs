// Authorization reads do not need rollout pages, desktop history or attachments.
// Never cache: an archive/move must be visible on the next upload chunk.
export async function threadMetadata(threadId, {readThread, drafts}) {
  if (typeof threadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
    throw Object.assign(new Error('无效的会话标识'), {statusCode:400});
  }
  const thread = drafts?.get(threadId) ?? await readThread(threadId);
  if (thread?.id !== threadId || typeof thread.cwd !== 'string' || !thread.cwd) {
    throw Object.assign(new Error('无法确认会话所属工作区'), {statusCode:409});
  }
  return {thread: {id:thread.id, cwd:thread.cwd,
    archived:thread.archived === true || !!thread.path?.includes('/archived_sessions/')}};
}
