# Original ZCode RPC → Codex read services

This stage exports `createReadServices({api})`. `api` must provide the existing
server-side, GET-only `api.get(path)` interface. No token, local pairing URL,
credentials, or mutation transport is returned to the browser. This directory
does not replace the existing mobile service, modify the installed apps, start a
host, change project records, attach/resume tasks, or send prompts.

## Original contracts inspected

- Original host `out/host/index.js`, `createLegacySingleRootProjectService`
  (`Ow`, about offset 32300): `project.readTree` returns `{projects,tasks}`;
  project roots are `{rootPath,position,isPrimary}`. Task records include
  `taskId`, `workspacePath`, optional `workspaceIdentity`, `hostId`, `projectId`.
- Original task facade `createZCodeTaskServiceAdapter`, `snapshotToMeta`
  (`Ro`, about offset 573249) and `snapshotToZCode` (`dt`, saved adapter excerpt):
  snapshots use `{meta,messages,configOptions,slashCommands,runtime,history}`.
  Assistant messages use `{content,thought,tools,parts}`; tool-call parts point
  to `tools` by index. Renderer message IDs remain the actual Codex item IDs.
- Original task index `chunk-G6XJUBQB.js`, `queryTaskList` (about offset 137955):
  query parameters are `{kind,workspaceScopes,sortBy,search,limit?}`. Active
  results exclude pinned tasks; `limit` absent means expanded results; an empty
  scope array must return an empty list.
- Original H5 `Pvt`, about offset 1979537: `task-groups.read` returns
  `{groups,members,order}`; membership uses `{workspaceKey,taskId,groupId}`.
- Original H5 `Cct`, about offset 1701417: snapshot ETag responses use
  `{snapshot,etag,notModified?}`.

## Methods supplied

| RPC channel | Read methods |
| --- | --- |
| `project` | `readTree`, `readProjects`, `resolveSessionDirectories` |
| `remote-projects` | `readDirectory` (empty local-only directory) |
| `task-groups` | `read` (current mobile groups mapped to original shape) |
| `zcode-task` | `initialize`, `checkCodexConnectivity`, `listTasks`, `listPinnedTasks`, `listPinnedTaskIds`, `listActiveTaskIds`, `listArchivedTasks`, `listDeletedTaskIds`, `listTaskList`, `getTaskMeta`, `getTaskSnapshot`, `getTaskSnapshotWithEtag`, `getTaskModelSelection` |

`getTaskSnapshotBody`, `getTaskSnapshotRef`, `getTaskSnapshotToolCallsSlice`
return `null`, matching the current original facade's unsupported body-slice
behavior. `getTaskConfigOptions`, `configOptions`, and `slashCommands` currently
return empty arrays; the returned runtime explicitly marks these capabilities
unsupported in this read adapter. They do not mean native Codex has no settings
or commands. Mutation and event methods not supplied here throw
`CODEX_READ_ONLY_METHOD_UNAVAILABLE` rather than claiming success. Root owns the
event/interaction adapter and frontend capability controls.

## Data and scope behavior

- Project and task metadata come from real `/api/projects`, paginated
  `/api/threads`, and `/api/organize`. Actual UUIDs and workspace paths are
  retained. Primary project roots are the first actual registered root.
- Tree records have host `local`, original agent-renderer tag `provider:'glm'`,
  and explicit `executionBackend:'codex-app'`. This compatibility tag is required
  by original H5 `validation-B6yV_dPD.js` export `lr`: `gd(e){return e==='glm'}`.
  The original host likewise imports `Br='glm'` and normalizes its legacy agent
  enum (`claude/opencode/gemini/codex/glm`) to this tag. It does not call a GLM
  model or use a ZCode cloud account. Actual model selection uses the distinct
  `providerId:'codex-app'`, matching root's real model view.
- `notLoaded` and `idle` describe engine state. Neither becomes `completed`.
  List metadata keeps `codexConnectionStatus` and omits unknown task status;
  a completed last turn is actual completion evidence when reading a snapshot.
- Task lists enforce exact requested `workspaceScopes`, keep active/pinned/
  archived lists separate, sort, search titles, and paginate. No path-prefix
  expansion or fallback to an unrelated directory occurs.
- Snapshot reading validates UUID and exact history ID. A supplied workspace
  must match actual thread cwd, including all older pages. History is fetched
  newest first and projected back into chronological message order. It reads
  enough pages for `messageLimit`, with bounded server reads.
- When unrequested older pages remain, `history.truncatedBefore` is true and
  `totalMessagesKnown:false`; it does not invent an all-history total. Exact
  `totalMessages` is supplied only when the beginning has been read.
- ETag hashes the actual projected snapshot, and `ifNoneMatch` is honored.
- The existing Mac service already filters system context and bounds some
  command/diff output; this adapter preserves those evidence limits. It does
  not claim full native raw tool logs. Media currently has a textual attachment
  placeholder; native image delivery remains a separate adaptation task.

Unknown permissions, background jobs, queue state, retry state, and context
usage are omitted from original runtime fields. Actual available Codex values
are separately named `codexTokenUsage`, `codexPlan`, `codexPendingApprovalCount`,
and `codexActiveTurnId`; these are not an original ZCode interaction model.

## Verification

`node --test work/zcode-codex-adapter-20261025/read-services/test/*.test.mjs`
passes 17 tests: real original object shapes, cursor traversal and duplicate
metadata, multi-workspace active/pinned separation, empty scope behavior,
truncation/loop failures, cross-host/path rejection, chronological tool/message
projection, ETag, partial-history totals, real group membership, denied writes,
and unknown engine-state semantics.

## Original controller startup and read events

`wrapReadControllers(channels,{api})` returns `{channels,refresh,dispose,
capabilities}`. It adds the exact original startup contracts:

- `window-controller.subscribeControllerV4`, `resyncControllerV4`,
  `unsubscribeControllerV4`, and `onDynamicControllerFrame`;
- `window-controller.listTaskList` with `active` including pinned tasks,
  `timeline` excluding them, and explicit scope filtering;
- `window-controller.getTaskMeta({address})`;
- `task-groups.admit({tasks})`, which validates actual existing catalog records
  and returns `alreadyKnownTaskIds`, empty `admittedTaskIds`, `groupsCreated:0`.
  It writes no task/group records and rejects unknown or cross-host tasks.

The V4 frame projection is the **exact original** host implementation
`pre/createWindowHostControllerProjection` and its pure helpers, extracted as
`original-controller-source.txt`, with hash/offset evidence in
`original-controller-manifest.json`. Its subscribe ACKs, epochs, snapshots,
deltas and resync implementation run in a pure VM. This stage does not rewrite
the frame protocol. Source rows use actual metadata and no invented live-session
overlays. Original fallback `liveStatus:'idle'` when no overlay is present is a
renderer default, not evidence that a detached Codex task completed.

`wrapReadEvents(channels,{api})` returns `{channels,dispose,pollNow,changes,
status,capabilities}`. Apply it after controller/support channels are assembled.
Root can subscribe `events.changes(() => controller.refresh())` and dispose the
registration at shutdown. It uses the original `Emitter`, registers the original
dynamic task/workspace/stream/terminal/ready events immediately, and reads actual
`GET /api/events?since=...` JSON pages. It does not use SSE or enable the old
backend's 20-second wait (which races the current 20-second API timeout).

Only fresh native events become `task_snapshot_updated` /
`workspace_task_list_changed` invalidations; the actual history is read again.
Raw deltas and raw JSON are not delivered to the legacy renderer. The initial
page anchors the source sequence, so historical completions cannot become new
terminal outcomes. Fresh completed/failed turns map to corresponding outcomes;
interruption is not invented as success. Source reset invalidates loaded views
without inventing a new model result. Unsupported ready semantics are declared
as `taskReady:false`; their subscription still registers and disposes correctly.
Metadata-only scope lookups use actual `/api/threads?ids=...` and never attach,
resume, or fetch business histories merely to locate event workspace paths.

Three controller tests and four event tests cover original ACK/frame/resync,
read-only admission, scope behavior, immediate subscriptions, baseline and
duplicate filtering, coalesced invalidations, real outcomes and source reset.

`live-read-receipt.json` records a GET-only verification against the existing
Mac backend: 6 projects, 248 real task records, and an already archived isolated
test conversation with two messages and the expected red/blue answer. It stores
only counts and that test ID, no bearer or message body. This is a backend
contract check, not a claim that the original phone UI, workspace switching,
all history formats, or sending has passed browser acceptance.
