// Keep the ordinary phone composer's action in one fixed slot while a follow-up
// is being submitted. The native desktop layout adds a second Stop next to a
// disabled sending button; reuse the primary slot for that same Stop instead.
// Continuable subagents retain their separate, intentional Stop control.
export function patchMobileComposerActions(source) {
  const replacements = [
    [
      'const primaryStops = running && subagent === null && !sending && (empty || blocked !== void 0);',
      'const primaryStops = running && subagent === null && (sending ? !cancelDenied : empty || blocked !== void 0);',
    ],
    [
      'const interruptible = running && (continuable || sending && subagent === null);',
      'const interruptible = running && continuable;',
    ],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('Pinned InputBar changed; review mobile action handoff: ' + before);
    source = source.replace(before, after);
  }
  return source;
}
