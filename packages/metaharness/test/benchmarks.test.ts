import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BENCHMARK_DEFINITIONS, readBenchmarkSnapshot } from "../src/benchmarks";

const cleanups: string[] = [];

function jobDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-benchmark-"));
	cleanups.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("benchmark adapters", () => {
	it("normalizes edit attempts, traces, tokens, and declared metrics", () => {
		const dir = jobDir();
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({
				tasks: [
					{
						id: "rename-symbol",
						name: "Rename symbol",
						runs: [
							{
								runIndex: 0,
								success: true,
								duration: 1200,
								tokens: { input: 100, output: 20, reasoning: 5 },
							},
						],
					},
				],
				summary: {
					totalRuns: 1,
					successfulRuns: 1,
					taskSuccessRate: 1,
					editSuccessRate: 0.75,
					totalTokens: { input: 100, output: 20 },
				},
			}),
		);

		const snapshot = readBenchmarkSnapshot("edit", dir);
		expect(snapshot.metrics).toEqual({ task_success_rate: 1, edit_success_rate: 0.75 });
		expect(snapshot.traces[0]).toMatchObject({
			name: "rename-symbol__1",
			status: "pass",
			tracePath: path.join("result.dump", "rename-symbol", "run-1.md"),
		});
		expect([snapshot.tokIn, snapshot.tokOut]).toEqual([100, 20]);
	});

	it("normalizes SnapCompact records and weighted quality metrics", () => {
		const dir = jobDir();
		fs.writeFileSync(
			path.join(dir, "records.jsonl"),
			`${JSON.stringify({ cond: "text", chunk: 0, pos_rel: 0.2, q: "q", answer: "a", golds: ["a"], em: 1, f1: 1 })}\n`,
		);
		fs.writeFileSync(
			path.join(dir, "summary.json"),
			JSON.stringify({
				rows: [
					{ n: 2, f1: 0.75, em: 0.5, cost_usd: 1.25, tokens_in: 200, tokens_out: 30, cache_w: 10, cache_r: 20 },
				],
			}),
		);

		const snapshot = readBenchmarkSnapshot("snapcompact", dir);
		expect(snapshot.metrics).toEqual({ f1: 0.75, exact_match: 0.5 });
		expect(snapshot.traces[0]).toMatchObject({ status: "pass", reward: 1, tracePath: "record:1" });
		expect(snapshot.costUsd).toBe(1.25);
		expect(snapshot.tokCache).toBe(30);
	});

	it("normalizes MCP tool-call stats, selection precision, and collisions", () => {
		const dir = jobDir();
		fs.writeFileSync(
			path.join(dir, "result.json"),
			JSON.stringify({
				tasks: [
					{
						id: "search-basic",
						name: "Search the paper index",
						runs: [
							{
								runIndex: 0,
								success: true,
								duration: 12,
								tokens: { input: 0, output: 0, reasoning: 0 },
								toolCalls: { "paper-search-alpha::search_papers": { calls: 1, successes: 1, failures: 0 } },
								expected: { called: ["search_papers"], forbiddenCalled: ["get_paper"] },
								collisionErrors: 0,
							},
						],
					},
				],
				summary: {
					totalRuns: 1,
					successfulRuns: 1,
					taskSuccessRate: 1,
					toolSuccessRate: 1,
					selectionPrecision: 1,
					relevanceF1: 0.8,
					callsPerTask: 1,
					collisionErrors: 0,
					toolNameCompliance: 1,
					totalTokens: { input: 0, output: 0 },
				},
			}),
		);

		const snapshot = readBenchmarkSnapshot("mcp", dir);
		// toStrictEqual (not toEqual): a missing summary field must fail loudly
		// rather than silently normalise to undefined.
		expect(snapshot.metrics).toStrictEqual({
			task_success_rate: 1,
			tool_success_rate: 1,
			selection_precision: 1,
			relevance_f1: 0.8,
			calls_per_task: 1,
			collision_errors: 0,
			tool_name_compliance: 1,
		});
		expect(snapshot.traces[0]).toMatchObject({
			name: "search-basic__1",
			status: "pass",
			tracePath: path.join("result.dump", "search-basic", "run-1.md"),
		});
	});

	it("publishes metric definitions for every managed benchmark", () => {
		expect(BENCHMARK_DEFINITIONS.map(definition => definition.kind)).toEqual([
			"harbor",
			"edit",
			"snapcompact",
			"mcp",
		]);
		expect(BENCHMARK_DEFINITIONS.every(definition => definition.metrics.length > 0)).toBe(true);
	});
});
