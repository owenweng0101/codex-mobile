// These are native history request budgets, not rendered-row slicing. The Host
// counts append-origin user/assistant messages and retains intervening events,
// source-event groups, projections and the authoritative follow cursor.
export const MOBILE_INITIAL_HISTORY_MESSAGES = 20;
export const MOBILE_OLDER_HISTORY_MESSAGES = 40;

export function patchMobileHistoryWindow(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Pinned session history changed; review mobile paging: ' + before);
    source = source.replace(before, after);
  };
  // Keep the native large-window policy for explicit historical turn jumps.
  replace('const HISTORY_PAGE_OPTIONS = {',
    `const MOBILE_INITIAL_HISTORY_PAGE_OPTIONS = { maxMessages: ${MOBILE_INITIAL_HISTORY_MESSAGES} };\n\t\tconst MOBILE_OLDER_HISTORY_PAGE_OPTIONS = { maxMessages: ${MOBILE_OLDER_HISTORY_MESSAGES} };\n\t\tconst HISTORY_PAGE_OPTIONS = {`);
  replace('await events.open(HISTORY_PAGE_OPTIONS);', 'await events.open(MOBILE_INITIAL_HISTORY_PAGE_OPTIONS);');
  replace('beforeSeq: this.baseSeq,\n\t\t\t\t\t\t...HISTORY_PAGE_OPTIONS', 'beforeSeq: this.baseSeq,\n\t\t\t\t\t\t...MOBILE_OLDER_HISTORY_PAGE_OPTIONS');
  return source;
}
