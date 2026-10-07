/** Benchmark adapters normalize native artifacts into manager runs and traces. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentBenchmarkResult } from "../adapters/mcp/agent-runner";
import { type HarnessExecution, parseHarnessExecution } from "./harness-source";
import { aggregate, readJobResult, readTrials } from "./runner";
import type { BenchmarkKind } from "./store";

/** Describes a benchmark metric so storage and UI do not hard-code benchmark semantics. */
export interface MetricDefinition {
	key: string;
	label: string;
	format: "percent" | "number" | "usd";
	higherIsBetter: boolean;
}

/** Adapter metadata exposed to launch clients and the headless API. */
export interface BenchmarkDefinition {
	kind: BenchmarkKind;
	label: string;
	metrics: MetricDefinition[];
}

/** Built-in benchmark adapters and their native score definitions. */
export const BENCHMARK_DEFINITIONS: BenchmarkDefinition[] = [
	{
		kind: "harbor",
		label: "Harbor",
		metrics: [{ key: "success_rate", label: "Success rate", format: "percent", higherIsBetter: true }],
	},
	{
		kind: "edit",
		label: "TypeScript edit",
		metrics: [
			{ key: "task_success_rate", label: "Task success", format: "percent", higherIsBetter: true },
			{ key: "edit_success_rate", label: "Edit success", format: "percent", higherIsBetter: true },
		],
	},
	{
		kind: "snapcompact",
		label: "SnapCompact",
		metrics: [
			{ key: "f1", label: "F1", format: "percent", higherIsBetter: true },
			{ key: "exact_match", label: "Exact match", format: "percent", higherIsBetter: true },
		],
	},
	{
		kind: "mcp",
		label: "MCP tool use",
		metrics: [
			{ key: "task_success_rate", label: "Task success", format: "percent", higherIsBetter: true },
			{ key: "tool_success_rate", label: "Tool success", format: "percent", higherIsBetter: true },
			{ key: "selection_precision", label: "Tool selection P", format: "percent", higherIsBetter: true },
			{ key: "relevance_f1", label: "Relevance detection", format: "percent", higherIsBetter: true },
			{ key: "calls_per_task", label: "Calls per task", format: "number", higherIsBetter: false },
			{ key: "collision_errors", label: "Names dropped by collision", format: "number", higherIsBetter: false },
			{ key: "tool_name_compliance", label: "Wire-name compliance", format: "percent", higherIsBetter: true },
			{ key: "trial_coverage", label: "Trials attempted", format: "percent", higherIsBetter: true },
			{ key: "execution_errors", label: "Execution errors", format: "number", higherIsBetter: false },
			{ key: "timeout_runs", label: "Timeout trials", format: "number", higherIsBetter: false },
			{ key: "unexecuted_runs", label: "Unexecuted trials", format: "number", higherIsBetter: false },
			{ key: "unknown_usage_runs", label: "Unmetered trials", format: "number", higherIsBetter: false },
			{ key: "budget_accounted_usd", label: "Estimate + reserves", format: "usd", higherIsBetter: false },
		],
	},
];

/** A normalized trace emitted by any benchmark adapter. */
export interface BenchmarkTrace {
	name: string;
	task: string;
	status: "pass" | "fail" | "error" | "running";
	reward: number | null;
	costUsd: number;
	durationMs: number;
	detail: string;
	tracePath: string | null;
}

export interface BenchmarkEvidence {
	mode: "agent" | "deterministic";
	execution: HarnessExecution | null;
	evaluation: AgentBenchmarkResult["evaluation"] | null;
	suiteStatus?: string | null;
	stopReason?: string | null;
	usageComplete: boolean;
}

/** Uniform aggregate and traces read from benchmark-native artifacts. */
export interface BenchmarkSnapshot {
	evidence?: BenchmarkEvidence;
	traces: BenchmarkTrace[];
	total: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	costUsd: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	score: number | null;
	metrics: Record<string, number | null>;
}

interface EditRun {
	runIndex: number;
	success: boolean;
	error?: string;
	duration: number;
	tokens: { input: number; output: number; reasoning: number };
	toolCalls?: { read: number; edit: number; write: number };
}

interface EditTask {
	id: string;
	name: string;
	runs: EditRun[];
}

interface EditResult {
	tasks: EditTask[];
	summary: {
		totalRuns: number;
		successfulRuns: number;
		taskSuccessRate: number;
		editSuccessRate: number;
		totalTokens: { input: number; output: number };
	};
}

interface SnapRecord {
	cond: string;
	chunk: number;
	pos_rel: number;
	q: string;
	answer: string;
	golds: string[];
	em: number;
	f1: number;
}

interface SnapSummaryRow {
	n: number;
	f1: number;
	em: number;
	cost_usd: number;
	tokens_in: number;
	tokens_out: number;
	cache_w: number;
	cache_r: number;
}

interface SnapSummary {
	rows: SnapSummaryRow[];
}

function emptySnapshot(): BenchmarkSnapshot {
	return {
		traces: [],
		total: 0,
		done: 0,
		pass: 0,
		fail: 0,
		error: 0,
		running: 0,
		costUsd: 0,
		tokIn: 0,
		tokOut: 0,
		tokCache: 0,
		score: null,
		metrics: {},
	};
}

function readEditSnapshot(jobDir: string): BenchmarkSnapshot {
	const file = path.join(jobDir, "result.json");
	if (!fs.existsSync(file)) return emptySnapshot();
	const result: EditResult = JSON.parse(fs.readFileSync(file, "utf8"));
	const traces: BenchmarkTrace[] = [];
	let tokIn = 0;
	let tokOut = 0;
	for (const task of result.tasks) {
		for (const run of task.runs) {
			tokIn += run.tokens.input;
			tokOut += run.tokens.output;
			const runNumber = run.runIndex + 1;
			traces.push({
				name: `${task.id}__${runNumber}`,
				task: task.id,
				status: run.success ? "pass" : run.error ? "error" : "fail",
				reward: run.success ? 1 : 0,
				costUsd: 0,
				durationMs: run.duration,
				detail: JSON.stringify({ name: task.name, error: run.error ?? null, tools: run.toolCalls ?? null }),
				tracePath: path.join("result.dump", task.id.replace(/[^a-zA-Z0-9._-]/g, "_"), `run-${runNumber}.md`),
			});
		}
	}
	const pass = traces.filter(trace => trace.status === "pass").length;
	const error = traces.filter(trace => trace.status === "error").length;
	return {
		traces,
		total: result.summary.totalRuns,
		done: traces.length,
		pass,
		fail: traces.length - pass,
		error,
		running: Math.max(0, result.summary.totalRuns - traces.length),
		costUsd: 0,
		tokIn,
		tokOut,
		tokCache: 0,
		score: result.summary.taskSuccessRate,
		metrics: {
			task_success_rate: result.summary.taskSuccessRate,
			edit_success_rate: result.summary.editSuccessRate,
		},
	};
}

function readSnapcompactSnapshot(jobDir: string): BenchmarkSnapshot {
	const recordsFile = path.join(jobDir, "records.jsonl");
	const summaryFile = path.join(jobDir, "summary.json");
	if (!fs.existsSync(recordsFile)) return emptySnapshot();
	const records = fs
		.readFileSync(recordsFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as SnapRecord);
	const traces = records.map(
		(record, index): BenchmarkTrace => ({
			name: `${record.cond}__${record.chunk}__${index + 1}`,
			task: `${record.cond}:${record.chunk}`,
			status: record.f1 > 0 ? "pass" : "fail",
			reward: record.f1,
			costUsd: 0,
			durationMs: 0,
			detail: JSON.stringify({ question: record.q, answer: record.answer, golds: record.golds, em: record.em }),
			tracePath: `record:${index + 1}`,
		}),
	);
	let rows: SnapSummaryRow[] = [];
	if (fs.existsSync(summaryFile)) {
		const summary: SnapSummary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
		rows = summary.rows;
	}
	const samples = rows.reduce((sum, row) => sum + row.n, 0);
	const weightedF1 = rows.reduce((sum, row) => sum + row.f1 * row.n, 0);
	const weightedEm = rows.reduce((sum, row) => sum + row.em * row.n, 0);
	const pass = traces.filter(trace => trace.status === "pass").length;
	return {
		traces,
		total: traces.length,
		done: traces.length,
		pass,
		fail: traces.length - pass,
		error: 0,
		running: 0,
		costUsd: rows.reduce((sum, row) => sum + row.cost_usd, 0),
		tokIn: rows.reduce((sum, row) => sum + row.tokens_in, 0),
		tokOut: rows.reduce((sum, row) => sum + row.tokens_out, 0),
		tokCache: rows.reduce((sum, row) => sum + row.cache_w + row.cache_r, 0),
		score: samples > 0 ? weightedF1 / samples : null,
		metrics: {
			f1: samples > 0 ? weightedF1 / samples : null,
			exact_match: samples > 0 ? weightedEm / samples : null,
		},
	};
}

/**
 * Generic per-tool call statistics. The edit adapter hard-codes `{read, edit,
 * write}`; MCP and skill runs need arbitrary tool identities, so the reader
 * accepts any tool-name key.
 */
export interface ToolCallStat {
	calls: number;
	successes: number;
	failures: number;
}

interface McpRun {
	costUsd?: number;
	usageComplete?: boolean;
	grade?: unknown;
	output?: unknown;
	runIndex: number;
	success: boolean;
	error?: string;
	duration: number;
	tokens: { input: number; output: number; reasoning: number };
	toolCalls?: Record<string, ToolCallStat>;
	/** Tools the task expected to be called, and tools it explicitly forbade. */
	expected?: { called?: string[]; forbiddenCalled?: string[] };
	/** Tools dropped by name-collision arbitration during this run. */
	collisionErrors?: number;
	/** Fraction of minted wire names that satisfy the strictest provider validator. */
	toolNameCompliance?: number;
}

interface McpTask {
	id: string;
	name: string;
	runs: McpRun[];
}

interface McpResult {
	version?: number;
	mode?: "agent" | "deterministic";
	execution?: unknown;
	evaluation?: AgentBenchmarkResult["evaluation"];
	status?: string;
	stopReason?: string | null;
	tasks: McpTask[];
	summary: {
		totalRuns: number;
		successfulRuns: number;
		taskSuccessRate: number;
		toolSuccessRate: number;
		selectionPrecision: number | null;
		relevanceF1: number | null;
		costUsd?: number;
		usageComplete?: boolean;
		unknownUsageRuns?: number;
		timeoutRuns?: number;
		budgetAccountedUsd?: number;
		callsPerTask: number;
		collisionErrors: number;
		toolNameCompliance: number;
		totalTokens: { input: number; output: number };
	};
}

function readMcpSnapshot(jobDir: string): BenchmarkSnapshot {
	const file = path.join(jobDir, "result.json");
	if (!fs.existsSync(file)) return emptySnapshot();
	const result: McpResult = JSON.parse(fs.readFileSync(file, "utf8"));
	if (result.mode !== undefined && result.mode !== "agent" && result.mode !== "deterministic")
		throw new Error("Unknown MCP evaluation mode");
	const realAgent = result.mode === "agent";
	const execution = realAgent ? parseHarnessExecution(result.execution) : null;
	if (
		realAgent &&
		(result.version !== 1 ||
			!result.evaluation ||
			![result.evaluation.tasksetDigest, result.evaluation.evaluatorDigest, result.evaluation.controlsDigest].every(
				digest => /^[a-f0-9]{64}$/.test(digest),
			) ||
			typeof result.summary.usageComplete !== "boolean" ||
			typeof result.summary.costUsd !== "number" ||
			!Number.isFinite(result.summary.costUsd))
	)
		throw new Error("Incomplete agent evaluation provenance");
	const traces: BenchmarkTrace[] = [];
	let tokIn = 0;
	let tokOut = 0;
	for (const task of result.tasks) {
		for (const run of task.runs) {
			tokIn += run.tokens.input;
			tokOut += run.tokens.output;
			const runNumber = run.runIndex + 1;
			traces.push({
				name: `${task.id}__${runNumber}`,
				task: task.id,
				status: run.success ? "pass" : run.error ? "error" : "fail",
				reward: run.success ? 1 : 0,
				costUsd: realAgent ? (run.costUsd ?? 0) : 0,
				durationMs: run.duration,
				detail: JSON.stringify({
					name: task.name,
					error: run.error ?? null,
					tools: run.toolCalls ?? null,
					...(realAgent
						? { mode: "agent", grade: run.grade, output: run.output, usageComplete: run.usageComplete }
						: {}),
					expected: run.expected ?? null,
					collisionErrors: run.collisionErrors ?? 0,
				}),
				tracePath: path.join("result.dump", task.id.replace(/[^a-zA-Z0-9._-]/g, "_"), `run-${runNumber}.md`),
			});
		}
	}
	const pass = traces.filter(trace => trace.status === "pass").length;
	const error = traces.filter(trace => trace.status === "error").length;
	return {
		evidence: {
			mode: realAgent ? "agent" : "deterministic",
			execution,
			evaluation: realAgent ? (result.evaluation ?? null) : null,
			usageComplete: realAgent && result.summary.usageComplete === true,
			...(realAgent ? { suiteStatus: result.status ?? null, stopReason: result.stopReason ?? null } : {}),
		},
		traces,
		total: result.summary.totalRuns,
		done: traces.length,
		pass,
		fail: traces.length - pass,
		error,
		running: realAgent && result.status !== "running" ? 0 : Math.max(0, result.summary.totalRuns - traces.length),
		costUsd: realAgent ? (result.summary.costUsd ?? 0) : 0,
		tokIn,
		tokOut,
		tokCache: realAgent ? Number((result.summary.totalTokens as Record<string, number>).cacheRead ?? 0) : 0,
		score: result.summary.taskSuccessRate,
		metrics: {
			task_success_rate: result.summary.taskSuccessRate,
			tool_success_rate: result.summary.toolSuccessRate,
			selection_precision: result.summary.selectionPrecision,
			relevance_f1: result.summary.relevanceF1,
			calls_per_task: result.summary.callsPerTask,
			collision_errors: result.summary.collisionErrors,
			tool_name_compliance: result.summary.toolNameCompliance,
			...(realAgent
				? {
						trial_coverage: result.summary.totalRuns > 0 ? traces.length / result.summary.totalRuns : null,
						execution_errors: error,
						unexecuted_runs: Math.max(0, result.summary.totalRuns - traces.length),
						timeout_runs: result.summary.timeoutRuns ?? null,
						unknown_usage_runs: result.summary.unknownUsageRuns ?? null,
						budget_accounted_usd: result.summary.budgetAccountedUsd ?? null,
					}
				: {}),
		},
	};
}

/** Read and normalize the latest artifacts for a benchmark run. */
export function readBenchmarkSnapshot(benchmark: BenchmarkKind, jobDir: string): BenchmarkSnapshot {
	if (benchmark === "edit") return readEditSnapshot(jobDir);
	if (benchmark === "snapcompact") return readSnapcompactSnapshot(jobDir);
	if (benchmark === "mcp") return readMcpSnapshot(jobDir);
	const trials = readTrials(jobDir);
	const job = readJobResult(jobDir);
	const totals = aggregate(trials, job, job?.nTotal ?? trials.length);
	return {
		traces: trials.map(trial => ({
			name: trial.name,
			task: trial.name.replace(/__[^_]+$/, ""),
			status: trial.status,
			reward: trial.reward,
			costUsd: trial.costUsd,
			durationMs: trial.durationMs,
			detail: trial.detail,
			tracePath: path.join(trial.name, "agent", "omp.txt"),
		})),
		total: totals.total,
		done: totals.done,
		pass: totals.pass,
		fail: totals.fail,
		error: totals.error,
		running: totals.running,
		costUsd: totals.costUsd,
		tokIn: totals.tokIn,
		tokOut: totals.tokOut,
		tokCache: totals.tokCache,
		score: totals.done > 0 ? totals.pass / totals.done : null,
		metrics: { success_rate: totals.done > 0 ? totals.pass / totals.done : null },
	};
}
