# Session listing, ranking, and switching

The Agent Runtime exposes headless APIs for discovering, ranking, opening, moving, and switching sessions. Host applications own picker, confirmation, and navigation UI.

## Implementation

- `src/session/session-listing.ts`
- `src/session/session-ranking.ts`
- `src/session/session-loader.ts`
- `src/session/session-manager.ts`
- `src/session/agent-session.ts`
- `src/session/indexed-session-storage.ts`
- `src/session/sql-session-storage.ts`
- `src/session/redis-session-storage.ts`

## Listing

Storage adapters enumerate session headers and lightweight metadata without hydrating full transcripts. Results include the session id/path, cwd, timestamps, title/summary where present, model/provider metadata, and storage identity.

Callers may scope listing to a project/cwd or request global candidates. The Runtime does not assume that a global result should be opened automatically.

## Ranking and resolution

Ranking helpers normalize ids and paths, support exact and unambiguous prefix matches, and order recent candidates deterministically. A host should display ambiguity rather than picking an arbitrary match.

Path-like selectors resolve as files. Id-like selectors are matched against indexed metadata. Foreign importers are separate adapters and must not silently outrank native sessions.

## Switching

`AgentSession.switchSession(...)` coordinates the live transition:

1. reject or coordinate with active streaming/compaction according to lifecycle guards;
2. emit the cancellable before-switch event;
3. flush pending writes;
4. open and validate the target session;
5. replace the live session/model state;
6. refresh session-bound memory, tools, and provider state;
7. emit the switch event and notify subscribers.

If switching fails, the original session remains authoritative.

## Missing working directories

A stored cwd may no longer exist. The Runtime reports this condition and exposes re-root/move operations; the host decides whether to ask the user, choose a replacement cwd, or cancel. Non-interactive hosts must fail explicitly when policy does not provide an answer.

## In-memory sessions

In-memory session managers can participate in live state replacement but have no persistent file to list, move, or fork. APIs return an explicit unsupported/failure result instead of synthesizing persistence.

## Host contract

RPC and ACP expose session metadata and lifecycle events so an embedding can implement recent lists or navigation. No terminal picker, alternate-screen renderer, keyboard binding, or command-line resume path is bundled.
