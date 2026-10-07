#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseAgentInput, parseAgentOutput } from "../adapters/mcp/agent-protocol";
import type { AgentBenchmarkResult } from "../adapters/mcp/agent-runner";
import { isChallengeTask, suiteSourceDigests, tasksForSuite, toBenchmarkInput } from "../adapters/mcp/agent-suites";
import { gradeChallengeTask } from "../adapters/mcp/challenge-cases";
import { parseHarnessExecution, sha256, verifyPreparedHarness } from "../src/harness-source";

function requireEqual(actual: unknown, expected: unknown, label: string): void {
	if (!isDeepStrictEqual(actual, expected)) throw new Error(`v2 verification failed: ${label}`);
}

/** Regrade using the matching version only; never rewrite result.json or silently substitute a new grader. */
export async function reviewChallengeResult(resultPath: string) {
	const raw = await Bun.file(resultPath).text();
	const result: AgentBenchmarkResult = JSON.parse(raw);
	if (result.version !== 1 || result.mode !== "agent" || result.evaluation?.suite !== "mcp-challenge-v2")
		throw new Error("Expected a versioned v2 agent result");
	if (!Array.isArray(result.tasks) || result.tasks.length === 0 || result.status === "running")
		throw new Error("Missing or unfinished v2 trials");
	const identity = await suiteSourceDigests("mcp-challenge-v2");
	requireEqual(
		result.evaluation.evaluatorDigest,
		identity.evaluatorDigest,
		"evaluator source changed; use the archived matching evaluator",
	);
	requireEqual(result.evaluation.fixtureDigest, identity.fixtureDigest, "fixture source changed");
	requireEqual(
		result.evaluation.controlsDigest,
		sha256(JSON.stringify(result.evaluation.controls)),
		"controls digest",
	);
	requireEqual(
		result.evaluation.schedulingDigest,
		sha256(JSON.stringify(result.evaluation.scheduling)),
		"scheduling digest",
	);
	const definitions = tasksForSuite("mcp-challenge-v2");
	const selected = result.tasks.map(task => {
		const definition = definitions.find(item => item.id === task.id);
		if (!definition || !isChallengeTask(definition)) throw new Error("Unknown v2 task");
		return definition;
	});
	if (new Set(selected.map(task => task.id)).size !== selected.length) throw new Error("Duplicate v2 task");
	requireEqual(result.evaluation.tasksetDigest, sha256(JSON.stringify(selected)), "taskset digest");
	for (const task of selected) parseAgentInput(toBenchmarkInput(task, result.evaluation.controls));
	const root = path.dirname(path.resolve(resultPath));
	const preparations = (await fs.readdir(root, { withFileTypes: true })).filter(
		entry => entry.isDirectory() && entry.name.startsWith("harness-"),
	);
	if (preparations.length !== 1) throw new Error("Expected exactly one prepared runtime");
	const preparation = path.join(root, preparations[0].name);
	const execution = parseHarnessExecution(result.execution);
	requireEqual(await Bun.file(path.join(preparation, "execution.json")).json(), execution, "execution record");
	await verifyPreparedHarness({ runtimeDir: path.join(preparation, "runtime"), execution });
	const sourceManifest: { path: string; sha256: string }[] = await Bun.file(
		path.join(preparation, "source-manifest.json"),
	).json();
	requireEqual(
		sha256(JSON.stringify([...sourceManifest].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))),
		execution.sourceDigest,
		"source manifest",
	);
	const entrypoint = execution.files.find(file => file.path === execution.entrypoint);
	const rows: {
		task: string;
		attempt: number;
		success: boolean;
		outcome: string;
		seconds: number;
		requests: number | null;
		tools: number | null;
		reasons: string[];
		usageComplete: boolean;
	}[] = [];
	const perRequest: unknown[] = [];
	const outcomes = {
		completed: 0,
		"honest-unavailable": 0,
		"wrong-source": 0,
		"unsupported-answer": 0,
		"incorrect-result": 0,
		"execution-error": 0,
	};
	for (const [taskIndex, task] of result.tasks.entries()) {
		if (!Array.isArray(task.runs) || task.runs.length > result.evaluation.scheduling.runsPerTask)
			throw new Error("Invalid trial count");
		for (const [index, run] of task.runs.entries()) {
			requireEqual(run.runIndex, index, "trial index");
			const output = run.output === null ? null : parseAgentOutput(run.output);
			const grade = output === null ? null : gradeChallengeTask(selected[taskIndex], output);
			requireEqual(run.grade, grade, "saved grade");
			if (output) {
				requireEqual(output.entrypointDigest, entrypoint?.sha256, "loaded worker");
				requireEqual(run.tokens, output.tokens, "token accounting");
				requireEqual(run.costUsd, output.costUsd, "cost accounting");
				requireEqual(run.usageComplete, output.stop === "completed" && output.usageComplete, "usage completeness");
			} else if (!run.error || run.usageComplete) throw new Error("Missing output cannot be successful or metered");
			requireEqual(
				run.success,
				grade?.passed === true && !run.error,
				"success must not credit unavailable or invalid evidence",
			);
			if (!Number.isFinite(run.duration) || run.duration < 0) throw new Error("Invalid trial duration");
			const dump = await Bun.file(path.join(root, "result.dump", task.id, `run-${index + 1}.md`)).text();
			const json = dump.match(/```json\n([\s\S]*?)\n```/);
			if (!json) throw new Error("Missing trial dump");
			requireEqual(JSON.parse(json[1]), run, "trial dump");
			const outcome = run.error
				? "execution-error"
				: grade && "outcome" in grade
					? grade.outcome
					: "execution-error";
			outcomes[outcome] += 1;
			rows.push({
				task: task.id,
				attempt: index + 1,
				success: run.success,
				outcome,
				seconds: run.duration / 1000,
				requests: output?.requests ?? null,
				tools: output?.calls.length ?? null,
				reasons: grade?.reasons ?? [run.error ?? "missing-output"],
				usageComplete: run.usageComplete,
			});
			for (const request of output?.diagnostics?.requests ?? [])
				perRequest.push({ task: task.id, attempt: index + 1, ...request });
		}
	}
	const runs = result.tasks.flatMap(task => task.runs);
	const calls = runs.flatMap(run => run.output?.calls ?? []);
	const planned = selected.length * result.evaluation.scheduling.runsPerTask;
	const summary = result.summary;
	requireEqual(summary.totalRuns, planned, "planned denominator");
	requireEqual(summary.completedRuns, rows.length, "executed count");
	requireEqual(summary.successfulRuns, rows.filter(row => row.success).length, "success count");
	requireEqual(summary.taskSuccessRate, summary.successfulRuns / planned, "success rate");
	requireEqual(summary.unexecutedRuns, planned - rows.length, "unexecuted count");
	requireEqual(summary.taskFailures, runs.filter(run => !run.success && !run.error).length, "task failures");
	requireEqual(summary.executionErrors, runs.filter(run => run.error !== undefined).length, "execution errors");
	requireEqual(summary.timeoutRuns, runs.filter(run => run.output?.stop === "timeout").length, "timeouts");
	requireEqual(summary.unknownUsageRuns, runs.filter(run => !run.usageComplete).length, "unknown usage");
	requireEqual(
		summary.usageComplete,
		rows.length === planned && rows.every(row => row.usageComplete),
		"overall usage",
	);
	requireEqual(summary.outcomes, outcomes, "behavior outcome counts");
	requireEqual(
		summary.costUsd,
		runs.reduce((sum, run) => sum + run.costUsd, 0),
		"reported cost estimate",
	);
	requireEqual(
		summary.unknownUsageReserveUsd,
		runs.reduce((sum, run) => sum + run.unknownUsageReserveUsd, 0),
		"reserve accounting",
	);
	requireEqual(summary.budgetAccountedUsd, summary.costUsd + summary.unknownUsageReserveUsd, "budget accounting");
	requireEqual(summary.callsPerTask, runs.length > 0 ? calls.length / runs.length : 0, "tool count");
	requireEqual(
		summary.toolSuccessRate,
		calls.length > 0 ? calls.filter(call => !call.isError).length / calls.length : 0,
		"tool success",
	);
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
		requireEqual(
			summary.totalTokens[key],
			runs.reduce((sum, run) => sum + run.tokens[key], 0),
			`tokens:${key}`,
		);
	return {
		version: 2,
		suite: "mcp-challenge-v2",
		model: result.evaluation.model,
		status: result.status,
		stopReason: result.stopReason,
		planned,
		executed: rows.length,
		passed: summary.successfulRuns,
		notExecuted: planned - rows.length,
		outcomes,
		usageComplete: summary.usageComplete,
		catalogEstimateUsd: summary.costUsd,
		unknownUsageReserveUsd: summary.unknownUsageReserveUsd,
		artifactHashesVerified: true,
		regraded: true,
		resultSha256: sha256(raw),
		sourceDigest: execution.sourceDigest,
		driverDigest: execution.driverDigest,
		evaluatorDigest: identity.evaluatorDigest,
		fixtureDigest: identity.fixtureDigest,
		rows,
		perRequest,
	};
}

if (import.meta.main) {
	const file = process.argv[2];
	if (!file || process.argv.length !== 3) throw new Error("Usage: bun scripts/review-mcp-challenge.ts <result.json>");
	const report = await reviewChallengeResult(file);
	const root = path.dirname(path.resolve(file));
	await Bun.write(path.join(root, "review-v2.json"), JSON.stringify(report, null, 2));
	const lines = [
		"# MCP challenge v2 review",
		"",
		`Suite: ${report.suite}`,
		`Model: ${report.model}`,
		`Status: ${report.status}; stop: ${report.stopReason ?? "none"}`,
		`Executed: ${report.executed}/${report.planned}; completed tasks: ${report.passed}`,
		`Outcomes: ${JSON.stringify(report.outcomes)}`,
		`Usage complete: ${report.usageComplete}`,
		`Catalog estimate USD: ${report.catalogEstimateUsd} (not a bill or quota receipt)`,
		`Source: ${report.sourceDigest}`,
		`Driver: ${report.driverDigest}`,
		"",
		"| Task | Attempt | Outcome | Seconds |",
		"|---|---:|---|---:|",
	];
	for (const row of report.rows)
		lines.push(`| ${row.task} | ${row.attempt} | ${row.outcome} | ${row.seconds.toFixed(3)} |`);
	lines.push(
		"",
		"Honest unavailability is not task completion. Original failures remain recorded. This is a development suite, not a held-out general-capability benchmark.",
	);
	await Bun.write(path.join(root, "review-v2.md"), `${lines.join("\n")}\n`);
	process.stdout.write(
		`${JSON.stringify({ status: report.status, executed: report.executed, planned: report.planned, passed: report.passed, outcomes: report.outcomes, usageComplete: report.usageComplete, verified: true }, null, 2)}\n`,
	);
}
