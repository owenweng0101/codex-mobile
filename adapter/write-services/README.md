# Original H5 write contract — isolated implementation stage

This directory is not wired into the active server. No real POST, native message, model, interrupt, or desktop startup was executed while building it. The API and expected-turn drivers used by tests are fixtures.

`createWriteServices({api,baseServices,ledgerDir,native?,revisionGuard?})` returns `{channels,ledger,capabilities}`. Register `channels` only after the root task reviews and integrates the native contracts below. The capability booleans describe implemented adapter handlers; they are not proof that the original UI can execute them against a real Codex runtime.

## Original mobile call path and native IDs

The unmodified original H5 `index-BsmXQHMM.js`:

- Offset 254566: conversation transport sends `zcode-agent.sendConversationCommandV4({...workspace,envelope})` through its transport `sendCommand` (actual send wrapper at 257751).
- Offset 2781589: draft prewarm dispatches `createSession({workspaceId,config?},sessionId:null)`. Offset 2781815 consumes `ack.result.sessionId`.
- Offset 2225660: original persistent outbox `remapCreatedSession` moves a create command to returned `result.sessionId` when accepted/duplicate. It does not require the draft ID to become a native ID.
- Offset 4795853: direct `createSession({workspaceId,firstInput},null)` also navigates to `result.sessionId`.
- Offset 4590471: composer dispatches `sendText({text,requestedDelivery?,modelSelection?,...},sessionId)` after draft promotion.
- Offset 4600714: stop dispatches `stop({expectedForegroundExecutionId?},sessionId)` from snapshot `control.activeWorks`.

Therefore original create ACK can carry the **real Codex-allocated UUID**. The adapter rejects client-chosen creation IDs and never passes a draft ID as native ID.

`parts-BD-IKHpw.js` contains original payload schemas at offset 34100 onward and command ACK schema `In` at approximately 39600. `build-original-schemas.mjs` preserves the original module/schema/UI logic, adjusts exactly three dependency locations and adds exports for the already existing original payload/ACK schemas. Hashes and counts are in `vendor/schema-manifest.json`. Every returned ACK executes the original `In.parse`; tests include `delivery:'guide'` and prove that exact value is accepted by the original schema.

Original ACK shape:

```js
{
  commandId,
  status: 'accepted' | 'rejected' | 'stale' | 'duplicate' | 'noop' | 'failed',
  revisionAtDecision: number,
  reasonCode?, message?,
  result?:
    {type:'createSession', sessionId: nativeId,
      input?:{delivery:'startNow'|'queue'|'guide',inputId,messageId?}}
    | {type:'inputAccepted',delivery:'startNow'|'queue'|'guide',inputId,messageId?}
}
```

## Existing native HTTP boundaries

Read-only inspection of `outputs/codex-mobile/server.mjs` and `desktop-bridge.mjs` found:

- `POST /api/thread` really creates a native Codex thread through `nativeIntent.create`, has an existing creation ledger, and returns `thread.id`. It can return a recoverable 409 with allocated native ID while desktop attach is pending. The adapter never turns that pending attach into accepted success **for a creation that carries a first input**; an input-less creation (the mobile draft prewarm) is accepted as soon as the allocated native ID is readable in the recorded workspace, because nothing is queued inside it and its first message is delivered later through `/api/message` with its own desktop-ownership gate.
- `POST /api/message` forwards `requestId` as native `clientUserMessageId` and normally returns `turn.id`. It can also return 200 `{queued:true,...}` when busy, including a race after the read check. A queued or malformed response is **unknown**, never accepted startNow.
- There is **no `/api/steer` route** in the inspected server. The internal `desktop.steer` exists but is not exposed by that route.
- Old `POST /api/interrupt` accepts only threadId, pauses its queue, and interrupts whichever turn is currently active. It ignores expected-turn preconditions and is **not safe to map** to the original expected-foreground command.

The stage therefore defaults stop and guide to unavailable. Root must inject real atomic drivers, not wrappers that GET-check then call the old unguarded POST:

```js
native: {
  async steerExpected({threadId,expectedTurnId,input,requestId,model?,effort?,mode?}) {
    // Native operation must reject if the active turn changed.
    // Return only an actual native acceptance receipt {turn:{id}} or {turnId}.
  },
  async interruptExpected({threadId,expectedTurnId,requestId}) {
    // Native request must carry expectedTurnId through to the desktop owner.
    // Return {accepted:true,expectedTurnId} only after its successful ACK.
  }
}
```

There remains an implicit-queue race on the old `/api/message` path. Before production integration, root should provide a strict send endpoint/driver that rejects busy rather than enqueueing implicitly, or deliberately implement the original queue contract. This stage detects a queued return but cannot undo a queue operation already performed by the old service.

## Revisions are a blocking integration contract

The original H5 V4 `baseRevision/baseLogEpoch` refer to ZCode projection state. The read adapter's snapshot counter is not a Codex native compare-and-swap version. A received baseRevision or baseLogEpoch therefore returns original-schema `status:'stale'` with `codex.nativeRevisionUnavailable` unless an injected `revisionGuard` verifies the actual corresponding native state.

**If the original UI always includes either base field, the current default adapter blocks every such write.** This must be observed in real UI acceptance and fixed with a true native concurrency contract, not by accepting counters blindly. `revisionAtDecision:0` is adapter protocol metadata only and does not claim a native version.

## Write-ahead ledger and unknown outcomes

`ledger.mjs` requires an explicit isolated directory, uses directory mode0700 and files0600, and stores hashes, stable IDs and original ACKs rather than message bodies. A record is written to a temporary file, file-fsynced, renamed, and directory-fsynced. The dispatched checkpoint is durable **before** a native POST. Exclusive lock files prevent concurrent cross-process dispatch. Leftover locks fail closed; do not automatically delete them and resend.

Identity is workspacePath+commandId, with an envelope/client/project fingerprint. Changed content under the same commandId fails. Native requestId is deterministic `zcv4_<sha256>` and stays the same across retries/restarts. A complete record replays its original ACK. An incomplete/unknown record never dispatches another POST.

Creation and first input are two stages: checkpoint returned official nativeID before sending the first message; checkpoint the input requestId before message POST. Partial failure retains the known nativeID. It never creates a second thread to recover.

`queryConversationCommandsV4` uses GET only. It can confirm an input by an exact native `userMessage.id`/`clientUserMessageId` matching the persisted requestId. Matching text, title, timestamp, another active turn, or merely having a thread does not prove a send. If the old history API does not preserve that stable native ID, outcome remains unknown and requires a stronger native receipt endpoint. A creation without firstInput can be reconciled through its recorded nativeID plus an exact scoped read of that thread. The live `attached`/`desktopConnected` flags cannot decide creation: a new empty thread stays unattached on the desktop until its first turn starts, so requiring them reported every successful prewarm as an unknown outcome and blocked every phone attachment. Unknown stop results cannot be inferred from idle state because the turn might have ended independently.

The API's original request error must be classified by the root transport. This stage conservatively treats any thrown error after dispatch as unknown, even if some may later prove definitive. It does not auto-retry.

## Supported and blocked stage handlers

Implemented handlers: createSession, text sendText/startNow, native-driver sendText/guide, native-driver stop, queryCommands and GET reconciliation. Models must come from the real catalog and provider `codex-app`; only build/default mode is mapped. Root must verify the actual native catalog shape before integration.

Attachments, implicit queues, plan state, context refs, ambient browser context, file rewind, goals, model switching, approvals, workflow, deleteSession and every other command fail explicitly. Original automatic draft cleanup can issue deleteSession; it remains rejected. Therefore **original prewarm may leave empty native threads** unless a narrow entry adaptation disables prewarm or native cleanup is separately implemented. Do not enable prewarm creation in a live release without resolving that lifecycle.

## Verification

```sh
node --test work/zcode-codex-adapter-20261025/write-services/write-services.test.mjs
```

Six fixture contract tests pass: formal native ID creation+first send and durable replay; response-loss/restart/GET-only exact-ID recovery; durable dispatched checkpoint before POST and collision rejection; unsupported/draft/scope/revision/driver gates before POST; exact native expected-turn drivers and original guide ACK validation; queued response never accepted startNow.

Root still owns native integration, real isolated model tests, actual original mobile composer/navigation/stop UI, browser and phone acceptance, and public deployment. None of these is established by fixture tests.
