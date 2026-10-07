import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "../adapters/mcp/agent-protocol";
import type { AgentBenchmarkResult } from "../adapters/mcp/agent-runner";
import { CHALLENGE_TASKS, gradeChallengeTask } from "../adapters/mcp/challenge-cases";
import { createLibraryWorld } from "../adapters/mcp/challenge-data";
import { reviewChallengeResult } from "../scripts/review-mcp-challenge";
import { parseHarnessExecution, sha256, verifyPreparedHarness } from "../src/harness-source";

function streamResponse(delta: Record<string, unknown>, finishReason: string): Response {
	const chunk = {
		id: "chatcmpl-v2-test",
		object: "chat.completion.chunk",
		created: 1,
		model: "deepseek-v4.1-flash",
		choices: [{ index: 0, delta, finish_reason: null }],
	};
	const terminal = {
		...chunk,
		choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
		usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

/** Protocol peer derives reads/answers from actual MCP results, not from the grading answer key. */
function respond(body: unknown): Response {
	if (!isRecord(body) || !Array.isArray(body.messages) || !Array.isArray(body.tools))
		return new Response("invalid wire", { status: 400 });
	const userText = body.messages
		.filter(message => isRecord(message) && message.role === "user")
		.map(message => JSON.stringify(message))
		.join("\n");
	if (userText.includes("specifically from library.tools"))
		return streamResponse(
			{ role: "assistant", content: '{"status":"unavailable","sources":["library.tools"]}' },
			"stop",
		);
	const results: Record<string, unknown>[] = [];
	for (const message of body.messages) {
		if (!isRecord(message) || message.role !== "tool" || typeof message.content !== "string") continue;
		const payload: unknown = JSON.parse(message.content);
		if (isRecord(payload)) results.push(payload);
	}
	const readResult = results.find(result => isRecord(result.record));
	if (readResult && isRecord(readResult.record)) {
		const record = readResult.record;
		return streamResponse(
			{
				role: "assistant",
				content: JSON.stringify({
					status: "ok",
					source: readResult.source,
					id: record.id,
					revision: record.revision,
					checksum: record.checksum,
				}),
			},
			"stop",
		);
	}
	const searchResult = results.find(result => Array.isArray(result.records));
	const world = createLibraryWorld(17, "primary");
	let toolName: string;
	let args: Record<string, unknown>;
	if (searchResult && Array.isArray(searchResult.records)) {
		const matches = searchResult.records.filter(record => isRecord(record) && record.year === world.year);
		const selected = matches.reduce<Record<string, unknown> | null>(
			(best, record) =>
				isRecord(record) && (!best || Number(record.revision) > Number(best.revision)) ? record : best,
			null,
		);
		if (!selected) return new Response("no result to read", { status: 400 });
		toolName = "get_record";
		args = { id: selected.id, revision: selected.revision };
	} else {
		toolName = "search_records";
		args = { query: world.topic, year: world.year };
	}
	const tool = body.tools.find(
		item =>
			isRecord(item) &&
			isRecord(item.function) &&
			typeof item.function.name === "string" &&
			item.function.name.endsWith(toolName),
	);
	if (!isRecord(tool) || !isRecord(tool.function)) return new Response("required tool missing", { status: 400 });
	return streamResponse(
		{
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: `call-${toolName}`,
					type: "function",
					function: {
						name: tool.function.name,
						arguments: JSON.stringify({ ...args, i: "Follow the requested retrieval dependency" }),
					},
				},
			],
		},
		"tool_calls",
	);
}

test("CLI v2 runs the actual frozen agent and fixture, persists grounded search and honest collision failure separately", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-v2-cli-")));
	const packageDir = path.resolve(import.meta.dir, "..");
	const wire: { body: unknown; session: string | null; url: string }[] = [];
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body: unknown = await request.json();
			wire.push({ body, session: request.headers.get("x-opencode-session"), url: new URL(request.url).pathname });
			return respond(body);
		},
	});
	try {
		const profile = {
			provider: "opencode-go",
			id: "deepseek-v4.1-flash",
			name: "V4.1 test",
			api: "openai-completions",
			baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			reasoning: true,
			input: ["text"],
			contextWindow: 1000000,
			maxTokens: 384000,
			cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
		};
		await Bun.write(path.join(root, "profile.json"), JSON.stringify(profile));
		const resultPath = path.join(root, "job", "result.json");
		const child = Bun.spawn(
			[
				process.execPath,
				"adapters/mcp/cli.ts",
				"--mode",
				"agent",
				"--suite",
				"mcp-challenge-v2",
				"--model",
				"opencode-go/deepseek-v4.1-flash",
				"--model-profile",
				path.join(root, "profile.json"),
				"--harness-source",
				path.resolve(packageDir, "../.."),
				"--tasks",
				"search-revision-17,collision-victim-17",
				"--runs",
				"1",
				"--timeout-ms",
				"15000",
				"--output",
				resultPath,
			],
			{
				cwd: packageDir,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: root,
					XDG_CONFIG_HOME: root,
					XDG_CACHE_HOME: root,
					XDG_DATA_HOME: root,
					MCP_BENCH_API_KEY: "fixture-not-a-real-key",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const deadline = setTimeout(() => child.kill("SIGKILL"), 45000);
		let exit: number, stderr: string;
		try {
			[exit, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
				new Response(child.stdout).text(),
			]);
		} finally {
			clearTimeout(deadline);
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
		}
		expect({ exit, stderr }).toMatchObject({ exit: 0 });
		const result: AgentBenchmarkResult = await Bun.file(resultPath).json();
		expect(result.evaluation.suite).toBe("mcp-challenge-v2");
		expect(result.evaluation.fixtureDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(result.summary).toMatchObject({
			totalRuns: 2,
			completedRuns: 2,
			successfulRuns: 1,
			taskFailures: 1,
			executionErrors: 0,
			usageComplete: true,
			outcomes: { completed: 1, "honest-unavailable": 1 },
		});
		const search = result.tasks.find(task => task.id === "search-revision-17")?.runs[0].output;
		const victim = result.tasks.find(task => task.id === "collision-victim-17")?.runs[0];
		if (!search || !victim) throw new Error("Missing actual trial outputs");
		expect(search.calls.map(call => call.origin.tool)).toStrictEqual(["search_records", "get_record"]);
		expect(Number(search.calls[0].completedOrder)).toBeLessThan(Number(search.calls[1].startedOrder));
		expect(victim).toMatchObject({
			success: false,
			grade: { outcome: "honest-unavailable" },
			output: { collisionErrors: 2 },
		});
		for (const task of result.tasks) {
			const definition = CHALLENGE_TASKS.find(item => item.id === task.id);
			if (!definition || !task.runs[0].output) throw new Error("Missing definition/output");
			expect(gradeChallengeTask(definition, task.runs[0].output)).toStrictEqual(task.runs[0].grade);
		}
		const firstSearch = wire.find(request => JSON.stringify(request.body).includes("Search catalog-main"));
		const searchTask = CHALLENGE_TASKS.find(task => task.id === "search-revision-17");
		if (!firstSearch || !searchTask) throw new Error("Missing first model request");
		expect(JSON.stringify(firstSearch.body)).not.toContain(searchTask.targets[0].record.id);
		expect(JSON.stringify(firstSearch.body)).not.toContain(searchTask.targets[0].record.checksum);
		expect(wire).toHaveLength(4);
		for (const request of wire) {
			expect(request.url).toBe("/v1/chat/completions");
			expect(request.session).toBeTruthy();
			expect(request.body).toMatchObject({ model: "deepseek-v4.1-flash" });
		}
		const preparations = (await fs.readdir(path.dirname(resultPath))).filter(name => name.startsWith("harness-"));
		const execution = parseHarnessExecution(result.execution);
		await verifyPreparedHarness({
			runtimeDir: path.join(path.dirname(resultPath), preparations[0], "runtime"),
			execution,
		});
		expect(sha256(JSON.stringify(result.evaluation.controls))).toBe(result.evaluation.controlsDigest);
		expect(await Bun.file(resultPath).text()).not.toContain("fixture-not-a-real-key");
		const review = await reviewChallengeResult(resultPath);
		expect(review).toMatchObject({
			executed: 2,
			passed: 1,
			artifactHashesVerified: true,
			outcomes: { "honest-unavailable": 1 },
		});
		const modified = structuredClone(result);
		modified.summary.outcomes = { ...modified.summary.outcomes!, "honest-unavailable": 0, completed: 2 };
		const alteredPath = path.join(root, "job", "tampered.json");
		await Bun.write(alteredPath, JSON.stringify(modified));
		await expect(reviewChallengeResult(alteredPath)).rejects.toThrow("behavior outcome counts");
		modified.evaluation.evaluatorDigest = "f".repeat(64);
		await Bun.write(alteredPath, JSON.stringify(modified));
		await expect(reviewChallengeResult(alteredPath)).rejects.toThrow("evaluator source changed");
	} finally {
		await provider.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60000);

test("REST keeps the v2 dataset and honest-unavailable grade in persisted runs instead of showing v1 success", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-v2-rest-")));
	const provider = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			return respond(await request.json());
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
			MCP_BENCH_API_KEY: "fixture-not-a-real-key",
		},
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	let base = "";
	try {
		const readyPath = path.join(root, "ready.json");
		const startupDeadline = Date.now() + 10000;
		let port: number | undefined;
		while (port === undefined && child.exitCode === null && Date.now() < startupDeadline) {
			try {
				const ready: unknown = JSON.parse(await fs.readFile(readyPath, "utf8"));
				if (!isRecord(ready) || typeof ready.port !== "number") throw new Error("Invalid manager readiness");
				port = ready.port;
			} catch (error) {
				if (!isRecord(error) || error.code !== "ENOENT") throw error;
				await Bun.sleep(25);
			}
		}
		if (port === undefined) {
			child.kill("SIGTERM");
			await child.exited;
			throw new Error(`Isolated manager did not start: ${await stderr}`);
		}
		base = `http://127.0.0.1:${port}`;
		const launch = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				benchmark: "mcp",
				model: "deepseek/deepseek-v4-flash",
				jobName: "v2-contract",
				include: ["collision-victim-17"],
				attempts: 1,
				harnessSource: { root: path.resolve(import.meta.dir, "../../..") },
				mcp: {
					mode: "agent",
					suite: "mcp-challenge-v2",
					baseUrl: `http://127.0.0.1:${provider.port}/v1`,
					timeoutMs: 15000,
				},
			}),
		});
		expect(launch.status).toBe(201);
		const until = Date.now() + 30000;
		let terminal: Record<string, unknown> | undefined;
		while (Date.now() < until) {
			const body: unknown = await (await fetch(`${base}/api/runs/v2-contract`)).json();
			if (isRecord(body) && isRecord(body.run) && body.run.status !== "running") {
				terminal = body;
				break;
			}
			await Bun.sleep(50);
		}
		expect(terminal).toMatchObject({
			run: {
				dataset: "mcp-challenge-v2",
				pass: 0,
				done: 1,
				score: 0,
				evidence: { evaluation: { suite: "mcp-challenge-v2" } },
			},
		});
		if (
			!terminal ||
			!Array.isArray(terminal.traces) ||
			!isRecord(terminal.traces[0]) ||
			typeof terminal.traces[0].detail !== "string"
		)
			throw new Error("Missing persisted v2 trace");
		expect(JSON.parse(terminal.traces[0].detail)).toMatchObject({
			grade: { passed: false, outcome: "honest-unavailable" },
		});
		const native: AgentBenchmarkResult = await Bun.file(path.join(root, "v2-contract", "result.json")).json();
		expect(native.summary).toMatchObject({
			successfulRuns: 0,
			taskFailures: 1,
			outcomes: { "honest-unavailable": 1 },
		});
	} finally {
		if (base) await fetch(`${base}/api/runs/v2-contract/cancel`, { method: "POST" }).catch(() => {});
		child.kill("SIGTERM");
		await child.exited;
		await stderr;
		await provider.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60000);
