import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type HarnessExecution,
	type HarnessSourceRequest,
	type PreparedHarness,
	prepareHarness,
	sha256,
	verifyPreparedHarness,
} from "../../src/harness-source";
import { type AgentInput, type AgentOutput, parseAgentInput, parseAgentOutput } from "./agent-protocol";
import {
	canContinueTimeout,
	parseTimeoutPolicy,
	type SchedulingControls,
	type TimeoutPolicy,
	timeoutLimitReason,
} from "./agent-scheduling";
import {
	type AgentSuite,
	type BenchmarkGrade,
	type BenchmarkTask,
	gradeBenchmarkTask,
	isChallengeTask,
	parseAgentSuite,
	suiteSourceDigests,
	toBenchmarkInput,
	validateSuiteTasks,
} from "./agent-suites";
import type { ChallengeGrade } from "./challenge-cases";

export interface AgentRunConfig extends Omit<AgentInput, "version" | "prompt" | "servers"> {
	source: HarnessSourceRequest;
	suite?: AgentSuite;
	runsPerTask: number;
	apiKeyEnv: string;
	/** Stop scheduling new trials after this much observed spend. Request/output caps also apply. */
	budgetUsd: number;
	timeoutPolicy?: TimeoutPolicy;
	signal?: AbortSignal;
	/** Console-only progress; it does not participate in grading or experiment identity. */
	onProgress?: (taskId: string, run: AgentRun, done: number, total: number) => void;
}

export interface AgentRun {
	runIndex: number;
	success: boolean;
	error?: string;
	duration: number;
	grade: BenchmarkGrade | null;
	output: AgentOutput | null;
	usageComplete: boolean;
	/** Explicit allowance for unreported usage; never added to measured costUsd. */
	unknownUsageReserveUsd: number;
	tokens: AgentOutput["tokens"];
	costUsd: number;
	toolCalls: Record<string, { calls: number; successes: number; failures: number }>;
	collisionErrors: number;
	toolNameCompliance: number;
}

export interface AgentBenchmarkResult {
	version: 1;
	mode: "agent";
	execution: HarnessExecution;
	evaluation: {
		/** Absent in historical v1 runs; new runs always bind an explicit suite and fixture digest. */
		suite?: AgentSuite;
		fixtureDigest?: string;
		model: string;
		tasksetDigest: string;
		evaluatorDigest: string;
		controlsDigest: string;
		controls: Omit<AgentInput, "version" | "prompt" | "servers">;
		scheduling: SchedulingControls;
		schedulingDigest: string;
	};
	/** complete-with-errors means every planned trial was attempted, not that every trial passed. */
	status: "running" | "complete" | "complete-with-errors" | "failed" | "cancelled" | "budget-exhausted";
	stopReason: string | null;
	tasks: { id: string; name: string; runs: AgentRun[] }[];
	summary: {
		totalRuns: number;
		completedRuns: number;
		successfulRuns: number;
		taskSuccessRate: number;
		toolSuccessRate: number;
		selectionPrecision: null;
		relevanceF1: null;
		callsPerTask: number;
		collisionErrors: number;
		toolNameCompliance: number;
		totalTokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
		costUsd: number;
		usageComplete: boolean;
		unexecutedRuns: number;
		taskFailures: number;
		executionErrors: number;
		timeoutRuns: number;
		unknownUsageRuns: number;
		unknownUsageReserveUsd: number;
		budgetAccountedUsd: number;
		outcomes?: Record<ChallengeGrade["outcome"], number>;
	};
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maxBytes) throw new Error("Agent driver exceeded its protocol output limit");
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const buffer = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(buffer);
}

/** One fresh process/session/workspace per trial, with a deadline covering setup and cleanup. */
export async function executeAgent(
	prepared: PreparedHarness,
	input: AgentInput,
	cwd: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<AgentOutput> {
	signal?.throwIfAborted();
	parseAgentInput(input);
	await verifyPreparedHarness(prepared);
	await fs.mkdir(cwd, { recursive: true });
	const isolated = await fs.realpath(cwd);
	const executable = path.join(prepared.runtimeDir, prepared.execution.entrypoint);
	const entrypoint = prepared.execution.files.find(file => file.path === prepared.execution.entrypoint);
	if (!entrypoint) throw new Error("Prepared harness entrypoint is missing");
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: isolated,
		USERPROFILE: isolated,
		TMPDIR: isolated,
		XDG_CONFIG_HOME: isolated,
		XDG_CACHE_HOME: isolated,
		XDG_DATA_HOME: isolated,
		MCP_BENCH_API_KEY: apiKey,
		PI_NO_TITLE: "1",
		NO_COLOR: "1",
	};
	// Only transport configuration, never ambient provider keys or agent config.
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	const child = Bun.spawn([process.execPath, executable], {
		cwd: isolated,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		detached: process.platform !== "win32",
	});
	let interrupted: "timeout" | "cancelled" | undefined;
	const killOwnedGroup = () => {
		try {
			if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
			else child.kill("SIGKILL");
		} catch {
			/* The owned group has already exited. */
		}
	};
	const cancel = () => {
		interrupted = "cancelled";
		killOwnedGroup();
	};
	const deadline = setTimeout(() => {
		interrupted = "timeout";
		killOwnedGroup();
	}, input.timeoutMs + 5_000);
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted) cancel();
	try {
		child.stdin.write(JSON.stringify(input));
		child.stdin.end();
		const [stdout, , exitCode] = await Promise.all([
			readBounded(child.stdout, 1_048_576),
			readBounded(child.stderr, 131_072),
			child.exited,
		]);
		if (interrupted) throw new Error(`Agent ${interrupted}`);
		if (exitCode !== 0) throw new Error(`Agent driver exited with code ${exitCode}`);
		const output = parseAgentOutput(JSON.parse(stdout));
		if (output.entrypointDigest !== entrypoint.sha256) throw new Error("Agent loaded a different executable");
		await verifyPreparedHarness(prepared);
		return output;
	} finally {
		clearTimeout(deadline);
		signal?.removeEventListener("abort", cancel);
		killOwnedGroup();
		await child.exited;
	}
}

function summarize(result: AgentBenchmarkResult): void {
	const runs = result.tasks.flatMap(task => task.runs);
	const calls = runs.flatMap(run => run.output?.calls ?? []);
	const summary = result.summary;
	if (result.evaluation.suite === "mcp-challenge-v2") {
		summary.outcomes = {
			completed: 0,
			"honest-unavailable": 0,
			"wrong-source": 0,
			"unsupported-answer": 0,
			"incorrect-result": 0,
			"execution-error": 0,
		};
		for (const run of runs) {
			const outcome = run.error
				? "execution-error"
				: run.grade && "outcome" in run.grade
					? run.grade.outcome
					: "execution-error";
			summary.outcomes[outcome] += 1;
		}
	}
	summary.completedRuns = runs.length;
	summary.successfulRuns = runs.filter(run => run.success).length;
	summary.unexecutedRuns = summary.totalRuns - runs.length;
	summary.taskFailures = runs.filter(run => !run.success && !run.error).length;
	summary.executionErrors = runs.filter(run => run.error !== undefined).length;
	summary.timeoutRuns = runs.filter(run => run.output?.stop === "timeout").length;
	summary.unknownUsageRuns = runs.filter(run => !run.usageComplete).length;
	summary.unknownUsageReserveUsd = runs.reduce((sum, run) => sum + run.unknownUsageReserveUsd, 0);
	// Scheduled denominator: a crash/cancel may not inflate the score by dropping hard trials.
	summary.taskSuccessRate = summary.totalRuns > 0 ? summary.successfulRuns / summary.totalRuns : 0;
	summary.toolSuccessRate = calls.length > 0 ? calls.filter(call => !call.isError).length / calls.length : 0;
	summary.callsPerTask = runs.length > 0 ? calls.length / runs.length : 0;
	summary.collisionErrors = runs.reduce((sum, run) => sum + run.collisionErrors, 0);
	summary.toolNameCompliance =
		runs.length > 0 ? runs.reduce((sum, run) => sum + run.toolNameCompliance, 0) / runs.length : 0;
	summary.costUsd = runs.reduce((sum, run) => sum + run.costUsd, 0);
	summary.budgetAccountedUsd = summary.costUsd + summary.unknownUsageReserveUsd;
	summary.usageComplete = runs.length === summary.totalRuns && runs.every(run => run.usageComplete);
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
		summary.totalTokens[key] = runs.reduce((sum, run) => sum + run.tokens[key], 0);
}

async function writeResult(result: AgentBenchmarkResult, outputPath: string): Promise<void> {
	summarize(result);
	const temporary = `${outputPath}.tmp`;
	await Bun.write(temporary, JSON.stringify(result, null, 2));
	await fs.rename(temporary, outputPath);
}

export async function runAgentBenchmark(
	tasks: BenchmarkTask[],
	config: AgentRunConfig,
	outputPath: string,
): Promise<AgentBenchmarkResult> {
	tasks = structuredClone(tasks);
	const suite = parseAgentSuite(config.suite ?? (tasks.some(isChallengeTask) ? "mcp-challenge-v2" : "mcp-smoke-v1"));
	validateSuiteTasks(tasks, suite);
	if (
		tasks.length === 0 ||
		!Number.isSafeInteger(config.runsPerTask) ||
		config.runsPerTask < 1 ||
		config.runsPerTask > 100
	)
		throw new Error("A benchmark needs tasks and 1..100 attempts");
	if (
		new Set(tasks.map(task => task.id)).size !== tasks.length ||
		tasks.some(task => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(task.id))
	)
		throw new Error("Invalid or duplicate benchmark task id");
	for (const task of tasks) parseAgentInput(toBenchmarkInput(task, config));
	config.signal?.throwIfAborted();
	const timeoutPolicy = parseTimeoutPolicy(config.timeoutPolicy);
	if (!/^[A-Z_][A-Z0-9_]*$/.test(config.apiKeyEnv)) throw new Error("Invalid credential environment variable name");
	if (!Number.isFinite(config.budgetUsd) || config.budgetUsd <= 0) throw new Error("Invalid benchmark budget");
	const apiKey = process.env[config.apiKeyEnv];
	if (!apiKey)
		throw new Error(`Model credential unavailable: set ${config.apiKeyEnv} in the current process environment`);
	const jobDir = path.resolve(path.dirname(outputPath));
	await fs.mkdir(jobDir, { recursive: true });
	if (await Bun.file(outputPath).exists())
		throw new Error("Agent benchmark output already exists; use a fresh run directory");
	const prepared = await prepareHarness(
		config.source,
		await fs.realpath(jobDir),
		path.resolve(import.meta.dir, "../.."),
	);
	const controls = {
		model: config.model,
		...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
		...(config.modelProfile === undefined ? {} : { modelProfile: structuredClone(config.modelProfile) }),
		timeoutMs: config.timeoutMs,
		maxRequests: config.maxRequests,
		maxToolCalls: config.maxToolCalls,
		maxOutputTokens: config.maxOutputTokens,
		temperature: config.temperature,
	};
	const scheduling: SchedulingControls = {
		runsPerTask: config.runsPerTask,
		budgetUsd: config.budgetUsd,
		order: "task-major",
		timeoutPolicy,
	};
	const suiteIdentity = await suiteSourceDigests(suite);
	const result: AgentBenchmarkResult = {
		version: 1,
		mode: "agent",
		execution: prepared.execution,
		evaluation: {
			suite,
			...suiteIdentity,
			model: config.model,
			tasksetDigest: sha256(JSON.stringify(tasks)),
			controlsDigest: sha256(JSON.stringify(controls)),
			controls,
			scheduling,
			schedulingDigest: sha256(JSON.stringify(scheduling)),
		},
		status: "running",
		stopReason: null,
		tasks: tasks.map(task => ({ id: task.id, name: task.id, runs: [] })),
		summary: {
			totalRuns: tasks.length * config.runsPerTask,
			completedRuns: 0,
			successfulRuns: 0,
			taskSuccessRate: 0,
			toolSuccessRate: 0,
			selectionPrecision: null,
			relevanceF1: null,
			callsPerTask: 0,
			collisionErrors: 0,
			toolNameCompliance: 0,
			totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			costUsd: 0,
			usageComplete: false,
			unexecutedRuns: tasks.length * config.runsPerTask,
			taskFailures: 0,
			executionErrors: 0,
			timeoutRuns: 0,
			unknownUsageRuns: 0,
			unknownUsageReserveUsd: 0,
			budgetAccountedUsd: 0,
		},
	};
	await writeResult(result, outputPath);
	let consecutiveTimeouts = 0;
	for (const [taskIndex, task] of tasks.entries()) {
		for (let runIndex = 0; runIndex < config.runsPerTask; runIndex++) {
			const limitReason = timeoutLimitReason(result.summary.timeoutRuns, consecutiveTimeouts, timeoutPolicy);
			if (
				config.signal?.aborted ||
				result.status === "failed" ||
				limitReason ||
				result.summary.budgetAccountedUsd >= config.budgetUsd
			) {
				if (config.signal?.aborted) {
					result.status = "cancelled";
					result.stopReason = "user-cancelled";
				} else if (result.status !== "failed") {
					result.status = limitReason ? "failed" : "budget-exhausted";
					result.stopReason = limitReason ?? "accounted-budget-exhausted";
				}
				await writeResult(result, outputPath);
				return result;
			}
			const started = Date.now();
			const run: AgentRun = {
				runIndex,
				success: false,
				duration: 0,
				grade: null,
				output: null,
				usageComplete: false,
				unknownUsageReserveUsd: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
				costUsd: 0,
				toolCalls: {},
				collisionErrors: 0,
				toolNameCompliance: 0,
			};
			try {
				const output = await executeAgent(
					prepared,
					toBenchmarkInput(task, controls),
					path.join(jobDir, "work", task.id, `run-${runIndex + 1}`),
					apiKey,
					config.signal,
				);
				run.output = output;
				run.grade = gradeBenchmarkTask(task, output);
				run.success = run.grade.passed;
				run.tokens = output.tokens;
				run.costUsd = output.costUsd;
				run.usageComplete = output.stop === "completed" && output.usageComplete;
				run.collisionErrors = output.collisionErrors;
				run.toolNameCompliance =
					output.inventory.length === 0
						? 1
						: output.inventory.filter(tool => /^[a-zA-Z0-9_-]{1,64}$/.test(tool.wireName)).length /
							output.inventory.length;
				for (const call of output.calls) {
					run.toolCalls[call.wireName] ??= { calls: 0, successes: 0, failures: 0 };
					const stats = run.toolCalls[call.wireName];
					stats.calls += 1;
					if (call.isError) stats.failures += 1;
					else stats.successes += 1;
				}
				const cleanupFailed = (output.diagnostics?.cleanupErrors.length ?? 0) > 0;
				if (output.stop !== "completed" || !output.usageComplete || cleanupFailed) {
					run.error =
						output.stop !== "completed" ? output.stop : cleanupFailed ? "cleanup-failed" : "usage-incomplete";
					run.success = false;
					if (config.signal?.aborted || cleanupFailed || !canContinueTimeout(output, timeoutPolicy)) {
						result.status = config.signal?.aborted ? "cancelled" : "failed";
						result.stopReason = run.error;
					}
				}
			} catch (error) {
				run.error = error instanceof Error ? error.message : "Agent trial failed";
				// Identity/protocol/exit failures never qualify for timeout continuation.
				result.status = config.signal?.aborted ? "cancelled" : "failed";
				result.stopReason = config.signal?.aborted ? "user-cancelled" : "execution-integrity-or-process-error";
			}
			if (!run.usageComplete && timeoutPolicy.mode === "continue")
				run.unknownUsageReserveUsd = timeoutPolicy.unknownUsageReserveUsd;
			consecutiveTimeouts = run.output?.stop === "timeout" ? consecutiveTimeouts + 1 : 0;
			run.duration = Date.now() - started;
			result.tasks[taskIndex].runs.push(run);
			await Bun.write(
				path.join(jobDir, "result.dump", task.id, `run-${runIndex + 1}.md`),
				`# ${task.id}\n\n\`\`\`json\n${JSON.stringify(run, null, 2)}\n\`\`\`\n`,
			);
			await writeResult(result, outputPath);
			try {
				config.onProgress?.(task.id, run, result.summary.completedRuns, result.summary.totalRuns);
			} catch {
				/* A console observer cannot alter the saved verdict. */
			}
		}
	}
	if (config.signal?.aborted) {
		result.status = "cancelled";
		result.stopReason = "user-cancelled";
	} else if (result.status === "running")
		result.status = result.summary.executionErrors > 0 ? "complete-with-errors" : "complete";
	await writeResult(result, outputPath);
	return result;
}
