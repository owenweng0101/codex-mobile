export function createAttachmentScope({api, readTree}) {
  return async (p, sessionId) => {
    const tree = await readTree();
    const known = tree.conversationWorkspacePath === p.workspacePath
      || tree.tasks.some(t => t.workspacePath === p.workspacePath)
      || (tree.projects || []).some(x => (x.roots || []).some(r => r.rootPath === p.workspacePath));
    if (!known) throw Error('附件工作区未授权');
    if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId || '')) {
      const page = await api.get('/api/thread-metadata?threadId=' + encodeURIComponent(sessionId));
      if (page.thread?.id !== sessionId || page.thread?.cwd !== p.workspacePath || page.thread?.archived !== false) {
        throw Error('附件会话不属于当前工作区');
      }
    }
    return true;
  };
}
