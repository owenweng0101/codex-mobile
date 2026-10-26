import {createHash} from 'node:crypto';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_BYTES = 512 * 1024; // Original UI emits 384 KiB; V4 accepts up to 512 KiB.
const MAX_CHUNKS = 64;
const MAX_ACTIVE = 4;
const MAX_RECEIPTS = 128;
const TTL_MS = 5 * 60 * 1000;
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code = 'CODEX_ATTACHMENT_INVALID_INPUT') => Object.assign(new Error(message), {code});

/** Strict, pure parser. A parsed ID is not evidence of workspace ownership. */
export function attachmentRefToUploadId(ref) {
  const match = typeof ref === 'string' && /^\/api\/attachment\?id=([a-f0-9]{48})$/.exec(ref);
  if (!match || match[0] !== ref) throw fail('无效的原生附件引用', 'CODEX_ATTACHMENT_INVALID_REF');
  return match[1];
}

/**
 * Merge the returned enumerable methods into the zcode-agent channel.
 * api.post('/api/upload', {name, dataUrl, requestId}) must use the scoped native transport.
 * scope(params, params.sessionId) must authorize the workspace on EVERY call. It
 * must allow a draft session ID for first-input uploads (no native thread yet).
 * Keep one instance across RPC reconnects; call the non-enumerable dispose() on shutdown.
 * Pass the non-enumerable resolveAttachment to the writer for committed-ref ownership checks.
 * No disk, credentials, message sends, or runtime discovery are performed here.
 */
export function createAttachmentUploadServices({api, scope} = {}) {
  if (typeof api?.post !== 'function' || typeof scope !== 'function') {
    throw new TypeError('Scoped api.post and scope are required');
  }
  const uploads = new Map();
  let disposed = false;
  let nativePosts = 0;

  function discard(key, record, error) {
    clearTimeout(record.timer);
    record.chunks.clear();
    record.cancel?.(error);
    if (uploads.get(key) === record) uploads.delete(key);
  }
  function touch(key, record) {
    clearTimeout(record.timer);
    record.timer = setTimeout(() => discard(key, record,
      fail('附件上传已超时，请重新上传', 'CODEX_ATTACHMENT_EXPIRED')), TTL_MS);
    record.timer.unref?.();
  }
  async function authorizeScope(p) {
    if (disposed) throw fail('附件上传服务已关闭', 'CODEX_ATTACHMENT_DISPOSED');
    if (typeof p.workspacePath !== 'string' || !p.workspacePath.trim() || p.workspacePath.length > 4096 ||
        p.workspacePath.includes('\0') || p.workspaceIdentity != null || p.remoteSessionId != null ||
        typeof p.sessionId !== 'string' || !p.sessionId.trim() || p.sessionId.length > 256) {
      throw fail('附件工作区、会话或上传标识无效', 'CODEX_ATTACHMENT_SCOPE');
    }
    if (await scope({...p}, p.sessionId) === false) throw fail('附件工作区未授权', 'CODEX_ATTACHMENT_SCOPE');
    if (disposed) throw fail('附件上传服务已关闭', 'CODEX_ATTACHMENT_DISPOSED');
  }
  async function identity(params) {
    // Snapshot before awaiting authorization so callers cannot mutate the identity.
    const p = {...params};
    if (typeof p.uploadId !== 'string' || /[\r\n]/.test(p.uploadId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(p.uploadId)) {
      throw fail('附件上传标识无效', 'CODEX_ATTACHMENT_SCOPE');
    }
    await authorizeScope(p);
    return {p, key: JSON.stringify([p.workspacePath, p.sessionId, p.uploadId])};
  }
  function existing(key) {
    const record = uploads.get(key);
    if (!record) throw fail('附件上传不存在或已过期', 'CODEX_ATTACHMENT_NOT_FOUND');
    return record;
  }
  function progress(record) {
    return {uploadId: record.uploadId, state: record.ref ? 'committed' : 'staging',
      nextChunkIndex: record.nextChunkIndex, ...(record.ref ? {ref: record.ref} : {})};
  }
  function metadata(p) {
    if (typeof p.fileName !== 'string' || !p.fileName.trim() || p.fileName.length > 255 || /[\0\r\n]/.test(p.fileName) ||
        !IMAGE_MIMES.has(p.mime) || !Number.isSafeInteger(p.totalBytes) || p.totalBytes < 1 || p.totalBytes > MAX_BYTES ||
        !Number.isSafeInteger(p.totalChunks) || p.totalChunks < 1 || p.totalChunks > MAX_CHUNKS ||
        p.totalChunks > p.totalBytes || p.totalBytes > p.totalChunks * MAX_CHUNK_BYTES ||
        typeof p.checksum !== 'string' || p.checksum.length !== 71 || !/^sha256:[a-f0-9]{64}$/.test(p.checksum)) {
      throw fail('只支持不超过8MB的PNG、JPEG、GIF、WebP图片，且分块元数据必须有效');
    }
    return JSON.stringify([p.fileName, p.mime, p.totalBytes, p.totalChunks, p.checksum]);
  }

  const methods = {
    async attachmentBeginV4(params) {
      const {p, key} = await identity(params);
      const fingerprint = metadata(p);
      const prior = uploads.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail('同一uploadId不能更换附件', 'CODEX_ATTACHMENT_CONFLICT');
        if (!prior.pending) touch(key, prior);
        return progress(prior);
      }
      const active = [...uploads.values()].filter(record => !record.ref).length;
      if (active >= MAX_ACTIVE || nativePosts >= MAX_ACTIVE) throw fail('同时上传的附件过多，请稍后重试', 'CODEX_ATTACHMENT_BUSY');
      const receipts = [...uploads].filter(([, record]) => record.ref);
      if (receipts.length >= MAX_RECEIPTS) discard(...receipts[0]);
      const record = {workspacePath: p.workspacePath, uploadId: p.uploadId, fingerprint, fileName: p.fileName, mime: p.mime,
        totalBytes: p.totalBytes, totalChunks: p.totalChunks, checksum: p.checksum,
        chunks: new Map(), receivedBytes: 0, nextChunkIndex: 0};
      uploads.set(key, record);
      touch(key, record);
      return progress(record);
    },

    async attachmentChunkV4(params) {
      const {p, key} = await identity(params);
      const record = existing(key);
      if (record.ref || record.pending) throw fail('附件已经提交', 'CODEX_ATTACHMENT_CONFLICT');
      if (!Number.isSafeInteger(p.chunkIndex) || p.chunkIndex < 0 || p.chunkIndex >= record.totalChunks ||
          typeof p.dataBase64 !== 'string' || !p.dataBase64.length ||
          p.dataBase64.length > Math.ceil(MAX_CHUNK_BYTES / 3) * 4 || p.dataBase64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(p.dataBase64)) throw fail('附件分块无效');
      const bytes = Buffer.from(p.dataBase64, 'base64');
      if (bytes.length > MAX_CHUNK_BYTES || bytes.toString('base64') !== p.dataBase64) throw fail('附件分块编码无效');
      const prior = record.chunks.get(p.chunkIndex);
      if (prior && !prior.equals(bytes)) throw fail('重试分块内容发生改变', 'CODEX_ATTACHMENT_CONFLICT');
      if (!prior) {
        if (record.receivedBytes + bytes.length > record.totalBytes) throw fail('附件超出声明大小');
        record.chunks.set(p.chunkIndex, bytes);
        record.receivedBytes += bytes.length;
        while (record.chunks.has(record.nextChunkIndex)) record.nextChunkIndex++;
      }
      touch(key, record);
      return {uploadId: p.uploadId, nextChunkIndex: record.nextChunkIndex};
    },

    async attachmentCommitV4(params) {
      const {p, key} = await identity(params);
      const record = existing(key);
      if (record.ref) return {ref: record.ref};
      if (record.pending) return record.pending;
      if (record.nextChunkIndex !== record.totalChunks || record.receivedBytes !== record.totalBytes) {
        throw fail('附件分块尚未完整接收', 'CODEX_ATTACHMENT_INCOMPLETE');
      }
      const bytes = Buffer.concat(Array.from({length: record.totalChunks}, (_, i) => record.chunks.get(i)), record.totalBytes);
      if ('sha256:' + hash(bytes) !== record.checksum) {
        discard(key, record);
        throw fail('附件校验失败，请重新上传', 'CODEX_ATTACHMENT_CHECKSUM');
      }
      if (nativePosts >= MAX_ACTIVE) throw fail('附件上传繁忙', 'CODEX_ATTACHMENT_BUSY');
      // Include immutable metadata: even after expiry/restart, a reused client ID
      // cannot silently acquire a receipt for a different file or workspace.
      const body = {name: record.fileName, dataUrl: `data:${record.mime};base64,${bytes.toString('base64')}`,
        requestId: 'zcv4_upload_' + hash(JSON.stringify([key, record.fingerprint]))};
      const canceled = new Promise((_, reject) => { record.cancel = reject; });
      touch(key, record);
      nativePosts++;
      const posted = Promise.resolve().then(() => api.post('/api/upload', body)).finally(() => { nativePosts--; });
      record.pending = Promise.race([posted, canceled]).then(result => {
        if (uploads.get(key) !== record) throw fail('附件上传已取消', 'CODEX_ATTACHMENT_ABORTED');
        const id = attachmentRefToUploadId(result?.url);
        if (result?.id !== id || result?.mime !== record.mime || result?.size !== record.totalBytes || typeof result?.name !== 'string') {
          throw fail('原生上传回执无效', 'CODEX_ATTACHMENT_INVALID_RECEIPT');
        }
        record.ref = '/api/attachment?id=' + id;
        record.chunks.clear();
        touch(key, record);
        return {ref: record.ref};
      }).finally(() => {
        record.pending = null;
        record.cancel = null;
      });
      return record.pending;
    },

    async attachmentAbortV4(params) {
      const {key} = await identity(params);
      const record = uploads.get(key);
      // A committed receipt remains retryable; abort cannot delete a native file.
      if (record && !record.ref) discard(key, record, fail('附件上传已取消', 'CODEX_ATTACHMENT_ABORTED'));
      return {};
    },
  };
  Object.defineProperty(methods, 'resolveAttachment', {value: async function(params) {
    const p = {...params};
    await authorizeScope(p);
    const id = attachmentRefToUploadId(p.ref);
    // Ownership follows the authorized workspace, allowing draft -> native session
    // transitions. A syntactically valid native ID alone never grants ownership.
    for (const record of uploads.values()) {
      if (record.ref === p.ref && record.workspacePath === p.workspacePath) return {id};
    }
    throw fail('附件未在当前工作区提交或上传记录已过期，请重新上传', 'CODEX_ATTACHMENT_NOT_FOUND');
  }});
  Object.defineProperty(methods, 'dispose', {value() {
    disposed = true;
    for (const [key, record] of uploads) discard(key, record, fail('附件上传服务已关闭', 'CODEX_ATTACHMENT_DISPOSED'));
  }});
  return methods;
}
