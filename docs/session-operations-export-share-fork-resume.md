# Agent Runtime session operations

This document describes the headless session lifecycle and export contracts exposed to SDK, RPC, and ACP hosts.

## Core APIs

| Capability | Runtime API | Persistent effect |
|---|---|---|
| Standalone HTML | `AgentSession.exportToHtml()`, `exportSessionToHtml()`, `exportFromFile()` | Writes an HTML artifact; does not append session entries |
| Text/request dump | `formatSessionAsText()`, `dumpLlmRequestToTmpDir()` | Optional temporary diagnostic file only |
| Encrypted share | `shareSession()` | Uploads an encrypted snapshot; does not mutate the session |
| Fresh provider state | `freshSession()` | Rotates provider state while retaining transcript and identity |
| Reset context | `resetSessionContext()` | Appends a durable `reset_boundary` |
| Fork | `AgentSession.fork()`, `SessionManager.forkFrom()` | Creates a new persistent session derived from the source |
| Resume/open | `SessionManager.open()`, session listing/ranking helpers | Opens an existing transcript |
| Drop/delete | session storage deletion APIs | Removes the selected persisted session and artifacts |

Hosts decide how these operations are exposed. There is no bundled command-line or terminal interaction layer.

## Standalone HTML export

`AgentSession.exportToHtml(options)` exports the active session. `exportFromFile(inputPath, options)` exports an existing JSONL transcript without creating a live agent.

The export contains:

- session header, entries, active leaf, system prompt, and tool descriptions;
- optional recursively collected subagent transcripts;
- the embedded `<omp-tool-view>` renderer generated from `packages/collab-web/src/tool-render/`;
- self-contained scripts and styles;
- fixed light, dark, or automatic web themes.

The terminal palette and theme registry are not inputs to the export. Set `includeSubSessions: false` to omit child transcripts. Export never appends an entry to the source session.

## Text and request dumps

`formatSessionAsText()` serializes the current model-facing state, including system prompt, tool definitions, messages, thinking, calls, and results. `dumpLlmRequestToTmpDir()` writes a best-effort JSON diagnostic containing the model request.

Diagnostic dumps can contain raw context or secrets. A host should treat their paths and contents as sensitive and remove them when no longer needed.

## Encrypted share

`shareSession()` builds a snapshot, optionally redacts recognized secrets, gzips it, and seals it with AES-256-GCM. The decryption key is carried in the URL fragment and is not sent with the upload request.

The default blob store enforces its upload budget by trimming inline images, then long strings, then old entries. A configured gist store uses the same encrypted payload. Share creation does not require a persistent session because the snapshot can be built from live entries.

The repository no longer contains a browser guest/share UI. A host or external viewer may consume the retained share/export protocol independently.

## Fresh provider state

`AgentSession.freshSession()` closes cached provider-session handles, rotates the provider session id, rekeys memory integration, and invalidates append-only context. It keeps the local transcript, session id, header, and persisted file. The operation is rejected while streaming.

## Reset context

`AgentSession.resetSessionContext()` clears live/model conversation state, queued turns, pending tool calls, continuation state, and runtime jobs while retaining session identity and metadata. It rotates provider state and appends a durable `reset_boundary`, allowing storage and full exports to retain pre-reset history.

## Forking

`AgentSession.fork()` flushes writes, emits cancellable before-switch and post-switch lifecycle events, delegates to `SessionManager.fork()`, copies artifacts best-effort, and switches the live session identity.

A persistent fork receives a new id and timestamp, keeps the source cwd and entries, records `parentSession`, and inherits the provider prompt-cache key. In-memory session managers cannot create a persistent fork and return failure without mutating the source.

`SessionManager.forkFrom()` supports host-driven forking from another transcript into a selected cwd/session directory.

## Opening and ranking sessions

Session listing, filtering, ranking, and path/id resolution are headless APIs under `src/session/`. Hosts own selection and confirmation UX. Missing or relocated working directories are represented as data/errors for the host to resolve; the Runtime does not open a picker.

## Concurrency and lifecycle

Mutating operations reject or coordinate with active streaming, compaction, and foreground jobs according to `AgentSession` lifecycle guards. Hosts must subscribe to Runtime events and project completion, cancellation, and error states into their own UI or orchestration layer.
