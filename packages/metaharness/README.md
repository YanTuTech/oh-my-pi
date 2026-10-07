# @oh-my-pi/pi-metaharness

One headless manager for repository benchmarks. Harbor, TypeScript edit, SnapCompact,
and MCP tool-use runs use the same experiment → run → trace model, SQLite store, and REST/SSE API.
Benchmark-native artifacts remain on disk; adapters normalize
their live progress, scores, token usage, costs, and traces.

```bash
# Headless API on :4700
bun run serve --port 4700
```

## How Harbor runs execute

1. **Local Runtime, not npm.** By default the runner bind-mounts the repo
   read-only into each task container (`--install source`) and runs the RPC host
   straight from `packages/coding-agent/src/runtime-rpc-host.ts` — TS edits apply to the
   next trial with no rebuild. A cached linux `node_modules` tree (built once
   per lockfile change inside `oven/bun`, stored in `<jobs-dir>/_bench/_deps/`)
   shadows the host's darwin one, and a linux `bun` binary is mounted at
   `/opt/omp/bin` — so trial setup needs zero outbound network. Alternatives:
   `--install local` (build and pack the Runtime bundle per run) or `--binary`
   (a compatible self-contained Runtime RPC host).
2. **Auth never enters containers.** A generated `models.yml` routes provider
   `baseUrl`s at the host pm2 auth-gateway; the gateway resolves credentials
   host-side.
3. **Harbor owns trials.** The runner/serve layer polls each trial's
   `result.json` for progress, spend, and outcomes.

## Server

- `GET /api/experiments[?q=]` — experiment summaries across all benchmark types
  (`q` filters by id/goal substring).
- `POST /api/experiments` — register an experiment before its first arm. Body
  `{ "id": "sb2", "goal": "..." }`; the id is the dash-free token job names
  group under (`sb2-n8` → experiment `sb2`).
- `GET /api/experiments/:id` — arms, per-task matrix, and calibrated projections.
- `PUT /api/experiments/:id` — update the goal and per-run role/note/label.
- `POST /api/experiments/:id/arms` — launch a comparable arm; sample + config
  inherited from a sibling.
- `DELETE /api/experiments/:id` — delete every arm (DB rows **and** job dirs)
  plus the goal row; rejected while any arm is running.
- `GET /api/runs[?experiment=&status=&benchmark=]` — uniform run rows with
  benchmark, score, progress, spend, and tokens.
- `POST /api/runs` — launch through a benchmark adapter. Body:

  ```json
  {
    "benchmark": "edit",
    "model": "anthropic/claude-opus-4-8",
    "tasks": 20,
    "concurrency": 4,
    "attempts": 2,
    "jobName": "edit-baseline",
    "role": "baseline",
    "goal": "compare edit strategies"
  }
  ```

  `benchmark` is `harbor`, `edit`, `snapcompact`, or `mcp`. Harbor uses `dataset`,
  `include`, `timeoutMultiplier`, and `prewalk`; edit uses `include` as task IDs;
  SnapCompact uses `conditions` and treats `tasks` as the passage limit; mcp uses
  `include` as task IDs and defaults to a real OMP agent against controlled MCP
  servers. The old policy simulation is explicitly `mcp.mode: "deterministic"`.
- `GET /api/runs/:name` — `{ run, traces }` (syncs native artifacts on read).
- `POST /api/runs/:name/cancel` — cancel a manager-launched run.
- `DELETE /api/runs/:name` — permanently delete a finished run (DB row **and**
  job dir; a surviving dir would be re-discovered on restart); rejected while
  the run is live.
- `POST /api/runs/:name/resume` — resume an incomplete harbor run in place:
  completed trials (and their spend) are reused, interrupted/pending trials
  re-run, and errored trials retried (body `{ "filterErrorTypes": [...] }`
  overrides the retry set, which defaults to every exception type in the job's
  `result.json`). The runner recovers the original launch flags from
  `_bench/<name>/runner-config.json` (snapshotted at launch) or the run's
  `manager.json` — nothing needs re-specifying.
- `GET /api/runs/:name/traces/:trace[?raw=1]` — normalized or native trace.
- `GET /api/events` — SSE stream of run-list snapshots (sent on change).

State lives in `<jobs-dir>/_manager/metaharness.sqlite`; the filesystem
stays the source of truth and historical CLI runs are auto-discovered.

## MCP agent evaluation and source binding

`mcp` has two deliberately separate execution modes:

- **`agent` (default):** real OMP session and provider request loop, actual MCP
  registry refresh/arbitration and tool execution, independently graded final
  answers. Six controlled cases cover retrieval, search followed by read,
  correct data-source selection, tool restraint, temporary read recovery, and
  a name collision. This is a small regression suite, not a general quality benchmark.
- **`deterministic`:** the existing `correct` / `overcall` / `misselection`
  policies calibrate protocol and metric plumbing without a model or credentials.
  Passing `--selftest` or `--policy` selects this mode; it is never substituted
  automatically when a real model run fails.

### Run from the CLI

Run from `packages/metaharness`. The selected model must exist in the candidate's
catalog or be supplied through an explicit non-secret `--model-profile <json>`.
Supply credentials only through the current process environment; the
following example uses an already-set `DEEPSEEK_API_KEY` without placing it in
arguments, source files, configuration, or results:

```bash
# List the real-agent task IDs. No credentials or model calls are needed.
bun adapters/mcp/cli.ts --mode agent --list

# One real agent trial. Use a fresh output directory for every arm.
bun adapters/mcp/cli.ts \
  --mode agent \
  --model deepseek/deepseek-v4-flash \
  --api-key-env DEEPSEEK_API_KEY \
  --harness-source /path/to/omp-candidate \
  --tasks record-by-id \
  --runs 1 \
  --max-requests 8 \
  --timeout-ms 60000 \
  --budget-usd 1 \
  --output /path/to/jobs/experiment-baseline/result.json

# Zero-model policy calibration. This is not agent quality evidence.
bun adapters/mcp/cli.ts --model fake/model --selftest \
  --output /path/to/selftest/result.json
```

`--harness-source` defaults to this checkout for direct CLI runs. Optional
`--expected-base-commit` and `--expected-source-digest` are assertions: a mismatch
rejects preparation before any provider request. The executable identity is
computed by the runner, not taken from these assertions or a caller's label.
`--base-url` may override the catalog endpoint; it must be HTTPS, except for
loopback test endpoints, and may not include credentials, query parameters or
fragments. Ambient user model configuration, skills and extensions are not loaded.

For a newly released model absent from the frozen catalog, `--model-profile`
accepts only `provider`, `id`, `name`, `api`, `baseUrl`, `reasoning`, `input`,
`contextWindow`, `maxTokens`, and the four numeric `cost` buckets (`input`,
`output`, `cacheRead`, `cacheWrite`). Its provider/id must exactly match `--model`.
Keys, arbitrary headers, and conflicting `--base-url` overrides are rejected.
The complete profile is frozen into `evaluation.controls` and `controlsDigest`,
then passed to the candidate's canonical model constructor. It does not alias a
new model to an older bundled model, and does not edit generated `models.json`.
This explicit profile option is currently a CLI/programmatic runner feature;
REST launch options are unchanged. Pricing in a profile remains an estimate,
not a statement of subscription quota consumption or current peak pricing.

### One-command Go V4.1 baseline

Run `bash scripts/run-go-v41-baseline.sh` in a local terminal to execute all six
MCP tasks three times with the explicit V4.1 profile and a 240-second trial
budget. It asserts the established baseline source digest, creates a fresh run
directory, and leaves all previous results untouched. The current shell's
`OPENCODE_API_KEY` is used; an interactive terminal can instead enter it at a
hidden prompt. The script never reads the user's credential files. `--check`
performs configuration checks without credentials or model requests; `--smoke`
selects one `record-by-id` trial. The default baseline opts into bounded timeout
continuation: stop at 2 consecutive or 4 total model timeouts, with a $0.25
scheduling reserve per unmetered trial. `--strict` retains stop-on-first-error.
A timeout is never re-executed by this scheduler.

The script saves `console.log`, `result.json`, `summary.json` and `summary.md`.
It verifies executable hashes and regrades recorded outputs when summarizing.
Unknown usage and interrupted trials remain failures; it does not retry until
successful or stitch different runs into one baseline. The dollar threshold is
the reported catalog estimate PLUS unknown-usage reserves, not a hard account
billing cap. A reserve is an explicit operator allowance, not measured spend or
proof of a worst-case bill. Actual usage can exceed that allowance.

New worker outputs include bounded `diagnostics`: request preparation, response
headers, first/last SSE frame, first semantic content, tool execution and cleanup
timings. `httpAttempts` now observes every fetch call, including 4xx/5xx responses
hidden by SDK retries; only a bounded, sanitized request-id and known network
error code are retained, never raw headers, bodies or credentials. `payloadReadyMs`
is before fetch and does not prove transmission. The legacy `responseHeadersMs`
is the SDK callback, not a socket trace; null cannot establish that the server
never processed/billed a request. No inference about DNS, TLS or server inference
is made without lower-level evidence. A timeout
records its phase before aborting; an SDK deadline firing before the worker's
timer is also classified as timeout. After awaited cleanup, the one-shot worker
flushes its result then exits explicitly so residual SDK timers cannot extend a
finished trial. This changes the driver identity: run a new baseline and do not
interpret a shorter process-exit tail as improved model latency. Old archived
runs without timing evidence remain readable without invented measurements.

### Launch through REST

Start the manager with the selected credential environment variable already set.
Keys themselves are not accepted in request bodies. `apiKeyEnv` names an existing
variable, defaulting to `MCP_BENCH_API_KEY`.

```json
{
  "benchmark": "mcp",
  "model": "deepseek/deepseek-v4-flash",
  "jobName": "retrieval-baseline",
  "role": "baseline",
  "include": ["record-by-id", "search-then-read", "choose-correct-source"],
  "attempts": 2,
  "harness": {
    "layers": ["prompt", "mcp"],
    "variantId": "baseline"
  },
  "harnessSource": {
    "root": "/path/to/omp-baseline"
  },
  "mcp": {
    "mode": "agent",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "maxRequests": 8,
    "maxToolCalls": 16,
    "maxOutputTokens": 1024,
    "temperature": 0,
    "timeoutMs": 60000,
    "budgetUsd": 1
  }
}
```

A new `POST /api/experiments/:id/arms` agent arm **must provide its own
`harnessSource`**. Task sample, attempts, and MCP controls are inherited;
`harness`, `harnessSource` and explicit `mcp` overrides are accepted on the new
arm. The baseline's checkout is never silently inherited as the candidate.
MCP `extraArgs` and trial concurrency other than 1 are rejected. Separate arms
have separate directories/processes. Source execution binding currently covers
**MCP agent runs only**; passing `harnessSource` to another benchmark is rejected
rather than recorded as if it took effect.

### What is bound and what is graded

Preparation snapshots the effective runtime source tree, including uncommitted
runtime edits, required ignored generated assets and the current native binary.
Candidate `packages/metaharness` code is excluded: the trusted evaluator supplies
the driver and grader. Workspace imports resolve into the snapshot, not the
producer's live `node_modules` workspace links. External JavaScript dependencies
are bundled from the evaluator's installed environment; candidate and evaluator
lockfiles must match. The resulting JavaScript/assets/native package are retained
without source-tree resolver links. Their manifest is checked before and after
every trial, and the worker reports the hash of the entrypoint it actually loaded.

Each fresh process/session receives only the task prompt, selected servers and
model/budget controls, never `expected` answers or required-route labels. The
model receives only controlled MCP tools, not general filesystem or shell tools.
A result passes when its exact requested JSON is correct **and** the required
original server/tool routes actually succeeded. Calling the right short name at
the wrong server, making up an answer without retrieval, or returning a wrong
answer after a correct tool call fails. Safe failed-then-successful reads may
pass. Collision counts are diagnostic; eliminating a collision is not penalized.
The former simulated `selection_precision` and `relevance_f1` are `null` in agent
mode rather than misrepresented as comparable real-agent measurements.

Both run-list and run-detail REST responses expose `run.evidence`:

- `mode`, measured `execution` identities (base commit, source, dependency lock,
  trusted driver and executable manifest digests, Bun version and platform).
- `evaluation`: model, task-set digest, evaluator digest, exact request/output/time
  controls and their digest.
- `usageComplete`: whether all planned trials completed with usable usage evidence.

`harness.patchDigest` remains a backward-compatible, **unverified caller label**;
it is not the new execution identity. Old database rows migrate with
`evidence: null`. Baseline and candidate source digests normally differ. Compare
runs only with matching task/grader/control/runtime environment records and
review the intended source difference; matching model names alone is insufficient.

Per-run files are `result.json` (atomically updated),
`result.dump/<task>/run-N.md` (answer, original routes, arguments, tool outcomes,
stop reason and grade), and `harness-*/{execution.json,source-manifest.json,
build-inputs.json,runtime/}` (reproducibility artifacts). Model keys are not written
to these files and are cleared from the MCP child environment. Retain these
local artifacts for review; do not commit generated runtime trees or secrets.

### Limits and interpretation

The wall-clock deadline, model-invocation cap, tool-execution cap and per-request
output cap bound trials. `maxRequests` also caps actual fetch attempts, including
SDK transport retries; the scheduler adds no retry. `budgetUsd` stops **new**
trials after the reported estimate plus explicitly configured unmetered reserves;
it is not a hard prepaid dollar ceiling, and one in-flight trial can overshoot it.
Cost is a catalog estimate based on observed provider usage, not an invoice.
Reasoning tokens are `null` when the provider does not report that breakdown;
they are included in total output tokens and must not be added a second time.
The default runner policy remains fail-fast. To continue after a model timeout,
CLI callers must supply all three flags: `--max-timeout-failures`,
`--max-consecutive-timeouts`, and `--unknown-usage-reserve-usd`. REST uses
`mcp.timeoutPolicy = { mode: "continue", maxTimeoutFailures: 4,
maxConsecutiveTimeouts: 2, unknownUsageReserveUsd: 0.25 }`. Limits stop scheduling
when reached. The policy, attempt count, ordering and budget are persisted as
`evaluation.scheduling` with a separate `schedulingDigest`.

Only a validated model-phase timeout with completed local cleanup qualifies.
Identity/protocol/process errors, setup/tool/cleanup failures, missing usage on
an otherwise completed response, and observed 401/403/429 still stop the suite.
Cancellation is never continued. Unknown spend remains unknown and any used
reserve is separate from `costUsd`; `usageComplete` stays false.

When all planned trials are attempted but some timed out, the native status is
`complete-with-errors` and CLI exits 1. REST keeps its existing failed process
status but exposes `run.evidence.suiteStatus` and coverage/error metrics, so this
is distinguishable from an interrupted suite. `stopReason` describes an early
stop. `completedRuns` retains its historical meaning of attempted trials; the
summary separately reports `unexecutedRuns`, `taskFailures`, `executionErrors`,
`timeoutRuns` and `unknownUsageRuns`. Partial runs keep the planned denominator.
Neither continuation nor reruns erase a failed trial.

This is reproducibility isolation for **reviewed local candidates**, not a secure
sandbox for hostile source code. OMP's unavailable product-policy modules remain
fail-closed; this MCP suite does not emulate Leapsea's full permission/bundle stack.
The prepared native binary must already match its source/ABI; preparation does
not build Rust or rebuild/promote a Leapsea runtime bundle. Automatic candidate
promotion, broad held-out quality claims and source binding for
edit/Harbor/SnapCompact are outside this implementation.

### P2 capability-notice candidate

The production SDK now projects bounded, current MCP name-collision state into
model requests without changing arbitration or enqueueing a new turn. See
`docs/P2-IMPLEMENTATION-STATUS.md` for lifecycle coverage and remaining boundaries.
Run `bash scripts/run-go-v41-p2.sh --candidate` for 36 candidate trials and a
verified comparison against the pinned historical v2 baseline. The default
`--check` rebuilds and validates without credentials or provider calls. This is
not an interleaved A/B; truthful unavailability is not counted as task completion.
The driver, v2 tasks, fixture, grader and budget remain unchanged. The script
refuses source drift and writes comparison artifacts without adopting code.

### Verification

```bash
export PATH="$PWD/../../node_modules/.bin:$PATH"
bun run check:types
bun test
bun --bun ../../node_modules/.bin/biome lint src test adapters/mcp
```

The regression suite runs actual compiled OMP sessions and stdio MCP servers
against a local controlled model-protocol endpoint, including REST -> CLI launch,
source changes visible on the model request, post-freeze edit exclusion, budget
stops, cancellation, artifact tampering, migration and persisted evidence. Those
tests do **not** constitute a paid/live-provider benchmark or prove quality uplift.

## Harbor runner options (excerpt)

| Option | Default | Notes |
|---|---|---|
| `-m, --model <provider/model>` | `anthropic/claude-sonnet-4-6` | Repeatable |
| `-l, --tasks <N>` | `20` | Max tasks |
| `-n, --concurrency <N>` | `4` | Concurrent trials |
| `-k, --attempts <N>` | `1` | Attempts per task (pass@k) |
| `-d, --dataset <name>` | `terminal-bench@2.0` | Any Harbor dataset id |
| `-i/-x, --include/--exclude <glob>` | — | Task filters (repeatable) |
| `--timeout-multiplier <x>` | — | Scales task agent/verifier timeouts |
| `--agent-arg <arg>` | — | Extra arg forwarded verbatim to the in-container Runtime RPC host (repeatable) |
| `--env <KEY[=VALUE]>` | — | Forward env into the omp container (repeatable); `KEY` alone forwards the host value |
| `--binary <path>` | — | Prebuilt omp binary (repeat for arm64+x64) |
| `--install <source\|local\|published>` | `source` | `source` = repo bind-mount, `local` = tarball pack, `published` = npm `@oh-my-pi/pi-coding-agent` |
| `--environment <docker\|apple-container>` | `docker` | `apple-container` runs trials via Apple's `container` CLI (no Docker); source/deps mounts go through `harbor --mounts` and the gateway is auto-forwarded from `192.168.64.1:4000` to the loopback-bound gateway |
| `--gateway-url <url>` | `http://host.docker.internal:4000` | `http://192.168.64.1:4000` under `--environment apple-container` |
| `--no-gateway` | off | Pass host provider keys into containers instead |
| `-o, --jobs-dir <path>` | `<repo>/runs/harbor` | Shared with the server |
| `--resume <name\|path>` | — | Resume that job dir via `harbor job resume`; original flags recovered automatically |
| `--filter-error-type <T>` | `CancelledError` | With `--resume`: also re-run completed trials that errored with exception type `T` (repeatable) |
| `--dry-run` | off | Print the harbor command + models.yml and exit |

## Outputs

- `<jobs-dir>/<jobName>/` — Harbor trial dirs (`result.json` per trial).
- `<jobs-dir>/_bench/<jobName>/report.md` — markdown summary table.
- `<jobs-dir>/_bench/<jobName>/harbor.log` — full Harbor output.
- `<jobs-dir>/_manager/logs/<jobName>.log` — runner output for API-launched runs.

## Trace reports

`scripts/trace-report.ts` turns one run trace into a narrative markdown report
(numbered Turn Log with one grounded sentence per assistant turn, harness
notices in place, then a Story Arc and — for failed runs — a failure analysis).
It map/reduces the normalized trace through two cheap OpenRouter models
(defaults: `inclusionai/ling-2.6-flash` per turn, `openai/gpt-oss-120b` for the
arc; ~$0.001 per report). API keys resolve through omp's auth storage.

```bash
bun scripts/trace-report.ts <run> <trace> [--focus "reviewer notes"] [--out report.md]
bun scripts/trace-report.ts "sb3-ntg|django__django-12325__ddQroP4"   # run|trace also accepted
```

Flags: `--base` (server, default `http://localhost:4700`), `--tiny` / `--synth`
(`<provider>/<model-id>` overrides), `--focus` (extra reviewer context, e.g. the
known-correct fix for a failed task), `--concurrency` (default 8).

## Caveats

- **Network policy.** On Harbor's local Docker backend only **public**
  registries work; task containers reach models via the host gateway.
- **`--install source` reflects local TS changes** with no rebuild, but Rust
  natives load from the in-tree `packages/natives/native/pi_natives.linux-*.node`
  prebuilds — rebuild those when Rust changes (the loader skips the version
  sentinel for workspace loads, so a stale `.node` runs silently).
- **Source mode is single-arch.** The deps tree matches the docker daemon's
  native arch; trials on emulated images (e.g. x64 tasks on an arm64 host)
  fail setup with an arch-mismatch error — use `--binary` for those.
- **The repo is visible (read-only) inside task containers** in source mode;
  fine for curated benchmarks, but don't point it at untrusted tasks.
- **Apple Container specifics.** `--environment apple-container` needs
  `brew install container && container system start` (macOS 26+, Apple
  silicon). `--host-network` and `--cleanup*` are docker-only, and bind
  mounts are read-write (the backend ignores `read_only`).
- **`--install local` reflects local TS changes** (bundled under `dist/runtime`),
  but **not** uncommitted Rust natives — rebuild `packages/natives` per target
  first (the version sentinel must match).
