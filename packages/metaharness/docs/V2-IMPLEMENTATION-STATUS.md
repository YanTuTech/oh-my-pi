# MCP challenge v2 implementation status

Date: 2026-09-22
Repository HEAD remains `24d101e42515e760b6cc52634c03f14364c35edc` (detached). No commit, branch switch, production naming change, runtime-bundle promotion or real provider request was performed in this stage.

## Delivered

- Versioned `mcp-challenge-v2`: four scenario families × three fixed samples = 12 development tasks.
- Collision-victim and dual-source tasks, plus multi-record search/revision/source-dependency tasks.
- Exact result and original-route grading, fixture response validation, and causal tool evidence (start/completion order plus choosing model-response index).
- Separate `completed`, `honest-unavailable`, `wrong-source`, `unsupported-answer`, `incorrect-result`, and `execution-error` outcomes. Only grounded completion counts as task success.
- Explicit CLI `--suite` and REST `mcp.suite`; dataset-only v2 labels without explicit suite selection are rejected instead of running v1 under a v2 name.
- Frozen fixture/evaluator/task/control/scheduling identities and independent result verification.
- Local user-run script and review artifacts, without reading credential files or silently starting paid runs.
- Unchanged v1 task definitions, v1 grader, v1 fixture, v1 baseline script and previously recorded results.

## Final executed checks

| Check | Result |
|---|---|
| `bun run check:types` | Four configurations, exit 0 |
| `bun test` | **98 passed, 0 failed; 496 assertions; 9 files** |
| Biome lint, `src test adapters/mcp scripts/review-mcp-challenge.ts` | **34 files, no diagnostics** |
| `bash -n scripts/run-go-v41-challenge.sh` | Exit 0 |
| `bash scripts/run-go-v41-challenge.sh --check` | Exit 0; 12 tasks, exact Go V4.1 identity |
| `git diff --check` | Exit 0 |

The added 18 tests comprise 16 deterministic fixture/grader/selection checks and two real local process integration tests. The integration tests compile frozen OMP workers and start actual stdio fixture processes against a loopback model-protocol peer. They do not establish real model task performance.

The CLI integration run proves a search result drives the subsequent exact-ID/revision read and final answer. Its collision-victim trial reports honest unavailability, preserves that as a failed task, and does not prevent the other scheduled trial from running. Saved results independently regrade; tampered outcome counts and changed evaluator identity are rejected. The REST integration test verifies the v2 dataset/evaluation identity and failed-but-honest grade survive persistence and are not presented as v1 success.

The unchanged v1 taskset digest is asserted in a regression test:
`5bccde61776c0d09b4f2da0716d389fce8538712b1e95a0132af245c88329529`.

Final v2 evaluator digest:
`03c3222a3c65080c997cc5aa9b17eae556580603af709ea53e1c6eab3df809bf`

Final v2 fixture digest:
`ebbc5a379168fea98cafe85f61e52d3ee3d6a1c9a4c7bc7842b4d1a6a08e9a8e`

## User execution

From any directory on the current machine:

```bash
bash packages/metaharness/scripts/run-go-v41-challenge.sh --baseline
```

This explicitly schedules 36 v2 baseline trials. It is not a two-version A/B (which would be 72 trials at the same repetition count). Without an argument the script performs only `--check`. `--smoke` runs one search task. No real v2 baseline has been run by this implementation session.

The current production tool collision still loses the secondary route. V2 is designed to expose it; a correct unavailability report is not a completed retrieval. Do not require 36/36 success or rerun until it appears.

See `CHALLENGE-V2.md` for exact settings, outcomes, artifact locations, preservation journal, and remaining scope. Production collision-safe naming and its candidate A/B remain a separate subsequent stage.
