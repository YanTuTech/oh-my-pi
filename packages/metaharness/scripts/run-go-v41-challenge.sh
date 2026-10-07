#!/usr/bin/env bash
# Local-terminal entrypoint. Does not read credential files, install dependencies or alter source.
set +x
set -euo pipefail
umask 077
MODE="${1:---check}"
[ "$#" -le 1 ] || { printf 'Usage: bash %s [--check|--smoke|--baseline]\n' "$0"; exit 2; }
case "$MODE" in --check|--smoke|--baseline) ;; *) printf '%s\n' 'Use --check (no model), --smoke (one search task), or --baseline (12 tasks x 3).'; exit 2;; esac
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -n "${LEAPSEA_OMP_ROOT:-}" ]; then
  PKG_DIR="$LEAPSEA_OMP_ROOT/packages/metaharness"
elif [ -f "$SCRIPT_DIR/../adapters/mcp/challenge-cases.ts" ]; then
  PKG_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
else
  PKG_DIR="$HOME/Documents/GitHub/oh-my-pi/packages/metaharness"
fi
[ -f "$PKG_DIR/adapters/mcp/challenge-cases.ts" ] || { printf 'Missing v2 implementation: %s\n' "$PKG_DIR"; exit 2; }
command -v bun >/dev/null 2>&1 || { printf '%s\n' 'Bun is required. Use the same terminal as the previous baseline.'; exit 2; }
cd -- "$PKG_DIR"
PROFILE="runs/opencode-go-v41-20260922/model-profile.json"
bun -e '
import { parseModelProfile } from "./adapters/mcp/agent-protocol.ts";
import { tasksForSuite, suiteSourceDigests } from "./adapters/mcp/agent-suites.ts";
const p = parseModelProfile(await Bun.file("runs/opencode-go-v41-20260922/model-profile.json").json(), "opencode-go/deepseek-v4.1-flash");
if (p.api !== "openai-completions" || p.baseUrl !== "https://opencode.ai/zen/go/v1") throw new Error("Unexpected Go model route");
const tasks = tasksForSuite("mcp-challenge-v2");
if (tasks.length !== 12) throw new Error("Challenge task count changed; review the run plan");
console.log(JSON.stringify({ suite: "mcp-challenge-v2", tasks: tasks.length, model: "opencode-go/deepseek-v4.1-flash", ...await suiteSourceDigests("mcp-challenge-v2") }, null, 2));
'
if [ "$MODE" = --check ]; then printf '%s\n' 'Check passed. No credentials read and no model requests sent.'; exit 0; fi
trap 'unset OPENCODE_API_KEY' EXIT
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  [ -t 0 ] || { printf '%s\n' 'Set OPENCODE_API_KEY in the current terminal or run interactively.'; exit 2; }
  IFS= read -r -s -p 'OpenCode Go API key (hidden, not saved): ' OPENCODE_API_KEY
  printf '\n'
fi
[ -n "${OPENCODE_API_KEY:-}" ] || { printf '%s\n' 'Empty Go credential.'; exit 2; }
export OPENCODE_API_KEY
RUNS=3
TASK_ARGS=(--max-tasks 12)
LABEL=challenge-v2-36
if [ "$MODE" = --smoke ]; then RUNS=1; TASK_ARGS=(--tasks search-revision-17); LABEL=challenge-v2-smoke; fi
RUN_ROOT="$PKG_DIR/runs/opencode-go-v41-20260922"
mkdir -p -- "$RUN_ROOT"
RUN_DIR="$(mktemp -d "$RUN_ROOT/$LABEL-$(date +%Y%m%d-%H%M%S)-XXXXXXXX")"
printf '\nResult directory: %s\n' "$RUN_DIR"
printf '%s\n' 'No task-level retries. Honest unavailability is a task failure, not successful retrieval.'
set +e
bun adapters/mcp/cli.ts \
  --mode agent --suite mcp-challenge-v2 \
  --model opencode-go/deepseek-v4.1-flash --model-profile "$PROFILE" \
  --api-key-env OPENCODE_API_KEY --harness-source ../.. \
  --expected-source-digest c048c232645ac63f87f8dbeeac19aeddb1f81b718c6c40d9fe74a0b6146d651b \
  --runs "$RUNS" "${TASK_ARGS[@]}" \
  --timeout-ms 240000 --max-requests 8 --max-tool-calls 16 --max-output-tokens 4096 --temperature 0 \
  --budget-usd 1 --max-timeout-failures 4 --max-consecutive-timeouts 2 --unknown-usage-reserve-usd 0.25 \
  --output "$RUN_DIR/result.json" 2>&1 | tee "$RUN_DIR/console.log"
STATUSES=("${PIPESTATUS[@]}")
set -e
unset OPENCODE_API_KEY
REVIEW_EXIT=0
if [ -f "$RUN_DIR/result.json" ]; then
  bun scripts/review-mcp-challenge.ts "$RUN_DIR/result.json" || REVIEW_EXIT=$?
else
  printf '%s\n' 'No result generated; retain console.log.'
  REVIEW_EXIT=1
fi
printf '\nCLI exit: %s; log exit: %s; review exit: %s\n' "${STATUSES[0]}" "${STATUSES[1]}" "$REVIEW_EXIT"
printf 'Evidence: %s\n' "$RUN_DIR"
[ "${STATUSES[0]}" -eq 0 ] || exit "${STATUSES[0]}"
[ "${STATUSES[1]}" -eq 0 ] || exit "${STATUSES[1]}"
exit "$REVIEW_EXIT"
