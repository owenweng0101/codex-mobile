import { cleanUserText } from './view.mjs';

export const AUTO_TITLE_MAX_LENGTH = 60;

// Keep this list narrow: a meaningful existing title is never a placeholder.
export function isDefaultThreadTitle(title) {
  return title == null || typeof title === 'string' && /^(?:新任务|new task)?$/i.test(title.trim());
}

function titleText(text) {
  if (typeof text !== 'string') return '';
  return cleanUserText(text)
    .replace(/^\s*## My request:\s*/i, '')
    .replace(/<(?:user_query|user_request|request)>\s*([\s\S]*?)\s*<\/(?:user_query|user_request|request)>/gi, '$1')
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+)/, '').trim())
    .find(line => line && !/^```/.test(line)) || '';
}

function boundedTitle(text, maxLength) {
  const value = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  // Grapheme boundaries preserve emoji, variation selectors and combining marks.
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(part => part.segment);
  return parts.length > maxLength ? parts.slice(0, maxLength - 1).join('').trimEnd() + '…' : value;
}

/**
 * Pure fallback; never calls a model or writes a title. Prefer a native title.
 * Pass the authoritative current title and explicitly confirm first user input
 * from complete pre-send history (not draft membership or a paginated slice).
 * customTitle preserves an explicit rename even when it equals a placeholder.
 * Recheck the current title before persisting after an awaited send operation.
 */
export function autoTitleCandidate({ title, isFirstUserInput = false, customTitle = false, text = '', input = [], attachments = [], files = [], maxLength = AUTO_TITLE_MAX_LENGTH } = {}) {
  if (isFirstUserInput !== true || customTitle || !isDefaultThreadTitle(title)) return null;
  if (!Number.isInteger(maxLength) || maxLength < 2 || maxLength > AUTO_TITLE_MAX_LENGTH) throw new RangeError('maxLength must be between 2 and 60');
  const parts = Array.isArray(input) ? input : [];
  const media = Array.isArray(attachments) ? attachments : [];
  const content = titleText(text) || titleText(parts.filter(part => part?.type === 'text' || part?.type === 'input_text').map(part => part.text || '').join('\n'));
  if (content) return boundedTitle(content, maxLength) || null;
  const image = parts.some(part => ['image', 'localImage', 'local_image', 'input_image', 'image_url'].includes(part?.type)) || media.some(part => part?.kind === 'image' || /^image\//i.test(part?.mime || part?.mimeType || ''));
  if (image) return boundedTitle('图片任务', maxLength);
  if (media.length || (Array.isArray(files) && files.length) || parts.some(part => ['mention', 'file', 'input_file'].includes(part?.type))) return boundedTitle('文件任务', maxLength);
  return null;
}
