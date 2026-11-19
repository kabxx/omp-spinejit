# OMP host contract

`src/` contains the OMP adapter. The published Spine SDK provides the shared WASM, controller, Spawn support, and tree rendering.

## Package boundary

The standalone `@kabxx/omp-spinejit` package builds `src/` into `dist/omp/`
against official OMP 19.0.0. It carries `omp.extensions`, its canonical
`spine.toml`, and `LICENSE`. Its only production dependency is the published
`@spinejit/spine-sdk@0.1.4`, which includes WASM and the SDK host APIs. The
`upstream/spine-plugin` submodule is not a build input and does not ship.
OMP supplies its native host, AI, and schema modules. Native SDK npm packages
are development-only declarations/test dependencies, not peer or production
dependencies. User sessions load the adapter from the installed manifest,
without an explicit `--extension`.

JIT policy and discoverable device descriptions enter the same explicit Core
configuration. Required Spawn mode slots defer native task delegation policy
to OMP rather than imposing Pi modes.
The official `@oh-my-pi/*` module names and `ExtensionAPI.pi` remain native OMP
SDK interfaces, not imports of the Pi adapter.

## Native ownership

Use public `AgentRegistry` → live `AgentSession.extensionRunner` →
`getLoadedExtensions()` / `isExtensionActive()` and registered callback identity.
Reject another active extension registering `context` or
`session_before_compact`, and reject duplicate Spine activations. Do not query
Pi's compaction-owner event or invent an OMP ownership event.

Install the public pre-model admission gate before initialization; native event
dispatch catches handler errors, so a failing `session_start` alone is not a
fence. Recheck ownership on model admission and compaction, and detach the gate
on shutdown/reinitialization. Bind the actual `SessionManager` object:
`AgentSession.sessionId` is a provider ID that rotates on `/clear`, whereas the
journal manager and its ID remain unchanged.

Foreign observers using either exclusive hook are also rejected because native
metadata cannot distinguish observation from replacement. A trusted bridge may
compose observers in the same owning extension, but must not mutate/replace
context or return another compaction result.

## Events

| OMP event | Adapter rule |
|---|---|
| `session_start` / `session_switch` / `session_branch` / `session_tree` | Reinitialize the active native identity/branch, generation, runtime, source bindings, and fault gate. Native switch/branch events do not imply `session_start`. Do not sample. |
| `context` | Drain native synchronous message-persistence callbacks, then admit raw branch sources and queued non-assistant main messages. Users and durable custom/developer notices can exist only in `event.messages` before persistence. Assistant display/partial/refusal messages are not extra sources. Native ephemeral snapshots end with an unpersisted agent-attributed user after an unpersisted agent-attributed developer delimiter: project them without admitting detached sources, preserving the full side suffix. Preview only. |
| `turn_start` | Arm main-turn sampling admission after native context preparation and the pre-model admission gate. Do not start a sampling here. |
| `before_provider_request` | One OMP main assistant/tool turn → one Spine sampling. Ignore hooks outside an armed main turn. Capture the committed child prefix before `sampling_started`; repeated requests reuse the open sampling. Serialize entered admissions so a suspended side hook cannot reopen a finished sampling. |
| `message_end` | Reconcile `user`/`assistant` from the raw native branch prefix after the persistence queue barrier, retaining preceding queued notices in canonical order. Use native identity fields, not display text. A queued user absent from the journal still uses the in-flight context path. Classifier refusal/sensitive assistants excluded by native persistence are not sources. `toolResult` is host transcript (splice), not a WASM source during sampling. |
| `tool_call` / `tool_result` | Decode `write xd://spine_*` to the Spine tool name **before** lifecycle admission. Durability faults return `{ block }` for every Spine tool, including `spine_spawn`. Do not `ctx.abort()` a later host tool because publish failed. |
| `turn_end` | Clear main-turn admission synchronously, drain entered provider admissions and native persistence, reconcile the raw assistant prefix **and every already-durable following host source**, then `finishTurn`. Launch Spawn children only after their births commit; obsolete generations cannot publish arrivals. Do not `ctx.abort()` on a normal close. Only an assistant `stopReason === "aborted"` marks interruption; native OMP context has no `signal`. Publish may still fail after `install_prepared`; keep the tree, do not tell OMP the user interrupted. |
| `before_agent_start` | Extend native `ctx.getSystemPrompt()` (`string[]`) with the canonical Spine operating instructions automatically. In-flight messages arrive through native `context`, not an invented `before_agent_start.messages` field. OMP has neither `context_with_system` nor `systemPromptOptions.appendSystemPrompt`. |

## Tools

OMP `tools.xdev` mounts discoverable tools as devices:

- Model **reads** `xd://spine_open` (docs + schema).
- Model **writes** JSON to `xd://spine_open` (execute).
- Host-facing `toolName` is `write`. Real name is `details.xdev.tool` / `path` `xd://<name>`.
- `spine_open` / `close` / `next` / `spawn` stay `loadMode: discoverable`. Do not re-register them as essential top-level tools.

`registerToolCall` / mix checks / `stageSpawn` must see `spine_*`, never `write`. Nested xdev dispatch reuses the same `toolCallId`; a second register is identity, not a fault.
WASM `preview` after `stage_execution` is still the pre-commit tree. `execute()` must describe the post-`install_prepared` cursor, not that preview.
Only one successful Open/Close/Next is allowed per sampling. A second pending or successful control is a recoverable admission denial, not a durability fault. A failed execution releases its admission slot. Nested dispatch with the same tool ID is still identity.

The tree widget is the user-facing state confirmation for ordinary controls.
Open/Close/Next return their full cursor receipt to the model and journal, but
their successful TUI result component is empty, including Ctrl+O expansion.
Executed errors remain rendered; recoverable control admission denials use
native TUI warning notifications because a hook-blocked call never enters the
mounted result renderer. Spawn acknowledges staged children in the execution
reply; terminal outcomes are later arrivals, not inline results of that call.


## Context projection

WASM `contextPlan` is the compiled tree. It may omit the in-flight tool loop of the current node.

Use native `@oh-my-pi/pi-coding-agent.buildSessionContext` for the model-visible branch, keeping source-entry provenance for materialization and compact tails. Map raw session entries with native compaction/custom-message constructors. Native compaction/reset/retry filtering and `shake("elide" | "thinking" | "images")` transcript surgery remain owned by OMP. Do not simulate a generic `context_edit` API or resurrect native trimmed text/reasoning through transcript splicing.

After `materializeMessages`, restore the edited host transcript after the last user as one ordered assistant/tool-result sequence. Never append an earlier result after a later assistant call, re-add an omitted persisted message from `event.messages`, or substitute raw branch contents for a rewrite.
Retained assistant calls from earlier user turns also need their real matching replies. Message identity must preserve timestamps, content, tool-call IDs, custom types, and repeated source occurrences.

`buildOmpReplayPlan.extraMessages` contains only genuinely additional Source
occurrences, never an overlapping native context transcript. The context
consumer subtracts persisted/rendered occurrences by count, not set membership;
two identical notices remain two sources. A durable post-assistant suffix is
already additional and must not be deduplicated against older branch sources.
For custom notices, the live wall clock and native persistence wall clock can
differ. Reconcile the full notification payload by occurrence count, while
keeping the durable timestamp for checkpoint identity. This rule is native
producer behavior, not a host-version switch. Suffix splicing subtracts only
the latest matching occurrences; it must not remove identical earlier
conversation notices.

Preserve state-derived messages emitted by `buildSessionContext` even when
they have no conversation source-entry provenance. Insert these messages
relative to retained native predecessors, rather than attaching global state
to a Source cell that the tree may summarize. Native metadata is not an
invented durable Source.

OMP can append `sampling_started` or `sampling_commit` before persisting a queued user message already admitted as a source. Replay buffers archives in durable order until their exact pre/post source tail is available, including sources persisted after the commit. Conversely, a host notice can be persisted before a sampling archive that did not admit it: same-epoch canonical checkpoint/native identities authorize delaying only that host source until after the excluded archive. Preserve native user/assistant order and host-source occurrence counts. Do not rewrite the journal, invent messages or relax exact-tail validation; missing identities, invalid Spawn staging and unresolved compact-boundary dependencies remain errors.

Current durable records use `spine-plugin/omp/v3`. Projection classification
uses `spine.omp.projection/v1`; it is a separate schema. SDK v2 histories and Pi
envelopes fail closed without rewriting the original journal. Start a fresh
session rather than attempting to replay a rejected history.

Title forks and `/btw` use native `runEphemeralTurn`: their context and provider
hooks still run, but their partial assistant, developer reminder, detached
history, and agent-attributed prompt never become main Spine sources or
independent samplings. Durable agent-attributed messages remain main sources.
Keep durable replay validation strict. A journal that references missing or
transient side sources cannot be repaired by inventing those sources or ignoring
its archive; preserve it and start a new session.

Native `AgentSession` rebuilds `customType: "eval-state-context"` from the current eval registry after resume. Keep this runtime notice model-visible, even when it precedes an unpersisted user message; it is not a durable Spine source or an archived boundary. Native `experimental_context_notes` is likewise branch state: project the current native builder's injection, not stale copies in `event.messages`, so replacing or clearing the notebook takes effect immediately and survives restart. Other genuine custom conversation messages remain ordinary sources.

Canonical Source uses raw durable assistant bytes, including secret placeholders,
not the native deobfuscated display event. Native assistants with
`stopReason: "error"` and `stopDetails.type: "refusal"` or `"sensitive"` are
not persisted and must not enter Source; ordinary persisted error/aborted
responses remain sources. Event observation uses the prefix through its initiating
user/assistant message. At `turn_end`, also admit all following durable host
messages before finalization. Hidden idle custom resources, todo/rule
developer notices and deferred execution notifications need complete branch
synchronization because their native producer need not emit `message_end`.
`isOmpSourceMessage` is the shared live/replay admission policy; exclude runtime
`eval-state-context`, branch-derived `experimental_context_notes`, system
sections and tool-result transcript, not genuine host conversation sources.

Before each sampling archive, persist only new canonical Source characters and
stable native producer identities in `spine.source.v1`. Preserve the checkpoint
lineage across fork/child namespace continuation; inherited cell origins need
not equal the current namespace. Native `shake` can rewrite raw user/assistant
bytes on disk, so replay uses checkpoint characters while model materialization
uses the current native view. A checkpoint never supplies a missing message or
borrows a different user at the same ordinal. Valid older sessions receive a
baseline on initialization; bytes already lost before that baseline cannot be
reconstructed.

`resetSessionContext()` (`/clear`) keeps native session identity/transcript and
appends `reset_boundary`, without a session start/switch event. Before further
Source admission or model context, detect the latest boundary and rebuild a
fresh Root in `<native-session-id>-reset-<boundary-id>`. Replay starts after the
latest boundary; original entries stay on disk, and post-reset validation stays
strict.

For a native user rewind/branch cut, move the active leaf past consecutive
trailing uncommitted `sampling_started` entries and their matching Source
checkpoint only when its captured native source was cut. Keep checkpoints for
sources still present. Use native `branch`/`resetLeaf`; do not delete journal
entries, discard committed records or borrow new prompt text for missing sources.
Discard results and failures from obsolete generations; they must not publish,
append entries or fault the newly selected session.

## Compaction

The native acknowledgement must carry OMP's `fromExtension: true`.
Pi's `fromHook` marker is not an OMP acknowledgement.

Use native `@oh-my-pi/pi-ai.completeSimple`, with `modelRegistry.getApiKeyAndHeaders()` authentication. OMP's model registry has no `complete()` method. The AI client is loaded lazily from the host's injected native module. Bun-based regression tests use the native declarations and inject the completion callback.

The summarizer receives the same materialized JIT nodes, memories, and paired host tool transcript as the live model, converted through native `convertToLlm`. Tool declarations come from `getAllTools()` filtered by `getActiveTools()`, not imaginary branch tool-change entries. Keep native parameter schemas intact, including callable ArkType schemas.

The adapter reads the native Auto-Compact preference without changing it and
vetoes native automatic compaction at its start notification. Spine waits for
the whole sampling commit, publication and observer settlement, then schedules
from the projected prompt budget.
Only the exact locally appended commit/checkpoint IDs may extend the native
preparation snapshot during that wait. Freeze the refreshed branch for summary
and retained-message selection; any later foreign entry/source change cancels
before the barrier. A real automatic compaction must not silently cancel merely
because this adapter's own sampling commit finished landing.

New compactions atomically journal the Spine barrier in the native compaction
entry. Its `preparedLeafId` must equal that entry's parent. Apply only receipts
on the active branch, once per journal ID, including across initialization. Do
not regenerate a summary or repeat a committed compact during replay.

The asynchronous summary hook can defer slow completions. The final synchronous
hook rejects stale jobs by checking the job, model and branch leaf again, and
vetoes native fallback when no result is ready.



## Child spawn

- The parent stages Spawn during tool execution and commits births as part of the main sampling. Start subprocesses only after commit. Use that sampling's captured parent prefix and current user constraints, not a prefix cached from the first turn.
- Run the same OMP host with `--mode json -p --no-extensions --resume <child.jsonl> --extension <installed OMP extension> --spine-child=true`. Parent discovery uses the manifest; the child explicitly loads exactly that installed adapter and not a workspace bridge or second copy.
- Accept a nonempty ordinary assistant final reply only from the child's active journal, covered by a successful Spine sampling commit and with no unjoined local children. Neither provider text from stdout nor a reply that reached disk before commit is terminal evidence. A live invocation must exit normally without cancellation and must advance beyond its previous journal tail.
- Persist one `spine-arrival` per producer on the current parent branch before requesting any continuation. Project the arrival from that durable entry at its Source position. `spine-arrival-wake` can trigger a native turn, but it is not the outcome and never becomes Source.
- Child journals isolate the parent session, birth, and attempt. Continue validates the current child's active ancestry and identity, including journals with a native title slot. Retry uses a fresh attempt. Recovery respects already committed arrivals without rerunning those peers.
- Cancellation before process launch must not invoke the host. A cancelled process or abnormal exit cannot report completed memory solely because a reply exists. Keep diagnostics bounded and retain successful peer arrivals.

## Non-goals

Do not import `src/pi`. Do not assume one `before_provider_request` equals one sampling. Do not assume Pi `--session` or Pi `message_end.toolCall.name`.
