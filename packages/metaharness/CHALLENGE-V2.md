# MCP challenge v2

## Scope and current status

`mcp-challenge-v2` adds a versioned development task set and a stricter result/evidence grader to the existing MCP agent runner. It does not change production MCP tool names, implement capability-loss notifications, promote a runtime bundle, or run a paid model automatically. The old `agent-cases.ts`, old fixture server, old baseline script, and archived v1 results are unchanged.

The 12 tasks are **four scenario families, each with three fixed samples** (seeds 17, 29, 43), not 12 independent capability categories and not a held-out benchmark. These seeds fix IDs, publication years, revisions, source snapshots and checksums. No clock or process-random seed participates in the world. Development sample answers must not be interpreted as evidence of broad generalization.

| Family | Count | Contract |
|---|---:|---|
| `collision-victim-*` | 3 | Retrieve the source currently lost by punctuation-colliding tool names; never substitute the retained source. |
| `collision-both-*` | 3 | Retrieve both original source identities. Independent reads may be parallel. |
| `search-revision-*` | 3 | Search a multi-record index, select the latest matching revision for the requested year, then read that returned ID/revision. |
| `search-secondary-*` | 3 | Perform the same dependency using the explicitly requested secondary source, not another library containing the same ID. |

The pre-v2 naming implementation is expected to make the requested victim source unavailable. That limitation remains visible; v2 is not a naming fix. Actual model behavior on the new tasks still requires an explicit real run.

## Grading

The evaluator checks exact final JSON, original server/tool identity, actual tool arguments, actual returned ID/revision/source/snapshot, and successful target reads. Search returns record previews but no checksum. Its query selects records instead of returning the same record for every non-empty string.

For dependent reads, the driver records both tool start/completion sequence numbers and the **logical model response that chose the call**. A read must be chosen in a later response after a successful search returned the same ID and revision from the same source and snapshot. This rejects not only reversed or overlapping calls, but also guessing both operations in one model response even if the tool executor later serializes them. Array order and equal-millisecond timestamps are not treated as causal proof.

Additional searches and evidence-based verification reads are permitted. Independent dual-source reads need not follow a fixed total order. Missing lifecycle evidence is not synthesized for v2. Historical v1 outputs without these fields remain parseable and use the unchanged v1 grader.

Behavior outcomes are separate:

- `completed`: correct result supported by valid retrieval evidence; counts as task success.
- `honest-unavailable`: accurately lists missing required source capabilities; **does not count as task success**.
- `wrong-source`: actually calls an unauthorized substitute source, even if the final answer is corrected later.
- `unsupported-answer`: the final JSON matches but the necessary valid evidence is absent.
- `incorrect-result`: other final-result failures, including false unavailability claims.
- `execution-error`: incomplete execution or metering/cleanup failure.

These counts are stored under `summary.outcomes`, while each trial retains its full grade and reasons. Honest unavailability remains a task failure and never becomes a successful retrieval. `status=complete` means all scheduled trials finished without execution errors; it does not mean every task passed. Existing bounded-timeout scheduling and nonzero process exits for execution errors remain in force.

## Version and evidence boundaries

CLI defaults remain `mcp-smoke-v1`. Opt in with `--suite mcp-challenge-v2`. Selecting a v2 task ID without the v2 suite is an error; mixed v1/v2 programmatic runs are rejected. REST accepts `mcp.suite`; conflicting dataset labels are rejected, and the suite is persisted in the run's evaluation evidence and dataset label.

The result records `evaluation.suite`, taskset, fixture, evaluator, model-control and scheduling digests. Task definitions and goals are evaluator-owned. Worker inputs project only the public task prompt, model controls and explicit fixture source/seed routing; no `expected`, target records or required-route labels are sent. New fixture code/data are compiled into the external fixture process, not imported by the agent worker. This is isolation for reviewed local candidates, not an OS security sandbox against malicious source.

The fixture and grader remain fixed between baseline and candidate. A future candidate must modify the actual runtime behavior, not the grading criteria. The v1 18/18 score is a different task set and cannot be compared numerically to v2's score as an improvement/regression percentage.

## Run locally

No model or credential is needed for inspection:

```bash
cd packages/metaharness
bun adapters/mcp/cli.ts --mode agent --suite mcp-challenge-v2 --list
bash scripts/run-go-v41-challenge.sh --check
```

An explicit one-task live check:

```bash
bash scripts/run-go-v41-challenge.sh --smoke
```

An explicit 12-task × 3-repeat live baseline (36 trials, not an A/B run):

```bash
bash scripts/run-go-v41-challenge.sh --baseline
```

The script uses the existing frozen `opencode-go/deepseek-v4.1-flash` profile, asserts the established baseline runtime source digest, and creates a fresh `challenge-v2-*` run directory. It uses only the existing `OPENCODE_API_KEY` environment variable or a hidden interactive entry; it never reads credential files. No paid requests are made by `--check` (also the default with no argument).

Resource settings remain 240 seconds per trial, 8 actual HTTP attempts and logical requests at most per trial, 16 tool executions, 4096 output tokens per request, temperature 0, and a $1 scheduling budget. Timeout continuation stops at four total or two consecutive model timeouts, reserving $0.25 per unmetered trial. Reserve amounts and catalog cost estimates are not account billing ceilings or quota receipts. Failed tasks are retained; no task-level retry-until-pass is performed.

The script writes `console.log` and native `result.json`/`result.dump` artifacts and then runs `scripts/review-mcp-challenge.ts`. The reviewer checks the matching evaluator/fixture identities, runtime hashes, control/scheduling/task digests, entrypoint, trial dumps, regrading, outcome counts and accounting. It saves `review-v2.json` and `review-v2.md` without changing the original result. If the evaluator or fixture has since changed, it refuses to silently regrade with a different version.

No collision-name candidate or A/B script is included in this stage. Implement that candidate separately and compare it against a v2 baseline under identical model, task, fixture, grader and budget controls.

## Verification and preservation

```bash
export PATH="$PWD/../../node_modules/.bin:$PATH"
bun run check:types
bun test
bun --bun ../../node_modules/.bin/biome lint src test adapters/mcp scripts/review-mcp-challenge.ts
bash -n scripts/run-go-v41-challenge.sh
bash scripts/run-go-v41-challenge.sh --check
```

New deterministic tests cover reversed, overlapping and same-response preplanned reads; wrong IDs/revisions/snapshots/sources; fabricated or missing evidence; legitimate extra verification; honest unavailability; independent dual-source reads; fixture query discrimination; answer-key isolation; and suite/dataset selection. CLI and REST tests execute real frozen OMP workers and stdio fixtures against a loopback model-protocol peer. That peer is a test double, not a real model-quality run.

`docs/v2-preimages.json` records reversible edits against the existing dirty working tree. A read-only reconstruction of the 29 pre-v2 source/config/test files matches the digest measured before changes (`516b88c248e95b72b335d322010584cf93b1174611637b3c8d3ec2a545c79970`, gzip JSON, 86347 bytes). This is a reversible change journal, not a standalone full repository archive. No commit, branch switch or rollback is performed automatically.
