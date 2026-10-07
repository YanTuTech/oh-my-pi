#!/usr/bin/env bash
# Run in the user's terminal. This script never reads credential files or changes source code.
set +x
set -euo pipefail
umask 077

MODE="${1:---baseline}"
if [ "$#" -gt 1 ]; then printf 'Usage: bash %s [--baseline|--strict|--smoke|--check]\n' "$0"; exit 2; fi
case "$MODE" in
  --baseline|--strict|--smoke|--check) ;;
  --help|-h)
    printf '%s\n' '默认：6 道任务各 3 次，单次上限 240 秒；有限容忍模型超时，不重试失败题。' \
      '连续 2 次或累计 4 次超时停止；未知用量每次预留 $0.25 调度额度，非账单上限。' \
      '--strict：保留原先任一执行异常就停止的模式。' \
      '--smoke：只跑 record-by-id 一次。' \
      '--check：只检查本机文件和配置，不调用模型、不读取密钥。' \
      '密钥：使用当前终端的 OPENCODE_API_KEY；没有时隐藏输入，仅在脚本进程内使用。' \
      '其他安装位置可设置 LEAPSEA_OMP_ROOT 为 OMP 仓库根目录。'
    exit 0 ;;
  *) printf '未知参数：%s\n' "$MODE"; exit 2 ;;
esac

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -n "${LEAPSEA_OMP_ROOT:-}" ]; then
  PKG_DIR="$LEAPSEA_OMP_ROOT/packages/metaharness"
elif [ -f "$SCRIPT_DIR/../adapters/mcp/cli.ts" ]; then
  PKG_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
else
  PKG_DIR="$HOME/Documents/GitHub/oh-my-pi/packages/metaharness"
fi
[ -f "$PKG_DIR/adapters/mcp/cli.ts" ] || { printf '找不到评测器：%s\n' "$PKG_DIR"; exit 2; }
[ -f "$PKG_DIR/adapters/mcp/agent-diagnostics.ts" ] || { printf '%s\n' '缺少诊断更新，停止运行。'; exit 2; }
[ -f "$PKG_DIR/adapters/mcp/agent-scheduling.ts" ] || { printf '%s\n' '缺少有限续跑更新，停止运行。'; exit 2; }
command -v bun >/dev/null 2>&1 || { printf '%s\n' '找不到 Bun，请在此前成功运行评测的终端执行。'; exit 2; }
cd -- "$PKG_DIR"
PROFILE="runs/opencode-go-v41-20260922/model-profile.json"
[ -f "$PROFILE" ] || { printf '缺少模型配置：%s/%s\n' "$PKG_DIR" "$PROFILE"; exit 2; }

# Validate exact identity and Go routing before requesting any credentials.
bun -e '
import { parseModelProfile } from "./adapters/mcp/agent-protocol.ts";
import { AGENT_TASKS } from "./adapters/mcp/agent-cases.ts";
import { parseTimeoutPolicy } from "./adapters/mcp/agent-scheduling.ts";
parseTimeoutPolicy({ mode: "continue", maxTimeoutFailures: 4, maxConsecutiveTimeouts: 2, unknownUsageReserveUsd: 0.25 });
const profile = parseModelProfile(await Bun.file("runs/opencode-go-v41-20260922/model-profile.json").json(), "opencode-go/deepseek-v4.1-flash");
if (profile.api !== "openai-completions" || profile.baseUrl !== "https://opencode.ai/zen/go/v1") throw new Error("模型配置不是预期的 OpenCode Go V4.1 路由，停止运行");
if (AGENT_TASKS.length !== 6) throw new Error("任务集数量已变化，停止运行并重新核对基线");
console.log("配置检查通过：opencode-go/deepseek-v4.1-flash；6 道任务；Bun " + Bun.version);
'
if [ "$MODE" = --check ]; then printf '%s\n' '检查完成。未调用模型。'; exit 0; fi

trap 'unset OPENCODE_API_KEY' EXIT
if [ -z "${OPENCODE_API_KEY:-}" ]; then
  if [ ! -t 0 ]; then printf '%s\n' '非交互终端且未设置 OPENCODE_API_KEY，停止运行。'; exit 2; fi
  printf '%s\n' '当前终端未设置 OPENCODE_API_KEY。请输入 Go 密钥；输入不可见，不写入文件。'
  IFS= read -r -s -p 'OpenCode Go API key: ' OPENCODE_API_KEY
  printf '\n'
fi
[ -n "${OPENCODE_API_KEY:-}" ] || { printf '%s\n' '密钥为空，停止运行。'; exit 2; }
export OPENCODE_API_KEY

RUNS=3
TASK_ARGS=(--max-tasks 6)
LABEL=baseline-18-t240-bounded
POLICY_ARGS=(--max-timeout-failures 4 --max-consecutive-timeouts 2 --unknown-usage-reserve-usd 0.25)
if [ "$MODE" = --strict ]; then POLICY_ARGS=(); LABEL=baseline-18-t240-strict; fi
if [ "$MODE" = --smoke ]; then RUNS=1; TASK_ARGS=(--tasks record-by-id); POLICY_ARGS=(); LABEL=smoke-t240-diagnostics; fi
RUN_ROOT="$PKG_DIR/runs/opencode-go-v41-20260922"
mkdir -p -- "$RUN_ROOT"
RUN_DIR="$(mktemp -d "$RUN_ROOT/$LABEL-$(date +%Y%m%d-%H%M%S)-XXXXXXXX")"
printf '\n结果目录：%s\n' "$RUN_DIR"
printf '%s\n' '每完成一个试次显示进度；不自动重试失败，不覆盖历史结果。Ctrl+C 可取消。'
if [ "$MODE" = --baseline ]; then
  printf '%s\n' '本次启用有限超时续跑：连续 2 次或累计 4 次模型超时即停止。' \
    '超时用量保持未知，每次扣留 $0.25 调度额度；已观测估算 + 预留达到 $1 停止。' \
    '这是本地调度边界，不是供应商实际扣费上限；身份/清理/认证等异常仍立即停止。'
fi

set +e
bun adapters/mcp/cli.ts \
  --mode agent \
  --model opencode-go/deepseek-v4.1-flash \
  --model-profile "$PROFILE" \
  --api-key-env OPENCODE_API_KEY \
  --harness-source ../.. \
  --expected-source-digest c048c232645ac63f87f8dbeeac19aeddb1f81b718c6c40d9fe74a0b6146d651b \
  --runs "$RUNS" "${TASK_ARGS[@]}" \
  --max-requests 8 --max-tool-calls 16 --max-output-tokens 4096 \
  --temperature 0 --timeout-ms 240000 --budget-usd 1 ${POLICY_ARGS[@]+"${POLICY_ARGS[@]}"} \
  --output "$RUN_DIR/result.json" 2>&1 | tee "$RUN_DIR/console.log"
PIPE_RESULTS=("${PIPESTATUS[@]}")
set -e
CLI_EXIT="${PIPE_RESULTS[0]}"
LOG_EXIT="${PIPE_RESULTS[1]}"
unset OPENCODE_API_KEY

if [ ! -f "$RUN_DIR/result.json" ]; then
  printf '\n未生成结果文件；请保留目录和 console.log：%s\n' "$RUN_DIR"
  if [ "$CLI_EXIT" -eq 0 ]; then exit 1; else exit "$CLI_EXIT"; fi
fi

# Summarize and independently verify saved evidence. No credential reaches this process.
SUMMARY_EXIT=0
LEAPSEA_RESULT_PATH="$RUN_DIR/result.json" bun -e '
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseHarnessExecution, verifyPreparedHarness, sha256 } from "./src/harness-source.ts";
import { parseAgentOutput } from "./adapters/mcp/agent-protocol.ts";
import { AGENT_TASKS, gradeAgentTask } from "./adapters/mcp/agent-cases.ts";
const resultPath = process.env.LEAPSEA_RESULT_PATH;
if (!resultPath) throw new Error("Missing result path");
const root = path.dirname(resultPath);
const result = await Bun.file(resultPath).json();
const execution = parseHarnessExecution(result.execution);
const preparations = (await fs.readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && entry.name.startsWith("harness-"));
if (preparations.length !== 1) throw new Error("Expected exactly one prepared runtime");
await verifyPreparedHarness({ runtimeDir: path.join(root, preparations[0].name, "runtime"), execution });
if (result.evaluation.model !== "opencode-go/deepseek-v4.1-flash" || result.evaluation.controls.timeoutMs !== 240000) throw new Error("Unexpected experiment controls");
if (sha256(JSON.stringify(result.evaluation.controls)) !== result.evaluation.controlsDigest) throw new Error("Control digest mismatch");
if (!result.evaluation.scheduling || sha256(JSON.stringify(result.evaluation.scheduling)) !== result.evaluation.schedulingDigest) throw new Error("Scheduling digest mismatch");
const taskDefinitions = result.tasks.map(task => AGENT_TASKS.find(definition => definition.id === task.id));
if (taskDefinitions.some(task => !task) || sha256(JSON.stringify(taskDefinitions)) !== result.evaluation.tasksetDigest) throw new Error("Taskset digest mismatch");
const evaluatorFiles = ["agent-cases.ts", "agent-runner.ts", "agent-protocol.ts", "agent-scheduling.ts"];
const evaluatorHashes = await Promise.all(evaluatorFiles.map(async name => [name, sha256(await Bun.file(path.join("adapters/mcp", name)).bytes())]));
if (sha256(JSON.stringify(evaluatorHashes)) !== result.evaluation.evaluatorDigest) throw new Error("Evaluator changed since the run; preserve the raw evidence");
const entrypoint = execution.files.find(file => file.path === execution.entrypoint);
const rows = [];
const perRequest = [];
const perHttpAttempt = [];
for (const task of result.tasks) {
  const definition = AGENT_TASKS.find(item => item.id === task.id);
  if (!definition) throw new Error("Unknown task in result");
  for (const run of task.runs) {
    const output = run.output ? parseAgentOutput(run.output) : null;
    if (output && output.entrypointDigest !== entrypoint?.sha256) throw new Error("Worker entrypoint digest mismatch");
    if (output && JSON.stringify(gradeAgentTask(definition, output)) !== JSON.stringify(run.grade)) throw new Error("Regrading disagrees with saved verdict");
    const diagnostics = output?.diagnostics;
    rows.push({ task: task.id, attempt: run.runIndex + 1, status: run.success ? "PASS" : run.error ?? "FAIL", seconds: +(run.duration / 1000).toFixed(3), requests: output?.requests ?? null, tools: output?.calls.length ?? null, timeoutPhase: diagnostics?.timeout?.requestPhase ?? diagnostics?.timeout?.phase ?? null, usageComplete: run.usageComplete });
    for (const request of diagnostics?.requests ?? []) {
      perRequest.push({ task: task.id, attempt: run.runIndex + 1, ...request });
      for (const http of request.httpAttempts ?? []) perHttpAttempt.push({ task: task.id, attempt: run.runIndex + 1, logicalRequest: request.index, ...http });
    }
  }
}
const passed = rows.filter(row => row.status === "PASS").length;
if (rows.length !== result.summary.completedRuns || passed !== result.summary.successfulRuns) throw new Error("Summary counts disagree with saved trials");
const summary = { model: result.evaluation.model, status: result.status, stopReason: result.stopReason, planned: result.summary.totalRuns, executed: rows.length, passed, notExecuted: result.summary.totalRuns - rows.length, taskFailures: result.summary.taskFailures, executionErrors: result.summary.executionErrors, timeoutRuns: result.summary.timeoutRuns, unknownUsageRuns: result.summary.unknownUsageRuns, usageComplete: result.summary.usageComplete, catalogEstimateUsd: result.summary.costUsd, unknownUsageReserveUsd: result.summary.unknownUsageReserveUsd, budgetAccountedUsd: result.summary.budgetAccountedUsd, scheduling: result.evaluation.scheduling, sourceDigest: execution.sourceDigest, driverDigest: execution.driverDigest, runtimeDigest: execution.runtimeDigest, artifactHashesVerified: true, rows, perRequest, perHttpAttempt };
await Bun.write(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
const lines = ["# OpenCode Go V4.1 baseline", "", `Status: ${summary.status}`, `Executed: ${summary.executed}/${summary.planned}; passed: ${summary.passed}; not executed: ${summary.notExecuted}`, `Usage complete: ${summary.usageComplete}`, `Catalog estimate USD (not a billing receipt): ${summary.catalogEstimateUsd}`, `Source: ${summary.sourceDigest}`, `Driver: ${summary.driverDigest}`, "", "| Task | Attempt | Status | Seconds | Requests | Tools | Timeout phase |", "|---|---:|---|---:|---:|---:|---|"];
for (const row of rows) lines.push(`| ${row.task} | ${row.attempt} | ${row.status} | ${row.seconds} | ${row.requests ?? "unknown"} | ${row.tools ?? "unknown"} | ${row.timeoutPhase ?? "none"} |`);
lines.push("", `Task failures: ${summary.taskFailures}; execution errors: ${summary.executionErrors}; timeouts: ${summary.timeoutRuns}; unknown-usage trials: ${summary.unknownUsageRuns}`, `Stop reason: ${summary.stopReason ?? "none"}`, `Unmetered scheduling reserve USD: ${summary.unknownUsageReserveUsd}; budget-accounted USD: ${summary.budgetAccountedUsd} (NOT measured spend or a billing ceiling)`, "", "Per-request and per-HTTP-attempt timings are in summary.json. payloadReady means prepared, not transmitted. The SDK headers callback can omit error responses; consult httpAttempts. Missing headers do NOT establish upstream receipt, zero compute, or zero billing. This run never replaces failed trials.");
await Bun.write(path.join(root, "summary.md"), lines.join("\n") + "\n");
console.table(rows);
console.log(JSON.stringify({ status: summary.status, stopReason: summary.stopReason, planned: summary.planned, executed: summary.executed, passed: summary.passed, notExecuted: summary.notExecuted, timeoutRuns: summary.timeoutRuns, unknownUsageRuns: summary.unknownUsageRuns, usageComplete: summary.usageComplete, budgetAccountedUsd: summary.budgetAccountedUsd, artifactHashesVerified: true }, null, 2));
' || SUMMARY_EXIT=$?

printf '\nCLI exit: %s；日志 exit: %s；汇总校验 exit: %s\n' "$CLI_EXIT" "$LOG_EXIT" "$SUMMARY_EXIT"
printf '请把这个目录发给我核验：\n%s\n' "$RUN_DIR"
if [ "$CLI_EXIT" -ne 0 ]; then exit "$CLI_EXIT"; fi
if [ "$LOG_EXIT" -ne 0 ]; then exit "$LOG_EXIT"; fi
exit "$SUMMARY_EXIT"
