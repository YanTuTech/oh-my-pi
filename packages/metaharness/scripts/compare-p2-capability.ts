#!/usr/bin/env bun
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../adapters/mcp/agent-protocol";
import type { AgentBenchmarkResult } from "../adapters/mcp/agent-runner";
import { CHALLENGE_TASKS } from "../adapters/mcp/challenge-cases";
import { reviewChallengeResult } from "./review-mcp-challenge";

export interface P2ComparisonIdentity {
	source: string;
	driver: string;
	dependencies: string;
	runtimePlatform: string;
	bunVersion: string;
	suite: string | undefined;
	model: string;
	tasks: string;
	fixture: string | undefined;
	evaluator: string;
	controls: string;
	scheduling: string;
}
function identity(result: AgentBenchmarkResult): P2ComparisonIdentity {
	return {
		source: result.execution.sourceDigest,
		driver: result.execution.driverDigest,
		dependencies: result.execution.dependencyLockDigest,
		runtimePlatform: result.execution.platform,
		bunVersion: result.execution.bunVersion,
		suite: result.evaluation.suite,
		model: result.evaluation.model,
		tasks: result.evaluation.tasksetDigest,
		fixture: result.evaluation.fixtureDigest,
		evaluator: result.evaluation.evaluatorDigest,
		controls: result.evaluation.controlsDigest,
		scheduling: result.evaluation.schedulingDigest,
	};
}

/** A changed task/grader/model/budget is not evidence for a P2-only intervention. */
export function assertP2Comparable(baseline: P2ComparisonIdentity, candidate: P2ComparisonIdentity): void {
	if (baseline.suite !== "mcp-challenge-v2" || candidate.suite !== baseline.suite)
		throw new Error("P2 comparison requires v2");
	for (const key of [
		"driver",
		"dependencies",
		"runtimePlatform",
		"bunVersion",
		"model",
		"tasks",
		"fixture",
		"evaluator",
		"controls",
		"scheduling",
	] as const) {
		if (baseline[key] === undefined || baseline[key] !== candidate[key])
			throw new Error(`P2 comparison differs in ${key}; do not compare these runs`);
	}
	if (baseline.source === candidate.source) throw new Error("P2 candidate did not change the runtime source");
}

function behavioralMetrics(result: AgentBenchmarkResult) {
	return ["collision-victim", "collision-both", "search-revision", "search-secondary"].map(family => {
		const tasks = result.tasks.filter(task => task.id.startsWith(`${family}-`));
		const runs = tasks.flatMap(task => task.runs);
		let targetTupleWrongSource = 0;
		for (const task of tasks) {
			const definition = CHALLENGE_TASKS.find(item => item.id === task.id);
			if (!definition) throw new Error("Unknown task");
			for (const run of task.runs)
				for (const call of run.output?.calls ?? []) {
					if (call.origin.tool !== "get_record" || !isRecord(call.args)) continue;
					const args = call.args;
					const matches = definition.targets.filter(
						target => target.record.id === args.id && target.record.revision === args.revision,
					);
					if (matches.length > 0 && matches.every(target => target.source !== call.origin.server))
						targetTupleWrongSource += 1;
				}
		}
		return {
			family,
			attempted: runs.length,
			planned: tasks.length * result.evaluation.scheduling.runsPerTask,
			completed: runs.filter(run => run.success).length,
			honestUnavailable: runs.filter(
				run => run.grade && "outcome" in run.grade && run.grade.outcome === "honest-unavailable",
			).length,
			wrongSourceTrials: runs.filter(
				run => run.grade && "outcome" in run.grade && run.grade.outcome === "wrong-source",
			).length,
			targetTupleWrongSource,
			toolCalls: runs.reduce((sum, run) => sum + (run.output?.calls.length ?? 0), 0),
			toolErrors: runs.reduce((sum, run) => sum + (run.output?.calls.filter(call => call.isError).length ?? 0), 0),
			modelRequests: runs.reduce((sum, run) => sum + (run.output?.requests ?? 0), 0),
			durationMs: runs.reduce((sum, run) => sum + run.duration, 0),
		};
	});
}

export async function compareP2Results(baselinePath: string, candidatePath: string) {
	if (path.resolve(baselinePath) === path.resolve(candidatePath))
		throw new Error("Baseline and candidate must be distinct evidence");
	const [baselineReview, candidateReview] = await Promise.all([
		reviewChallengeResult(baselinePath),
		reviewChallengeResult(candidatePath),
	]);
	const baseline: AgentBenchmarkResult = await Bun.file(baselinePath).json();
	const candidate: AgentBenchmarkResult = await Bun.file(candidatePath).json();
	assertP2Comparable(identity(baseline), identity(candidate));
	if (
		!isDeepStrictEqual(
			baseline.tasks.map(task => task.id),
			candidate.tasks.map(task => task.id),
		)
	)
		throw new Error("Task order changed");
	let inventoriesUnchanged = true;
	for (const [index, task] of candidate.tasks.entries()) {
		const original = baseline.tasks[index].runs[0]?.output?.inventory;
		const sorted = (items: typeof original) => items?.map(item => JSON.stringify(item)).sort();
		for (const run of task.runs)
			if (!isDeepStrictEqual(sorted(run.output?.inventory), sorted(original))) inventoriesUnchanged = false;
	}
	const baselineMetrics = behavioralMetrics(baseline),
		candidateMetrics = behavioralMetrics(candidate);
	const normalCandidate = candidateMetrics.filter(row => row.family.startsWith("search-"));
	const allAttempted =
		candidateReview.executed === candidateReview.planned && baselineReview.executed === baselineReview.planned;
	const metered = baselineReview.usageComplete && candidateReview.usageComplete;
	const collision = candidateMetrics.filter(row => row.family.startsWith("collision-"));
	const developmentCriteriaMet =
		allAttempted &&
		metered &&
		inventoriesUnchanged &&
		candidate.summary.executionErrors === 0 &&
		normalCandidate.every(row => row.completed === row.planned) &&
		collision.every(
			row =>
				row.wrongSourceTrials === 0 && row.targetTupleWrongSource === 0 && row.honestUnavailable === row.planned,
		);
	const report = {
		version: 1,
		design: "historical-baseline-development-comparison",
		automaticPromotion: false,
		baseline: {
			resultSha256: baselineReview.resultSha256,
			source: baseline.execution.sourceDigest,
			summary: baseline.summary,
			metrics: baselineMetrics,
		},
		candidate: {
			resultSha256: candidateReview.resultSha256,
			source: candidate.execution.sourceDigest,
			summary: candidate.summary,
			metrics: candidateMetrics,
		},
		allAttempted,
		usageComplete: metered,
		inventoriesUnchanged,
		developmentCriteriaMet,
		verdict:
			!allAttempted || !metered || candidate.summary.executionErrors > 0
				? "incomplete-evidence"
				: developmentCriteriaMet
					? "meets-development-criteria"
					: "needs-review",
		limitations: [
			"Not a randomized/interleaved A/B; execution time and provider conditions differ.",
			"Honest unavailability is not successful task completion. Notifications do not restore missing tools.",
			"Tuple misrouting is derived from recorded task targets/arguments and is not a change to the frozen grader.",
			"Prices are frozen catalog estimates, not Go bills or subscription quota receipts.",
		],
	};
	return report;
}

if (import.meta.main) {
	const [baseline, candidate] = process.argv.slice(2);
	if (!baseline || !candidate || process.argv.length !== 4)
		throw new Error("Usage: bun scripts/compare-p2-capability.ts <baseline/result.json> <candidate/result.json>");
	const report = await compareP2Results(baseline, candidate);
	const root = path.dirname(path.resolve(candidate));
	await Bun.write(path.join(root, "p2-comparison.json"), JSON.stringify(report, null, 2));
	const lines = [
		"# P2 capability-notice development comparison",
		"",
		`Verdict: ${report.verdict}`,
		`All planned trials attempted: ${report.allAttempted}; usage complete: ${report.usageComplete}`,
		`Inventories unchanged: ${report.inventoriesUnchanged}`,
		"",
		"| Family | Base complete | Candidate complete | Base wrong-source trials | Candidate wrong-source trials | Base tuple misroutes | Candidate tuple misroutes |",
		"|---|---:|---:|---:|---:|---:|---:|",
	];
	for (const [index, row] of report.candidate.metrics.entries()) {
		const old = report.baseline.metrics[index];
		lines.push(
			`| ${row.family} | ${old.completed}/${old.planned} | ${row.completed}/${row.planned} | ${old.wrongSourceTrials} | ${row.wrongSourceTrials} | ${old.targetTupleWrongSource} | ${row.targetTupleWrongSource} |`,
		);
	}
	lines.push(
		"",
		...report.limitations.map(item => `- ${item}`),
		"",
		"No automatic code adoption, commit or product-bundle promotion was performed.",
	);
	await Bun.write(path.join(root, "p2-comparison.md"), `${lines.join("\n")}\n`);
	process.stdout.write(
		`${JSON.stringify({ verdict: report.verdict, allAttempted: report.allAttempted, inventoriesUnchanged: report.inventoriesUnchanged, candidate: report.candidate.metrics }, null, 2)}\n`,
	);
	if (report.verdict !== "meets-development-criteria") process.exitCode = 1;
}
