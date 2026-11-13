# Read-only ConversationV4 boundary

This stage contains a new Codex data adapter, not a copied ZCode engine. It keeps the existing copied H5, renderer, RPC, frame assembly, and replay code. `conversation-read.mjs` imports and executes the copied original schemas at runtime; the original application and credentials are never started/read.

## Original source evidence

Paths below are relative to the shared `work/` directory. Offsets are character offsets in the unmodified minified files (not source line numbers).

- `zcode-copy-audit-host/out/host/index.js` offset 514127 `subscribeConversationV4`: obtains the original CLI, sends `conversationSubscribe`, returns `{ack:{subscriptionId,mode,logEpoch,openTiming?}}` and forwards frames.
- Same file offset 516120 `sendConversationCommandV4`: executes the command envelope through original CLI. It is not a history-read API. Keep all commands rejected in this read stage.
- Same file offset 523283 `subscribeSessionsIndexV4`: same topic-subscribe protocol, topic derived from workspace key. Return shape `{ack:{subscriptionId,mode,logEpoch}}`.
- `zcode-copy-audit-20261025/web/remote/v4/3.16.3/assets/parts-BD-IKHpw.js` offset 12161 `Bt`: original logical-frame schema; export `w` (`Vt`) validates conversations, `O` (`F`) validates sessions-index.
- Same file offset 8605 `At`: wire `deliveryKind` is **initial / online / recovery**, not snapshot. Complete envelope has `{wireVersion:3,kind:'complete',deliveryKind,logicalFrameId,logicalFrameOrdinal,topic,subscriptionId,frame}`.
- Same file `St`, exported as `k`: original conversation delta reducer. Original H5 still owns replay/assembly. This adapter does not generate deltas.
- `.../validation-B6yV_dPD.js` offset 208000 onward: original typed `userInput`, `assistantText`, `reasoning`, `toolCall` rows. Offset 221150 `Vv`, export `M`, validates the full snapshot. Offset 248811 `Cx`, export `u`, validates the sessions index snapshot.
- Original H5 entry offset 254566 subscribes conversation; offset 260737 listens through `onDynamicConversationFrame`. The old legacy `getTaskSnapshot` response is not this UI's V4 source.

## Wiring

After real Codex read services are wrapped by real events:

```js
const v4 = createConversationReadServices({api, baseServices: events.channels, eventAdapter: events});
// Register v4.channels in the original ProxyChannel/ChannelServer.
// At shutdown: v4.dispose(); events.dispose();
```

The returned `zcode-agent` delegates hello and other support methods to the existing service and adds:

- Conversation/index subscribe, resync, unsubscribe, and frame events.
- `conversationRowsRangeV4` on already scoped/read native rows, preserving seq/revision/logEpoch.
- Explicit rejection of every `sendConversationCommandV4` type.

The scope must match a real catalog task/workspace before native history is read. Each page must retain the exact thread ID and cwd. Pagination loads all native pages with a cap of 30; exceeding the cap fails instead of inventing a total. Original snapshots carry only the last 60 rows; earlier rows remain available through the original range endpoint. The full snapshot is validated before frames are emitted; the original renderer receives its own row schema, not legacy message objects.

Real native event invalidations trigger fresh GETs and new snapshots. Initial event polling establishes a baseline. Each connection's subscriptions use independent IDs/log epochs. This read stage has no model request, CLI startup, resume, create, attach, or message-send path.

## Honest limitations

This is an original-protocol **read adapter**, not a complete Codex control implementation. Native command execution, permissions, background work, queue, goals, plans, token accounting, attachment byte reads, and original session file paths are not exposed. Writing controls are disabled by `availability` and `inputRouting=reject`.

The original schema requires queue/usage/pending/background structures. In this stage empty arrays and zero cumulative counters describe only the adapter-local unimplemented subsystems, not proof that Codex has no native work/usage/approvals. Context usage is null and the exported capability `tokenAccounting=false` is explicit. Native tool types without an unambiguous native execution status are omitted, not marked successful. This limitation must remain visible in acceptance notes until those fields are mapped or the original view is narrowly adapted to hide unavailable metrics.

## Verification

`node --test frontend-stage/conversation-read.test.mjs`: 3 tests use fixture native history, original schema validators, original Emitter, subscribe/frame/ACK/resync/range/release/native invalidation, rejected command, and rejected out-of-scope access before GET. They prove data/protocol contract only. The root task owns actual Codex GET, original H5 browser rendering, and phone verification.
