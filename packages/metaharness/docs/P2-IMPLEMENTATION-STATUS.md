# P2 capability-loss notification — implementation and verification

Date: 2026-09-22
Status: implemented and locally verified in the production `createAgentSession` SDK path. The real OpenCode Go candidate run has NOT been executed by this implementation session.

## Preserved baseline and scope

- Baseline: `runs/opencode-go-v41-20260922/challenge-v2-36-20260922-103722-kDyBEYqn/result.json`.
- Baseline result SHA-256: `02d8e35befc3dc22f8c9302a5e8eb448eca0581e626e9e0157d5197ee40ce750` (rechecked unchanged).
- HEAD before and after: `24d101e42515e760b6cc52634c03f14364c35edc` (detached; no commit or branch switch).
- `git diff --name-only -- packages/coding-agent` was empty before this stage. Pre-P2 production files are recoverable from that HEAD; pre-existing metaharness changes and archived runs must not be reset.
- Production naming and collision arbitration are unchanged. The benchmark worker, v2 tasks, fixtures and graders are unchanged. No product bundle was built or promoted.

## Implementation

`packages/coding-agent/src/mcp/capability-notice.ts` computes collisions from original route identities against the final committed registry. It records the unavailable origin and the registered winner, including whether the winning route is enabled. Intermediate pairwise arbitration is not treated as final ownership; alternate registered aliases are not mislabeled as lost capability.

`session/session-tools.ts` retains only route identities, not tool closures or descriptions. Manager refreshes replace their identity snapshot; extension registrations are tracked by owner/name so late losers remain visible and origin changes replace stale entries. Identity snapshots participate in registry mutation rollback. Disposed sessions do not expose a notice.

`src/sdk.ts` projects a bounded current-state notice into each primary request's context before existing conversion/secret-obfuscation stages. This is deliberately NOT a steer, follow-up, or durable transcript message. Each request contains at most one snapshot, unchanged refreshes preserve identical content, and transcript replacement/compaction cannot revive an outdated accumulated notification. A recovery snapshot supersedes prior collision restrictions but does not claim disconnected servers are online or grant permissions.

The static prompt is `src/prompts/system/mcp-capability-state.md`. Original identifiers are JSON-quoted with markup/control escaping. Data is capped at 32 entries / approximately 8 KB, with an explicit omitted-entry count. No external tool description or task answer is promoted into this notice. Formatting hardening is not a claim that arbitrary hostile tool metadata is intrinsically trustworthy.

Hosts constructing a bare `AgentSession` with their own provider transforms can access `getMCPCapabilityNotice()`; automatic provider projection is implemented in the production SDK construction path used by the benchmark. This is not yet a Leapsea product-bundle integration claim.

## Final executed verification

| Check | Result |
|---|---|
| Entire metaharness `bun test` | **100 passed, 0 failed; 518 assertions; 11 files** |
| Six production regression files | **142 passed, 0 failed; 520 assertions** |
| P2 production lifecycle tests (subset of 142) | **9 passed; 43 assertions** |
| metaharness `check:types` | Four configurations, exit 0 |
| coding-agent `check:types` | `tsconfig.runtime.json`, exit 0 |
| metaharness lint | 38 files, no diagnostics |
| P2 production/test lint | 6 files, no diagnostics |
| `bash -n scripts/run-go-v41-p2.sh` | exit 0 |
| `bash scripts/run-go-v41-p2.sh --check` | exit 0; rebuilt candidate, regraded baseline, no provider calls |
| `git diff --check` | exit 0 |

Production regression files: `mcp-capability-notice.test.ts`, `mcp-reconnect.test.ts`, `sdk-tool-activation.test.ts`, `agent-session-tool-rebuild-skip.test.ts`, `sdk-mcp-defer.test.ts`, and `sdk-mcp-instructions.test.ts`.

The new lifecycle tests cover initial collision visibility on the first request, mid-tool refresh visibility on the next request, refresh during final output without an extra turn, repeated/reordered refreshes, restored routes, transcript replacement, failed registration rollback, late losing extension registration and replacement, disabled winners, bounded/escaped identifiers, and final ownership in multi-way collisions.

The frozen-candidate integration test compiles the actual candidate and uses a local HTTP protocol peer. It observes the production notice in the first HTTP request while the public task has no such hint; the victim tools remain absent, and truthful unavailability remains a failed task. This establishes wiring, not real-model quality.

## Frozen identities

- Baseline source: `c048c232645ac63f87f8dbeeac19aeddb1f81b718c6c40d9fe74a0b6146d651b`.
- Candidate source: `e920a7851bb4b0cf7fcfffe180613e93caeca3d4b3a1ea32dc5ff875f111bc87`.
- Driver (unchanged): `13ea2d7a53529bdb69118cd844f3b5e37b5c05658442bf5aaba9323149dce7f0`.
- Dependency-lock identity unchanged.
- File hashes and expected HEAD are pinned in `docs/P2-CANDIDATE.json`.
- Run script SHA-256: `7ce55fb720ca7b64e4974427a12fb691b0fa237ad4216cc151d589524bdf846d`.

## User execution

```bash
bash packages/metaharness/scripts/run-go-v41-p2.sh --candidate
```

Default without an argument is `--check` (no provider calls). `--smoke` schedules two trials, one collision-victim and one search-revision. `--candidate` schedules all 12 v2 tasks three times, 36 new trials. It does not rerun the 36-trial baseline. Go credential comes from the current terminal environment or a hidden interactive prompt, never from credential files and never from chat.

Controls match the recorded baseline: `opencode-go/deepseek-v4.1-flash`, same frozen model profile, 240000 ms trial deadline, 8 model/HTTP request cap, 16 tool executions, 4096 output tokens, temperature 0, the same $1 scheduling threshold and bounded-timeout policy. Unknown usage remains unknown and reserves $0.25 per unmetered trial; neither value is an account billing ceiling.

New directory: `runs/opencode-go-v41-20260922/p2-notice-v2-36-.../`.
Files: `result.json`, `console.log`, `result.dump/`, frozen harness, `p2-candidate-manifest.json`, `review-v2.json`, `review-v2.md`, `p2-comparison.json`, `p2-comparison.md`.

The comparison independently verifies both runs and rejects changed driver, task, evaluator, fixture, model controls, dependencies, platform or scheduling. It reports frozen-grade outcomes and derives target-ID/revision-to-source misroutes from both sets of traces using the same rule, without rewriting old scores.

Development acceptance is intentionally separate from overall retrieval success: no wrong-source victim calls or target-tuple misroutes, truthful collision unavailability, all ordinary search tasks still completed, identical available inventories, full execution and complete usage. A nonzero comparison exit can mean `needs-review` or `incomplete-evidence`, not a script crash; retain the artifacts.

This is a **historical-baseline development comparison**, not an interleaved/randomized A/B or general-capability benchmark. No automatic adoption, commit or product promotion occurs. A 50% retrieval completion rate can persist even when source confusion improves: P2 informs the agent about missing tools; it does not restore them. Collision-safe naming remains a separate candidate.
