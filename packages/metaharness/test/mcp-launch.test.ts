import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mcpRunnerArgs } from "../src/launch-args";
import { resolveArmLaunch } from "../src/server";
import { type RunRow, RunStore } from "../src/store";

const model = "deepseek/deepseek-v4-flash";

describe("MCP launch contracts", () => {
	test("structured source and model controls reach the CLI while raw overrides are rejected", () => {
		const args = mcpRunnerArgs(
			{
				model,
				harnessSource: { root: "/candidate", expectedSourceDigest: "a".repeat(64) },
				mcp: { mode: "agent", maxRequests: 3 },
			},
			"/jobs/variant",
		);
		expect(args).toStrictEqual([
			"--mode",
			"agent",
			"--model",
			model,
			"--output",
			"/jobs/variant/result.json",
			"--max-requests",
			"3",
			"--harness-source",
			"/candidate",
			"--expected-source-digest",
			"a".repeat(64),
		]);
		expect(() => mcpRunnerArgs({ model, extraArgs: ["--output", "/different/result.json"] }, "/job")).toThrow(
			"extraArgs",
		);
		expect(() =>
			mcpRunnerArgs({ model, mcp: { mode: "deterministic" }, harnessSource: { root: "/candidate" } }, "/job"),
		).toThrow("requires MCP agent mode");
		expect(() => mcpRunnerArgs({ model, concurrency: 2 }, "/job")).toThrow("concurrency");
	});

	test("new agent arms require an explicit candidate instead of inheriting baseline code", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-arm-contract-"));
		const store = new RunStore(root);
		try {
			store.registerLaunch({
				benchmark: "mcp",
				jobName: "binding-base",
				dataset: "mcp-agent-v1",
				agent: "omp",
				models: [model],
				pid: 0,
				config: {
					include: ["no-tool-needed"],
					attempts: 2,
					harnessSource: { root: "/baseline" },
					mcp: { mode: "agent", maxRequests: 3 },
				},
			});
			expect(() => resolveArmLaunch(store, "binding", { arm: "variant", model })).toThrow("explicit harnessSource");
			const launch = resolveArmLaunch(store, "binding", {
				arm: "variant",
				model,
				harnessSource: { root: "/candidate" },
				harness: { layers: ["prompt"], variantId: "candidate" },
			});
			expect(launch).toMatchObject({
				include: ["no-tool-needed"],
				attempts: 2,
				harnessSource: { root: "/candidate" },
				mcp: { mode: "agent", maxRequests: 3 },
				harness: { variantId: "candidate" },
			});
		} finally {
			store.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("evidence migration is idempotent and does not turn old labels into measured identities", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-migration-"));
		const dbPath = path.join(root, "old.sqlite");
		let store = new RunStore(root, dbPath);
		try {
			store.registerLaunch({
				benchmark: "mcp",
				jobName: "old-run",
				dataset: "mcp-tools",
				agent: "omp",
				models: ["fake/model"],
				pid: 0,
				harness: { variantId: "old", layers: ["mcp"], patchDigest: "caller-claim" },
			});
			store.close();
			const db = new Database(dbPath);
			db.run("ALTER TABLE runs DROP COLUMN evidence_json");
			db.close();
			store = new RunStore(root, dbPath);
			expect(store.getRun("old-run")).toMatchObject({ evidence: null, harness: { patchDigest: "caller-claim" } });
			store.close();
			store = new RunStore(root, dbPath);
			expect(store.getRun("old-run")?.evidence).toBeNull();
		} finally {
			store.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

test("REST launches a real agent, persists measured evidence, and retains scheduled denominators on budget stop", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-manager-agent-")));
	const wireCounts = new Map<string, number>();
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			await request.json();
			const scenario = new URL(request.url).pathname.split("/")[1];
			const seen = (wireCounts.get(scenario) ?? 0) + 1;
			wireCounts.set(scenario, seen);
			if (
				(["wire-timeout", "wire-reserve", "wire-stop-default"].includes(scenario) && seen === 1) ||
				scenario === "wire-consecutive"
			) {
				const pending = Promise.withResolvers<Response>();
				const abort = () => pending.resolve(new Response(null, { status: 499 }));
				if (request.signal.aborted) abort();
				else request.signal.addEventListener("abort", abort, { once: true });
				return pending.promise;
			}
			if (scenario === "wire-auth")
				return Response.json(
					{ error: { message: "Fixture authentication rejected" } },
					{ status: 401, headers: { "x-request-id": "req_fixture_401", "set-cookie": "fixture-private-cookie" } },
				);
			const chunk = {
				id: "chatcmpl-manager",
				object: "chat.completion.chunk",
				created: 1,
				model: "deepseek-v4-flash",
				choices: [{ index: 0, delta: { role: "assistant", content: '{"answer":42}' }, finish_reason: null }],
			};
			const finish = {
				...chunk,
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
			};
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/manager-agent-host.ts"), root], {
		cwd: path.resolve(import.meta.dir, ".."),
		env: {
			PATH: process.env.PATH ?? "",
			HOME: root,
			XDG_CONFIG_HOME: root,
			XDG_CACHE_HOME: root,
			XDG_DATA_HOME: root,
			METAHARNESS_TEST_HOST: "1",
			MCP_BENCH_API_KEY: "test-only-fixture-key",
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const diagnostics = new Response(child.stderr).text();
	let base = "";
	const launched: string[] = [];
	try {
		const readyPath = path.join(root, "ready.json");
		const deadline = Date.now() + 10_000;
		let port: number | undefined;
		while (port === undefined && child.exitCode === null && Date.now() < deadline) {
			try {
				const ready = JSON.parse(await fs.readFile(readyPath, "utf8")) as { port: number };
				port = ready.port;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await Bun.sleep(20);
			}
		}
		if (port === undefined) {
			child.kill();
			await child.exited;
			throw new Error(`Isolated manager did not start: ${(await diagnostics).slice(-3000)}`);
		}
		base = `http://127.0.0.1:${port}`;
		const awaitTerminal = async (name: string): Promise<RunRow> => {
			const until = Date.now() + 35_000;
			while (Date.now() < until) {
				const response = await fetch(`${base}/api/runs/${name}`);
				const body = (await response.json()) as { run?: RunRow; error?: string };
				if (!response.ok || !body.run) throw new Error(body.error ?? "Missing run");
				if (body.run.status !== "running") return body.run;
				await Bun.sleep(50);
			}
			throw new Error("Agent run did not reach a terminal state");
		};
		for (const [name, attempts, budget] of [
			["wire-base", 1, 1],
			["wire-budget", 3, 0.000000001],
		] as const) {
			const response = await fetch(`${base}/api/runs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					benchmark: "mcp",
					model,
					jobName: name,
					include: ["no-tool-needed"],
					attempts,
					harness: { variantId: name, layers: ["prompt"], patchDigest: "unverified-user-label" },
					harnessSource: { root: path.resolve(import.meta.dir, "../../..") },
					mcp: {
						mode: "agent",
						baseUrl: `http://127.0.0.1:${provider.port}/v1`,
						budgetUsd: budget,
						timeoutMs: 15_000,
					},
				}),
			});
			expect(await response.json()).toMatchObject({ jobName: name });
			expect(response.status).toBe(201);
			launched.push(name);
			const run = await awaitTerminal(name);
			expect(run.evidence?.mode).toBe("agent");
			expect(run.evidence?.execution?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
			expect(run.harness?.patchDigest).toBe("unverified-user-label");
			expect(run.evidence?.execution?.sourceDigest).not.toBe(run.harness?.patchDigest);
			expect(run.evidence?.evaluation?.tasksetDigest).toMatch(/^[a-f0-9]{64}$/);
			expect(run.tokIn).toBe(100);
			expect(run.tokOut).toBe(20);
			expect(run.costUsd).toBeGreaterThan(0);
			expect(run.metrics.selection_precision).toBeNull();
			expect(run.nTotal).toBe(attempts);
			expect(run.done).toBe(1);
			expect(run.score).toBe(1 / attempts);
			expect(run.evidence?.usageComplete).toBe(attempts === 1);
			expect(run.status).toBe(attempts === 1 ? "complete" : "failed");
			const listing = (await (await fetch(`${base}/api/runs`)).json()) as RunRow[];
			expect(listing.find(item => item.jobName === name)?.evidence).toStrictEqual(run.evidence);
			const native = await Bun.file(path.join(root, name, "result.json")).text();
			expect(native).not.toContain("test-only-fixture-key");
			expect(JSON.parse(native).status).toBe(attempts === 1 ? "complete" : "budget-exhausted");
		}
		// A timeout remains a failed trial; continuing must not erase unknown usage
		// or turn repeated outages, authentication errors and budget exhaustion into success.
		for (const [name, budget, expectedStatus, attempted, passed] of [
			["wire-timeout", 1, "complete-with-errors", 3, 2],
			["wire-consecutive", 1, "failed", 2, 0],
			["wire-reserve", 0.05, "budget-exhausted", 1, 0],
			["wire-auth", 1, "failed", 1, 0],
			["wire-stop-default", 1, "failed", 1, 0],
		] as const) {
			const timeoutPolicy = {
				mode: "continue",
				maxTimeoutFailures: 3,
				maxConsecutiveTimeouts: 2,
				unknownUsageReserveUsd: 0.1,
			};
			const response = await fetch(`${base}/api/runs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					benchmark: "mcp",
					model,
					jobName: name,
					include: ["no-tool-needed"],
					attempts: 3,
					harnessSource: { root: path.resolve(import.meta.dir, "../../..") },
					mcp: {
						mode: "agent",
						baseUrl: `http://127.0.0.1:${provider.port}/${name}/v1`,
						budgetUsd: budget,
						timeoutMs: 1500,
						...(name === "wire-stop-default" ? {} : { timeoutPolicy }),
					},
				}),
			});
			expect(response.status).toBe(201);
			launched.push(name);
			const run = await awaitTerminal(name);
			const native = await Bun.file(path.join(root, name, "result.json")).json();
			expect(native.status).toBe(expectedStatus);
			expect(native.summary).toMatchObject({
				totalRuns: 3,
				completedRuns: attempted,
				successfulRuns: passed,
				unexecutedRuns: 3 - attempted,
				usageComplete: false,
			});
			expect(run.score).toBe(passed / 3);
			expect(wireCounts.get(name)).toBe(attempted); // no scheduler retries
			if (name === "wire-timeout") {
				expect(run.evidence?.suiteStatus).toBe("complete-with-errors");
				expect(run.metrics).toMatchObject({
					trial_coverage: 1,
					timeout_runs: 1,
					unknown_usage_runs: 1,
					unexecuted_runs: 0,
					execution_errors: 1,
				});
				expect(native.tasks[0].runs.map((trial: { success: boolean }) => trial.success)).toStrictEqual([
					false,
					true,
					true,
				]);
				expect(native.summary).toMatchObject({ timeoutRuns: 1, unknownUsageRuns: 1, unknownUsageReserveUsd: 0.1 });
				expect(native.evaluation.scheduling.timeoutPolicy).toStrictEqual(timeoutPolicy);
				expect(native.summary.budgetAccountedUsd).toBeCloseTo(native.summary.costUsd + 0.1, 10);
			}
			if (name === "wire-consecutive") expect(native.stopReason).toBe("consecutive-timeout-limit");
			if (name === "wire-reserve") expect(native.summary.budgetAccountedUsd).toBe(0.1);
			if (name === "wire-auth") {
				const attempt = native.tasks[0].runs[0].output.diagnostics.requests[0].httpAttempts[0];
				expect(attempt).toMatchObject({ status: 401, requestId: "req_fixture_401", outcome: "response" });
				expect(JSON.stringify(native)).not.toContain("fixture-private-cookie");
			}
		}
		// Reopen the SQLite store separately: evidence survives process-local state.
		const store = new RunStore(root);
		try {
			expect(store.getRun("wire-base")?.evidence?.mode).toBe("agent");
		} finally {
			store.close();
		}
	} finally {
		if (base) {
			for (const name of launched)
				await fetch(`${base}/api/runs/${name}/cancel`, { method: "POST" }).catch(() => {});
		}
		child.kill("SIGTERM");
		await child.exited;
		await provider.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 100_000);
