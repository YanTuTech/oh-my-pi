#!/usr/bin/env bash
# P2 candidate run against the pinned historical v2 baseline. No credential files are read.
set +x
set -euo pipefail
umask 077
MODE="${1:---check}"
[ "$#" -le 1 ] || { printf 'Usage: bash %s [--check|--smoke|--candidate]\n' "$0"; exit 2; }
case "$MODE" in
  --check|--smoke|--candidate) ;;
  *) printf '%s\n' '--check：核验代码和旧基线，不调用模型；--smoke：2 次；--candidate：12 题各 3 次并对比旧基线。'; exit 2 ;;
esac
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -n "${LEAPSEA_OMP_ROOT:-}" ]; then
  PKG_DIR="$LEAPSEA_OMP_ROOT/packages/metaharness"
elif [ -f "$SCRIPT_DIR/verify-p2-candidate.ts" ]; then
  PKG_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
else
  PKG_DIR="$HOME/Documents/GitHub/oh-my-pi/packages/metaharness"
fi
[ -f "$PKG_DIR/scripts/verify-p2-candidate.ts" ] || { printf '缺少 P2 实现：%s\n' "$PKG_DIR"; exit 2; }
command -v bun >/dev/null 2>&1 || { printf '%s\n' '需要 Bun，请使用此前成功运行基线的终端。'; exit 2; }
cd -- "$PKG_DIR"
# This rebuilds the frozen candidate and regrades old evidence before any key is requested.
bun scripts/verify-p2-candidate.ts
if [ "$MODE" = --check ]; then printf '%s\n' '检查通过，未读取凭证、未调用模型。'; exit 0; fi
MANIFEST=docs/P2-CANDIDATE.json
BASELINE="$(bun -e 'console.log((await Bun.file("docs/P2-CANDIDATE.json").json()).baseline)')"
PROFILE="$(bun -e 'console.log((await Bun.file("docs/P2-CANDIDATE.json").json()).modelProfile)')"
EXPECTED_SOURCE="$(bun -e 'console.log((await Bun.file("docs/P2-CANDIDATE.json").json()).candidateSourceDigest)')"
EXPECTED_HEAD="$(bun -e 'console.log((await Bun.file("docs/P2-CANDIDATE.json").json()).expectedBaseCommit)')"
trap 'unset OPENCODE_API_KEY' EXIT
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  [ -t 0 ] || { printf '%s\n' '请在当前终端设置 OPENCODE_API_KEY，或在交互终端运行。'; exit 2; }
  IFS= read -r -s -p 'OpenCode Go API key（隐藏输入，不保存）: ' OPENCODE_API_KEY
  printf '\n'
fi
[ -n "${OPENCODE_API_KEY:-}" ] || { printf '%s\n' 'Go 密钥为空。'; exit 2; }
export OPENCODE_API_KEY
RUNS=3
TASK_ARGS=(--max-tasks 12)
LABEL=p2-notice-v2-36
if [ "$MODE" = --smoke ]; then RUNS=1; TASK_ARGS=(--tasks collision-victim-17,search-revision-17); LABEL=p2-notice-v2-smoke; fi
RUN_ROOT="$PKG_DIR/runs/opencode-go-v41-20260922"
mkdir -p -- "$RUN_ROOT"
RUN_DIR="$(mktemp -d "$RUN_ROOT/$LABEL-$(date +%Y%m%d-%H%M%S)-XXXXXXXX")"
cp -- "$MANIFEST" "$RUN_DIR/p2-candidate-manifest.json"
printf '\n结果目录：%s\n' "$RUN_DIR"
printf '%s\n' '只运行 P2 候选；原 v2 基线保持不动。诚实报告不可用不算任务成功。' \
  '仍为每次 240 秒；连续 2 次或累计 4 次模型超时停止。没有任务级补跑。' \
  '$1 是已观测估算＋未知用量预留的调度阈值，不是账单上限。'
set +e
bun adapters/mcp/cli.ts \
  --mode agent --suite mcp-challenge-v2 \
  --model opencode-go/deepseek-v4.1-flash --model-profile "$PROFILE" \
  --api-key-env OPENCODE_API_KEY --harness-source ../.. \
  --expected-source-digest "$EXPECTED_SOURCE" --expected-base-commit "$EXPECTED_HEAD" \
  --runs "$RUNS" "${TASK_ARGS[@]}" \
  --timeout-ms 240000 --max-requests 8 --max-tool-calls 16 --max-output-tokens 4096 --temperature 0 \
  --budget-usd 1 --max-timeout-failures 4 --max-consecutive-timeouts 2 --unknown-usage-reserve-usd 0.25 \
  --output "$RUN_DIR/result.json" 2>&1 | tee "$RUN_DIR/console.log"
STATUSES=("${PIPESTATUS[@]}")
set -e
unset OPENCODE_API_KEY
REVIEW_EXIT=0
COMPARE_EXIT=0
if [ -f "$RUN_DIR/result.json" ]; then
  bun scripts/review-mcp-challenge.ts "$RUN_DIR/result.json" || REVIEW_EXIT=$?
  if [ "$MODE" = --candidate ] && [ "$REVIEW_EXIT" -eq 0 ]; then
    bun scripts/compare-p2-capability.ts "$BASELINE" "$RUN_DIR/result.json" || COMPARE_EXIT=$?
  fi
else
  printf '%s\n' '未生成结果，请保留 console.log。'
  REVIEW_EXIT=1
fi
printf '\nCLI exit: %s; log exit: %s; review exit: %s; comparison exit: %s\n' "${STATUSES[0]}" "${STATUSES[1]}" "$REVIEW_EXIT" "$COMPARE_EXIT"
printf 'Evidence: %s\n' "$RUN_DIR"
printf '%s\n' 'comparison exit=1 也可能仅表示未满足开发验收或证据不足；请查看 p2-comparison.md，不要删除失败记录。'
[ "${STATUSES[0]}" -eq 0 ] || exit "${STATUSES[0]}"
[ "${STATUSES[1]}" -eq 0 ] || exit "${STATUSES[1]}"
[ "$REVIEW_EXIT" -eq 0 ] || exit "$REVIEW_EXIT"
exit "$COMPARE_EXIT"
