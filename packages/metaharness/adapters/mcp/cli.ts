#!/usr/bin/env bun
/**
 * Executable adapter for the MCP tool-use benchmark.
 *
 * Two audiences share this entry point, mirroring `adapters/edit/cli.ts`:
 * - The metaharness manager spawns it headless
 *   (`--model … --output result.json`) and consumes only the written report.
 * - Humans run it directly, optionally with `--selftest` to verify that the
 *   graded metrics actually discriminate between policies.
 *
 * Agent mode is the default and uses the selected provider through a frozen
 * OMP runtime. Deterministic policy mode remains an explicit, credential-free
 * selftest; it must never be mistaken for real-agent quality evidence.
 */
import * as path from "node:path";
import { parseArgs } from "node:util";
import { parseModelProfile } from "./agent-protocol";
import { runAgentBenchmark } from "./agent-runner";
import { parseTimeoutPolicy } from "./agent-scheduling";
import { parseAgentSuite, tasksForSuite } from "./agent-suites";
import { MCP_POLICIES, type McpPolicy, runMcpBenchmark } from "./runner";
import { MCP_TASKS, type McpTask } from "./tasks";

const FAKE_SERVER = path.join(import.meta.dir, "fake-mcp-server.ts");

function log(line = ""): void {
	process.stderr.write(`${line}\n`);
}

function fail(message: string): never {
	throw new Error(message);
}

function parsePositiveInt(raw: string | undefined, flag: string, fallback: number): number {
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`Invalid ${flag} value: ${raw}. Must be a positive integer.`);
	return parsed;
}

function parsePolicy(raw: string | undefined): McpPolicy {
	const value = raw ?? "correct";
	if (!MCP_POLICIES.includes(value as McpPolicy)) {
		fail(`Invalid --policy: ${value}. Valid: ${MCP_POLICIES.join(", ")}`);
	}
	return value as McpPolicy;
}

function selectTasks(values: { tasks?: string; "max-tasks": string }): McpTask[] {
	if (values.tasks) {
		const wanted = new Set(values.tasks.split(",").map(value => value.trim()));
		const selected = MCP_TASKS.filter(task => wanted.has(task.id));
		if (selected.length !== wanted.size) fail("one or more mcp task ids were not found (see --list)");
		return selected;
	}
	const limit = Number(values["max-tasks"]);
	if (limit > 0 && MCP_TASKS.length > limit) return MCP_TASKS.slice(0, limit);
	return MCP_TASKS;
}

function printUsage(): void {
	log(`
MCP Tool-Use Benchmark - real OMP agent evaluation or explicit deterministic selftest

Usage:
  bun adapters/mcp/cli.ts --model <provider/model> [options]

Options:
  --mode <agent|deterministic>  Agent is the default; --selftest selects deterministic
  --suite <id>                 mcp-smoke-v1 (default) or mcp-challenge-v2
  --harness-source <repo>       Candidate Git checkout (agent mode)
  --expected-source-digest <sha256>  Refuse a mismatched candidate
  --expected-base-commit <sha>  Refuse a mismatched base
  --base-url <url>              Explicit provider endpoint override
  --model-profile <json>        Non-secret frozen model metadata for a new model
  --api-key-env <name>          Credential variable (default: MCP_BENCH_API_KEY)
  --timeout-ms <n>              Whole-trial deadline (default: 60000)
  --max-requests <n>            Per-trial model request cap (default: 8)
  --max-tool-calls <n>          Per-trial execution cap (default: 16)
  --max-output-tokens <n>       Per-request output cap (default: 1024)
  --temperature <n>             Sampling temperature (default: 0)
  --budget-usd <n>              Stop at reported estimate + unknown-usage reserves (default: 1)
  --max-timeout-failures <n>     Opt in to continuation; stop at this timeout count
  --max-consecutive-timeouts <n>  Stop at this many consecutive timeouts
  --unknown-usage-reserve-usd <n>  Required allowance per unmetered trial; NOT a bill cap
  --model <id>            Provider/model ID (used by agent mode;
                          ignored by deterministic policy selftests)
  --output <file>         Fresh report path (agent default: timestamped run directory)
  --tasks <ids>           Comma-separated task IDs (default: all built-ins)
  --max-tasks <n>         Max tasks to run (default: all)
  --runs <n>              Runs per task (default: 1)
  --policy <name>         Stand-in agent policy: ${MCP_POLICIES.join(", ")}
  --agent <name>          Only omp is supported
  --task-concurrency <n>  Must be 1; use separate run directories for parallel arms
  --list                  Print task ids as JSON and exit
  --selftest              Run every policy and print a discrimination table
  --quiet                 Suppress progress output
  --help                  Show this help message

Examples:
  # Verify the chain and that metrics discriminate between policies
  bun adapters/mcp/cli.ts --model fake/model --selftest

  # A single arm, as the manager would launch it
  bun adapters/mcp/cli.ts --model fake/model --policy correct --output runs/mcp-correct.json
`);
}

interface SummaryRow {
	policy: McpPolicy;
	taskSuccessRate: number;
	toolSuccessRate: number;
	selectionPrecision: number;
	relevanceF1: number;
	callsPerTask: number;
	collisionErrors: number;
	toolNameCompliance: number;
}

function formatRow(row: SummaryRow): string {
	const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
	return `${row.policy.padEnd(16)} task=${pct(row.taskSuccessRate).padStart(4)} tool=${pct(row.toolSuccessRate).padStart(4)} selP=${pct(row.selectionPrecision).padStart(4)} relF1=${pct(row.relevanceF1).padStart(4)} calls/task=${row.callsPerTask.toFixed(2)} dropped=${row.collisionErrors} names=${pct(row.toolNameCompliance)}`;
}

/** Execute an MCP benchmark and materialize its native artifact. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { values } = parseArgs({
		args: argv,
		options: {
			model: { type: "string" },
			mode: { type: "string" },
			suite: { type: "string" },
			"harness-source": { type: "string" },
			"expected-source-digest": { type: "string" },
			"expected-base-commit": { type: "string" },
			"base-url": { type: "string" },
			"model-profile": { type: "string" },
			"api-key-env": { type: "string", default: "MCP_BENCH_API_KEY" },
			"timeout-ms": { type: "string", default: "60000" },
			"max-requests": { type: "string", default: "8" },
			"max-tool-calls": { type: "string", default: "16" },
			"max-output-tokens": { type: "string", default: "1024" },
			temperature: { type: "string", default: "0" },
			"budget-usd": { type: "string", default: "1" },
			"max-timeout-failures": { type: "string" },
			"max-consecutive-timeouts": { type: "string" },
			"unknown-usage-reserve-usd": { type: "string" },
			output: { type: "string" },
			tasks: { type: "string" },
			"max-tasks": { type: "string", default: "0" },
			runs: { type: "string", default: "1" },
			"task-concurrency": { type: "string", default: "1" },
			policy: { type: "string" },
			agent: { type: "string" },
			quiet: { type: "boolean", default: false },
			list: { type: "boolean", default: false },
			selftest: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
		strict: true,
	});

	if (values.help) {
		printUsage();
		return;
	}

	const mode = values.mode ?? (values.selftest || values.policy ? "deterministic" : "agent");
	if (mode !== "agent" && mode !== "deterministic") fail("--mode must be agent or deterministic");
	if (values.selftest && mode !== "deterministic") fail("--selftest requires deterministic mode");
	if (values.policy && mode !== "deterministic") fail("--policy is a simulation control, not a real agent option");
	if (values.agent && values.agent !== "omp") fail("This adapter supports the OMP agent only");
	if (parsePositiveInt(values["task-concurrency"], "--task-concurrency", 1) !== 1)
		fail("MCP trials currently require --task-concurrency 1; parallel arms use separate run directories");
	if (values.suite !== undefined && mode !== "agent") fail("Versioned agent suites require agent mode");
	const suite = parseAgentSuite(values.suite);
	const suiteTasks = tasksForSuite(suite);
	if (values.list) {
		const listed =
			mode === "agent"
				? suiteTasks.map(task => ({ id: task.id, name: task.id }))
				: MCP_TASKS.map(task => ({ id: task.id, name: task.name }));
		process.stdout.write(`${JSON.stringify(listed)}\n`);
		return;
	}
	const hasTimeoutPolicy = [
		values["max-timeout-failures"],
		values["max-consecutive-timeouts"],
		values["unknown-usage-reserve-usd"],
	].some(value => value !== undefined);
	if (hasTimeoutPolicy && mode !== "agent") fail("Timeout policy requires agent mode");
	const timeoutPolicy = parseTimeoutPolicy(
		hasTimeoutPolicy
			? {
					mode: "continue",
					maxTimeoutFailures: Number(values["max-timeout-failures"]),
					maxConsecutiveTimeouts: Number(values["max-consecutive-timeouts"]),
					unknownUsageReserveUsd: Number(values["unknown-usage-reserve-usd"]),
				}
			: undefined,
	);
	if (mode === "agent") {
		if (!values.model) fail("Agent mode requires --model provider/model");
		const modelProfile = values["model-profile"]
			? parseModelProfile(await Bun.file(values["model-profile"]).json(), values.model)
			: undefined;
		const limit = Number(values["max-tasks"]);
		if (!Number.isSafeInteger(limit) || limit < 0) fail("Invalid --max-tasks");
		const wanted = values.tasks ? new Set(values.tasks.split(",").map(id => id.trim())) : undefined;
		let tasks = wanted ? suiteTasks.filter(task => wanted.has(task.id)) : suiteTasks;
		if (wanted && wanted.size !== tasks.length) fail("Unknown agent task id; use --mode agent --list");
		if (!wanted && limit > 0) tasks = tasks.slice(0, limit);
		const cancellation = new AbortController();
		const cancel = () => cancellation.abort();
		process.on("SIGTERM", cancel);
		process.on("SIGINT", cancel);
		try {
			const result = await runAgentBenchmark(
				tasks,
				{
					suite,
					model: values.model,
					...(values["base-url"] ? { baseUrl: values["base-url"] } : {}),
					...(modelProfile === undefined ? {} : { modelProfile }),
					source: {
						root: values["harness-source"] ?? path.resolve(import.meta.dir, "../../../.."),
						...(values["expected-source-digest"]
							? { expectedSourceDigest: values["expected-source-digest"] }
							: {}),
						...(values["expected-base-commit"] ? { expectedBaseCommit: values["expected-base-commit"] } : {}),
					},
					runsPerTask: parsePositiveInt(values.runs, "--runs", 1),
					apiKeyEnv: values["api-key-env"],
					timeoutMs: parsePositiveInt(values["timeout-ms"], "--timeout-ms", 60_000),
					maxRequests: parsePositiveInt(values["max-requests"], "--max-requests", 8),
					maxToolCalls: parsePositiveInt(values["max-tool-calls"], "--max-tool-calls", 16),
					maxOutputTokens: parsePositiveInt(values["max-output-tokens"], "--max-output-tokens", 1024),
					temperature: Number(values.temperature),
					budgetUsd: Number(values["budget-usd"]),
					timeoutPolicy,
					signal: cancellation.signal,
					onProgress: values.quiet
						? undefined
						: (taskId, run, done, total) => {
								const location = run.output?.diagnostics?.timeout;
								log(
									`[${done}/${total}] ${taskId} #${run.runIndex + 1}: ${run.success ? "PASS" : (run.error ?? (run.grade && "outcome" in run.grade ? run.grade.outcome : "FAIL"))}; ${(run.duration / 1000).toFixed(2)}s; requests=${run.output?.requests ?? "unknown"}; tools=${run.output?.calls.length ?? "unknown"}${location ? `; timeout=${location.phase}/${location.requestPhase ?? "n/a"}` : ""}`,
								);
							},
				},
				values.output ?? path.join("runs", `mcp-agent-${Date.now()}`, "result.json"),
			);
			if (!values.quiet)
				log(
					`Agent benchmark: ${result.status}; attempted=${result.summary.completedRuns}/${result.summary.totalRuns}; passed=${result.summary.successfulRuns}; timeouts=${result.summary.timeoutRuns}; unknownUsage=${result.summary.unknownUsageRuns}; reported estimate=$${result.summary.costUsd.toFixed(6)}; unmetered reserve=$${result.summary.unknownUsageReserveUsd.toFixed(6)}; usageComplete=${result.summary.usageComplete}; stopReason=${result.stopReason ?? "none"}; source=${result.execution.sourceDigest}`,
				);
			if (result.status !== "complete") process.exitCode = 1;
		} finally {
			process.off("SIGTERM", cancel);
			process.off("SIGINT", cancel);
		}
		return;
	}
	if (values["model-profile"]) fail("A model profile requires agent mode, not a deterministic policy simulation");
	if (values["harness-source"] || values["expected-source-digest"] || values["expected-base-commit"])
		fail("Source binding requires agent mode, not a deterministic policy simulation");

	const runsPerTask = parsePositiveInt(values.runs, "--runs", 1);
	const tasks = selectTasks(values);
	const policy = parsePolicy(values.policy);
	const outputPath = values.output ?? path.join("runs", "mcp-result.json");
	const quiet = values.quiet === true;

	// Selftest: run every policy and show that the metrics separate them.
	if (values.selftest) {
		log("MCP Benchmark — policy discrimination selftest");
		log("============================================");
		const rows: SummaryRow[] = [];
		for (const candidate of MCP_POLICIES) {
			const result = await runMcpBenchmark(
				tasks,
				{ policy: candidate, runsPerTask, fakeServerPath: FAKE_SERVER },
				outputPath,
			);
			rows.push({ policy: candidate, ...result.summary });
		}
		for (const row of rows) log(formatRow(row));
		const distinct = new Set(rows.map(row => `${row.taskSuccessRate}|${row.collisionErrors}|${row.callsPerTask}`))
			.size;
		log();
		log(
			distinct > 1
				? `OK: metrics discriminate (${distinct} distinct outcomes).`
				: "FAIL: metrics did not move across policies.",
		);
		if (distinct <= 1) process.exitCode = 1;
		return;
	}

	if (!quiet) {
		log("MCP Benchmark");
		log("=============");
		log(`Model: ${values.model ?? "(deterministic)"}`);
		log(`Policy: ${policy}`);
		log(`Runs per task: ${runsPerTask}`);
		log(`Tasks: ${tasks.length}`);
		log(`Report: ${outputPath}`);
		log();
	}

	const result = await runMcpBenchmark(
		tasks,
		{
			policy,
			runsPerTask,
			fakeServerPath: FAKE_SERVER,
			dumpDir: path.dirname(outputPath),
			onProgress: quiet
				? undefined
				: (taskId, runIndex, success) => log(`  ${taskId} run ${runIndex + 1}: ${success ? "pass" : "fail"}`),
		},
		outputPath,
	);

	if (!quiet) {
		log();
		log(formatRow({ policy, ...result.summary }));
		log(`Report written to: ${outputPath}`);
	}
}

if (import.meta.main) {
	main().catch(error => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
}
