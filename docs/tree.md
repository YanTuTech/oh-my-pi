# Session tree Runtime

Sessions are append-only journals with a movable active leaf. Tree APIs allow a host to inspect history, navigate within a transcript, create a branch, label entries, and optionally summarize the abandoned path. The Runtime contains no tree selector or keyboard navigation.

## Data model

Every non-header entry has an `id` and `parentId`. `SessionManager` maintains indices for entry lookup, parent-to-children adjacency, resolved labels, usage, and the active `leafId`.

- `getBranch(fromId?)` returns the root-to-node path.
- `getTree()` returns a nested `SessionTreeNode[]` projection.
- `getChildren(parentId)` returns direct children.
- `branch(entryId)` moves the leaf without rewriting history.
- `resetLeaf()` moves to a new root.
- `branchWithSummary(...)` moves the leaf and appends a summary entry.
- `appendLabelChange(...)` persists label metadata.

Missing parents and explicit null parents are represented as roots. Children are ordered deterministically by timestamp.

## Navigation

`AgentSession.navigateTree(targetId, options)` validates the target, computes the abandoned path, emits the cancellable before-tree event, optionally generates or accepts a hook-provided summary, moves the leaf, rebuilds model context, resets branch-scoped runtime state, and emits `session_tree`.

Selecting a user or ordinary custom-message entry moves to its parent so the host may resubmit an edited version. The API returns draft text/attachments as data; it does not edit a composer. Other entries become the active leaf directly.

A recoverable historical `ask` result can return a re-answer request. The host collects a replacement answer through its interaction protocol, after which the Runtime appends the new sibling result and resumes from that branch.

## File branching

`AgentSession.branch(...)` and `SessionManager.createBranchedSession(...)` create a new persistent session derived from the selected path. Existing history is not mutated. In-memory storage replaces its active entry set and cannot produce a new file path.

## Context reconstruction

`buildSessionContext()` resolves only the active root-to-leaf path. It applies the latest model/thinking/service/mode state, compaction boundary, branch summaries, custom messages, and reset boundaries on that path. Changing the leaf changes effective model context without rewriting old entries.

## Hooks and host events

Extensions and hooks may invoke `branch` and `navigateTree`. The lifecycle exposes `session_before_tree`, `session_tree`, `session_before_branch`, and `session_branch` with cancellation and summary data.

RPC/ACP hosts project the tree and lifecycle events to applications. Search, filters, labels, selection, and confirmation are host presentation concerns.
