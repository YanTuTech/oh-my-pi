import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { AGENT_TASKS, gradeAgentTask, toAgentInput } from "../adapters/mcp/agent-cases";
import { DiagnosticRecorder } from "../adapters/mcp/agent-diagnostics";
import {
	type AgentOutput,
	type BenchmarkModelProfile,
	isRecord,
	parseAgentInput,
	parseAgentOutput,
	parseModelProfile,
} from "../adapters/mcp/agent-protocol";
import { executeAgent } from "../adapters/mcp/agent-runner";
import { canContinueTimeout, parseTimeoutPolicy, timeoutLimitReason } from "../adapters/mcp/agent-scheduling";
import {
	type ContentFile,
	type PreparedHarness,
	prepareHarness,
	sha256,
	verifyPreparedHarness,
} from "../src/harness-source";

const controls = {
	model: "deepseek/deepseek-v4-flash",
	timeoutMs: 20_000,
	maxRequests: 4,
	maxToolCalls: 8,
	maxOutputTokens: 512,
	temperature: 0,
};
function goProfile(baseUrl = "https://opencode.ai/zen/go/v1"): BenchmarkModelProfile {
	return {
		provider: "opencode-go",
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 384_000,
		cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
	};
}

function completed(): AgentOutput {
	return {
		version: 1,
		entrypointDigest: "a".repeat(64),
		finalText: JSON.stringify(AGENT_TASKS[0].expected),
		stop: "completed",
		requests: 2,
		calls: [
			{
				id: "call-1",
				origin: { server: "library-primary", tool: "get_record" },
				wireName: "mcp__library_primary_get_record",
				args: { id: "atlas-42" },
				result: { title: "Retrieval Under Uncertainty" },
				isError: false,
			},
		],
		inventory: [
			{ wireName: "mcp__library_primary_get_record", origin: { server: "library-primary", tool: "get_record" } },
		],
		collisionErrors: 0,
		tokens: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
		costUsd: 0.001,
		costSource: "catalog-estimate",
		usageComplete: true,
	};
}

function modelResponse(delta: Record<string, unknown>, finishReason: string): Response {
	const chunk = {
		id: "chatcmpl-fixture",
		object: "chat.completion.chunk",
		created: 1,
		model: "deepseek-v4-flash",
		choices: [{ index: 0, delta, finish_reason: null }],
	};
	const finish = {
		...chunk,
		choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
		usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function requestedRead(body: Record<string, unknown>): Record<string, unknown> {
	if (!Array.isArray(body.tools)) throw new Error("Missing provider tool schemas");
	const tool = body.tools.find(
		tool =>
			isRecord(tool) &&
			isRecord(tool.function) &&
			typeof tool.function.name === "string" &&
			tool.function.name.endsWith("get_record"),
	);
	if (!isRecord(tool) || !isRecord(tool.function)) throw new Error("Requested MCP tool missing");
	return {
		role: "assistant",
		tool_calls: [
			{
				index: 0,
				id: "call-fixture",
				type: "function",
				function: { name: tool.function.name, arguments: '{"id":"atlas-42","i":"Read the requested record"}' },
			},
		],
	};
}

describe("MCP result and evidence contracts", () => {
	test("the driver input excludes the answer key and rejects unexpected fields", () => {
		const input = toAgentInput(AGENT_TASKS[0], controls);
		expect(Object.keys(input).sort()).toStrictEqual(
			[
				"version",
				"prompt",
				"servers",
				"model",
				"timeoutMs",
				"maxRequests",
				"maxToolCalls",
				"maxOutputTokens",
				"temperature",
			].sort(),
		);
		expect(() => parseAgentInput({ ...input, expected: AGENT_TASKS[0].expected })).toThrow(
			"Unexpected agent input field",
		);
	});
	test("an explicit model profile cannot silently select a different model or credential destination", () => {
		const profile = goProfile();
		expect(() => parseModelProfile(profile, "opencode-go/deepseek-v4-flash")).toThrow("identity does not match");
		expect(() =>
			parseModelProfile({ ...profile, headers: { Authorization: "secret" } }, "opencode-go/deepseek-v4.1-flash"),
		).toThrow("Unexpected model profile field");
		expect(() =>
			parseModelProfile(
				{ ...profile, cost: { ...profile.cost, input: Number.NaN } },
				"opencode-go/deepseek-v4.1-flash",
			),
		).toThrow("Invalid model profile cost");
		expect(() =>
			parseAgentInput(
				toAgentInput(AGENT_TASKS[0], {
					...controls,
					model: "opencode-go/deepseek-v4.1-flash",
					modelProfile: profile,
					baseUrl: "https://example.invalid/v1",
				}),
			),
		).toThrow("conflicts with the frozen profile");
	});
	test("timeout continuation rejects unbounded or free unknown usage and preserves fatal boundaries", () => {
		const policy = parseTimeoutPolicy({
			mode: "continue",
			maxTimeoutFailures: 3,
			maxConsecutiveTimeouts: 2,
			unknownUsageReserveUsd: 0.1,
		});
		expect(() => parseTimeoutPolicy({ ...policy, unknownUsageReserveUsd: 0 })).toThrow(
			"positive unknown-usage reserve",
		);
		expect(() => parseTimeoutPolicy({ ...policy, maxTimeoutFailures: Infinity })).toThrow("maxTimeoutFailures");
		expect(() => parseTimeoutPolicy({ ...policy, maxConsecutiveTimeouts: 4 })).toThrow("exceeds");
		expect(timeoutLimitReason(3, 1, policy)).toBe("total-timeout-limit");
		const output = completed();
		output.stop = "timeout";
		expect(canContinueTimeout(output, policy)).toBe(false); // missing diagnostics
		const recorder = new DiagnosticRecorder();
		recorder.beginRequest();
		recorder.timeout();
		recorder.endRequest("aborted");
		recorder.phase("finished");
		output.diagnostics = recorder.data;
		expect(canContinueTimeout(output, policy)).toBe(true);
		expect(canContinueTimeout(output, parseTimeoutPolicy(undefined))).toBe(false);
		recorder.data.cleanupErrors.push("session-dispose");
		expect(canContinueTimeout(output, policy)).toBe(false);
		recorder.data.cleanupErrors.length = 0;
		for (const status of [401, 403, 429]) {
			recorder.data.requests[0].status = status;
			expect(canContinueTimeout(output, policy)).toBe(false);
		}
		recorder.data.requests[0].status = null;
		if (recorder.data.timeout) recorder.data.timeout.phase = "tools";
		expect(canContinueTimeout(output, policy)).toBe(false);
		output.stop = "provider-error";
		expect(canContinueTimeout(output, policy)).toBe(false);
	});
	test("calling the expected tool does not excuse a wrong final answer", () => {
		const output = completed();
		output.finalText = '{"id":"atlas-42","title":"invented","year":2025}';
		expect(gradeAgentTask(AGENT_TASKS[0], output)).toStrictEqual({
			passed: false,
			resultCorrect: false,
			routesCorrect: true,
			reasons: ["incorrect_final_result"],
		});
	});
	test("a correct answer without required retrieval evidence does not pass", () => {
		const output = completed();
		output.calls = [];
		expect(gradeAgentTask(AGENT_TASKS[0], output).reasons).toStrictEqual(["missing_successful_required_route"]);
	});
	test("the same short tool name from the wrong source is not credited", () => {
		const output = completed();
		output.calls[0].origin.server = "library-secondary";
		expect(gradeAgentTask(AGENT_TASKS[0], output).reasons).toStrictEqual([
			"missing_successful_required_route",
			"wrong_data_source",
		]);
	});
	test("a recovered read can pass and collision counts do not require retaining a defect", () => {
		const output = completed();
		output.calls.unshift({ ...output.calls[0], id: "failed-read", isError: true });
		output.collisionErrors = 2;
		expect(gradeAgentTask(AGENT_TASKS[0], output).passed).toBe(true);
		output.collisionErrors = 0;
		expect(gradeAgentTask(AGENT_TASKS[0], output).passed).toBe(true);
	});
	test("an incomplete provider response cannot pass even with a correct answer", () => {
		const output = completed();
		output.stop = "provider-error";
		expect(gradeAgentTask(AGENT_TASKS[0], output).reasons).toStrictEqual(["incomplete:provider-error"]);
	});
	test("missing and non-finite usage is rejected rather than reported as free execution", () => {
		expect(() => parseAgentOutput({ ...completed(), tokens: undefined })).toThrow("Missing agent usage");
		expect(() => parseAgentOutput({ ...completed(), costUsd: Number.NaN })).toThrow("Invalid agent measurement");
		expect(() => parseAgentOutput({ ...completed(), usageComplete: undefined })).toThrow(
			"Missing usage completeness evidence",
		);
	});
	test("restraint tasks reject a correct answer obtained with forbidden tool use", () => {
		const output = completed();
		output.finalText = '{"answer":42}';
		expect(gradeAgentTask(AGENT_TASKS[3], output).reasons).toStrictEqual(["forbidden_tool_use"]);
		output.calls = [];
		expect(gradeAgentTask(AGENT_TASKS[3], output).passed).toBe(true);
	});
});

describe("frozen harness and real agent integration", () => {
	let root: string;
	let prepared: PreparedHarness;
	const packageDir = path.resolve(import.meta.dir, "..");
	beforeAll(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metaharness-agent-test-")));
		prepared = await prepareHarness({ root: path.resolve(packageDir, "../..") }, root, packageDir);
	}, 120_000);
	afterAll(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	test("the real session calls the MCP server, consumes its result and produces the graded answer", async () => {
		const requests: Record<string, unknown>[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body: unknown = await request.json();
				if (isRecord(body)) requests.push(body);
				if (!isRecord(body) || !Array.isArray(body.messages) || !Array.isArray(body.tools))
					return new Response("bad request", { status: 400 });
				const hasToolResult = body.messages.some(message => isRecord(message) && message.role === "tool");
				const delta = hasToolResult
					? { role: "assistant", content: JSON.stringify(AGENT_TASKS[0].expected) }
					: requestedRead(body);
				return modelResponse(delta, hasToolResult ? "stop" : "tool_calls");
			},
		});
		try {
			const input = toAgentInput(AGENT_TASKS[0], { ...controls, baseUrl: `http://127.0.0.1:${server.port}/v1` });
			const output = await executeAgent(prepared, input, path.join(root, "trial"), "fixture-key");
			expect({
				output,
				requestShapes: requests.map(request => ({ keys: Object.keys(request), tools: request.tools })),
			}).toMatchObject({ output: { stop: "completed" } });
			expect(gradeAgentTask(AGENT_TASKS[0], output).passed).toBe(true);
			expect(output.calls.map(call => call.origin)).toStrictEqual([
				{ server: "library-primary", tool: "get_record" },
			]);
			expect(output.tokens).toMatchObject({ input: 200, output: 40, reasoning: null });
			expect(output.usageComplete).toBe(true);
			expect(requests.length).toBe(2);
			expect(JSON.stringify(requests[0])).not.toContain("Retrieval Under Uncertainty");
			expect(JSON.stringify(requests[1])).toContain("Retrieval Under Uncertainty");
			expect(output.entrypointDigest).toBe(
				sha256(await Bun.file(path.join(prepared.runtimeDir, prepared.execution.entrypoint)).bytes()),
			);
		} finally {
			await server.stop(true);
		}
	}, 40_000);

	test("OpenCode Go receives a stable session header across tool turns and a fresh identity per trial", async () => {
		const headers: { session: string | null; userAgent: string | null; path: string }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const session = request.headers.get("x-opencode-session");
				headers.push({
					session,
					userAgent: request.headers.get("user-agent"),
					path: new URL(request.url).pathname,
				});
				if (!session)
					return Response.json(
						{ error: { type: "MissingSessionID", message: "Missing x-opencode-session" } },
						{ status: 400 },
					);
				const body: unknown = await request.json();
				if (!isRecord(body) || !Array.isArray(body.input) || !Array.isArray(body.tools))
					return new Response("bad request", { status: 400 });
				const done = body.input.some(item => isRecord(item) && item.type === "function_call_output");
				const tool = body.tools.find(
					item => isRecord(item) && typeof item.name === "string" && item.name.endsWith("get_record"),
				);
				if (!isRecord(tool)) return new Response("tool missing", { status: 400 });
				const args = '{"id":"atlas-42","i":"Read the requested record"}';
				const text = JSON.stringify(AGENT_TASKS[0].expected);
				const item = done
					? {
							type: "message",
							id: "msg_go",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text, annotations: [] }],
						}
					: {
							type: "function_call",
							id: "fc_go",
							call_id: "call_go",
							name: tool.name,
							arguments: args,
							status: "completed",
						};
				const events = [
					{ type: "response.created", response: { id: "resp_go", status: "in_progress" } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: done ? { ...item, content: [] } : { ...item, arguments: "" },
					},
					...(done
						? [
								{
									type: "response.content_part.added",
									item_id: "msg_go",
									output_index: 0,
									content_index: 0,
									part: { type: "output_text", text: "", annotations: [] },
								},
								{
									type: "response.output_text.delta",
									item_id: "msg_go",
									output_index: 0,
									content_index: 0,
									delta: text,
								},
							]
						: [
								{
									type: "response.function_call_arguments.delta",
									item_id: "fc_go",
									output_index: 0,
									delta: args,
								},
								{
									type: "response.function_call_arguments.done",
									item_id: "fc_go",
									output_index: 0,
									arguments: args,
								},
							]),
					{ type: "response.output_item.done", output_index: 0, item },
					{
						type: "response.completed",
						response: {
							id: "resp_go",
							status: "completed",
							output: [item],
							usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
						},
					},
				];
				return new Response(
					events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			for (const trial of ["go-first", "go-second"]) {
				const output = await executeAgent(
					prepared,
					toAgentInput(AGENT_TASKS[0], {
						...controls,
						model: "opencode-go/deepseek-v4-flash",
						baseUrl: `http://127.0.0.1:${server.port}/v1`,
					}),
					path.join(root, trial),
					"fixture-key",
				);
				expect(output.stop).toBe("completed");
				expect(gradeAgentTask(AGENT_TASKS[0], output).passed).toBe(true);
				expect(output.usageComplete).toBe(true);
			}
			expect(headers).toHaveLength(4);
			expect(headers.map(header => header.path)).toStrictEqual(Array(4).fill("/v1/responses"));
			expect(headers[0].session).toBe(headers[1].session);
			expect(headers[2].session).toBe(headers[3].session);
			expect(headers[0].session).not.toBe(headers[2].session);
			for (const header of headers) expect(header.userAgent).toMatch(/^leapsea-metaharness\/1\.0 omp\//);
		} finally {
			await server.stop(true);
		}
	}, 60_000);

	test("a frozen V4.1 profile calls the exact Go model through chat completions without a bundled catalog entry", async () => {
		const seen: { model: unknown; path: string; session: string | null }[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body: unknown = await request.json();
				if (!isRecord(body) || !Array.isArray(body.messages)) return new Response("bad request", { status: 400 });
				seen.push({
					model: body.model,
					path: new URL(request.url).pathname,
					session: request.headers.get("x-opencode-session"),
				});
				const done = body.messages.some(message => isRecord(message) && message.role === "tool");
				return modelResponse(
					done ? { role: "assistant", content: JSON.stringify(AGENT_TASKS[0].expected) } : requestedRead(body),
					done ? "stop" : "tool_calls",
				);
			},
		});
		try {
			const output = await executeAgent(
				prepared,
				toAgentInput(AGENT_TASKS[0], {
					...controls,
					model: "opencode-go/deepseek-v4.1-flash",
					modelProfile: goProfile(`http://127.0.0.1:${server.port}/v1`),
				}),
				path.join(root, "go-v41-profile"),
				"fixture-key",
			);
			expect(output.stop).toBe("completed");
			expect(gradeAgentTask(AGENT_TASKS[0], output).passed).toBe(true);
			expect(output.usageComplete).toBe(true);
			expect(seen.map(request => [request.model, request.path])).toStrictEqual([
				["deepseek-v4.1-flash", "/v1/chat/completions"],
				["deepseek-v4.1-flash", "/v1/chat/completions"],
			]);
			expect(typeof seen[0].session).toBe("string");
			expect(seen[0].session).toBe(seen[1].session);
		} finally {
			await server.stop(true);
		}
	}, 40_000);

	test("candidate source reaches the model without leaking later edits or replacing the evaluator", async () => {
		const repo = path.resolve(packageDir, "../..");
		const candidateRoot = path.join(root, "candidate-checkout");
		await git.worktree.add(repo, candidateRoot, "HEAD", { detach: true });
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push(JSON.stringify(await request.json()));
				return modelResponse({ role: "assistant", content: '{"answer":42}' }, "stop");
			},
		});
		try {
			// The isolated checkout needs the same ignored generated assets/native
			// binary as the source producer. Copy only files absent from Git HEAD.
			const files: ContentFile[] = await Bun.file(path.join(prepared.runtimeDir, "../source-manifest.json")).json();
			for (const file of files) {
				const destination = path.join(candidateRoot, file.path);
				if (!(await Bun.file(destination).exists()))
					await Bun.write(destination, await Bun.file(path.join(repo, file.path)).bytes());
			}
			const promptPath = path.join(candidateRoot, "packages/coding-agent/src/prompts/system/system-prompt.md");
			const originalPrompt = await Bun.file(promptPath).text();
			const marker = "candidate-binding-probe-c491";
			await Bun.write(promptPath, `${originalPrompt}\n${marker}\n`);
			await expect(
				prepareHarness(
					{ root: candidateRoot, expectedSourceDigest: prepared.execution.sourceDigest },
					root,
					packageDir,
				),
			).rejects.toThrow("source digest mismatch");
			const candidate = await prepareHarness({ root: candidateRoot }, root, packageDir);
			await Bun.write(promptPath, `${originalPrompt}\npost-freeze-change-should-not-appear\n`);
			const input = toAgentInput(AGENT_TASKS[3], { ...controls, baseUrl: `http://127.0.0.1:${server.port}/v1` });
			const baselineResult = await executeAgent(prepared, input, path.join(root, "baseline-binding"), "fixture-key");
			const candidateResult = await executeAgent(
				candidate,
				input,
				path.join(root, "candidate-binding"),
				"fixture-key",
			);
			expect(gradeAgentTask(AGENT_TASKS[3], baselineResult).passed).toBe(true);
			expect(gradeAgentTask(AGENT_TASKS[3], candidateResult).passed).toBe(true);
			expect(requests.length).toBe(2);
			expect(requests[0]).not.toContain(marker);
			expect(requests[1]).toContain(marker);
			expect(requests[1]).not.toContain("post-freeze-change-should-not-appear");
			expect(candidate.execution.sourceDigest).not.toBe(prepared.execution.sourceDigest);
			expect(candidate.execution.driverDigest).toBe(prepared.execution.driverDigest);
			expect(candidate.execution.dependencyLockDigest).toBe(prepared.execution.dependencyLockDigest);
		} finally {
			await server.stop(true);
			await git.worktree.remove(repo, candidateRoot);
		}
	}, 80_000);

	test("the model request cap stops a real repeating tool loop before a second upstream call", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body: unknown = await request.json();
				if (!isRecord(body)) return new Response("invalid request", { status: 400 });
				requests += 1;
				return modelResponse(requestedRead(body), "tool_calls");
			},
		});
		try {
			const output = await executeAgent(
				prepared,
				toAgentInput(AGENT_TASKS[0], {
					...controls,
					maxRequests: 1,
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
				}),
				path.join(root, "request-cap"),
				"fixture-key",
			);
			expect(output.stop).toBe("request-limit");
			expect(requests).toBe(1);
			expect(output.requests).toBe(1);
			expect(output.calls.length).toBe(1);
			expect(gradeAgentTask(AGENT_TASKS[0], output).passed).toBe(false);
		} finally {
			await server.stop(true);
		}
	}, 35_000);

	test("cancellation terminates an in-flight agent instead of publishing a successful result", async () => {
		const cancellation = new AbortController();
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests += 1;
				cancellation.abort();
				return new Response("cancelled", { status: 503 });
			},
		});
		try {
			await expect(
				executeAgent(
					prepared,
					toAgentInput(AGENT_TASKS[3], { ...controls, baseUrl: `http://127.0.0.1:${server.port}/v1` }),
					path.join(root, "cancelled-trial"),
					"fixture-key",
					cancellation.signal,
				),
			).rejects.toThrow("cancelled");
			expect(requests).toBe(1);
		} finally {
			await server.stop(true);
		}
	}, 30_000);

	test("a provider stalled before headers is distinguished from an idle SSE stream", async () => {
		for (const phase of ["waiting-response-headers", "waiting-stream-event"] as const) {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				idleTimeout: 0,
				async fetch() {
					if (phase === "waiting-response-headers") {
						await Bun.sleep(1_500);
						return modelResponse({ role: "assistant", content: '{"answer":42}' }, "stop");
					}
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			});
			try {
				const output = await executeAgent(
					prepared,
					toAgentInput(AGENT_TASKS[3], {
						...controls,
						timeoutMs: 1_000,
						baseUrl: `http://127.0.0.1:${server.port}/v1`,
					}),
					path.join(root, `stall-${phase}`),
					"fixture-key",
				);
				expect(output.stop).toBe("timeout");
				expect(output.usageComplete).toBe(false);
				expect(output).toMatchObject({
					diagnostics: { timeout: { phase: "model", requestPhase: phase, requestIndex: 1 } },
				});
			} finally {
				await server.stop(true);
			}
		}
	}, 25_000);

	test("request traces separate model latency from teardown without persisting headers or payloads", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body: unknown = await request.json();
				if (!isRecord(body) || !Array.isArray(body.messages)) return new Response("bad request", { status: 400 });
				await Bun.sleep(100);
				const done = body.messages.some(message => isRecord(message) && message.role === "tool");
				return modelResponse(
					done ? { role: "assistant", content: JSON.stringify(AGENT_TASKS[0].expected) } : requestedRead(body),
					done ? "stop" : "tool_calls",
				);
			},
		});
		try {
			const output = await executeAgent(
				prepared,
				toAgentInput(AGENT_TASKS[0], {
					...controls,
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
				}),
				path.join(root, "request-timings"),
				"fixture-key",
			);
			expect(gradeAgentTask(AGENT_TASKS[0], output).passed).toBe(true);
			expect(output).toMatchObject({
				diagnostics: {
					version: 1,
					phase: "finished",
					timeout: null,
					requests: [
						{ index: 1, status: 200, outcome: "completed" },
						{ index: 2, status: 200, outcome: "completed" },
					],
				},
			});
			const diagnostics = output.diagnostics;
			if (!diagnostics) throw new Error("Timing evidence was not returned");
			for (const request of diagnostics.requests) {
				expect(request.responseHeadersMs).not.toBeNull();
				expect(request.firstSseMs).not.toBeNull();
				expect(request.endedMs).not.toBeNull();
				expect(request.responseHeadersMs!).toBeGreaterThanOrEqual(request.startedMs);
				expect(request.firstSseMs!).toBeGreaterThanOrEqual(request.responseHeadersMs!);
				expect(request.endedMs!).toBeGreaterThanOrEqual(request.firstSseMs!);
			}
			expect(JSON.stringify(diagnostics)).not.toContain("fixture-key");
			expect(JSON.stringify(diagnostics)).not.toContain("atlas-42");
			expect(diagnostics.cleanupErrors).toStrictEqual([]);
			expect(() => parseAgentOutput({ ...output, diagnostics: { ...diagnostics, requests: [] } })).toThrow(
				"Invalid request timing count",
			);
		} finally {
			await server.stop(true);
		}
	}, 30_000);

	test("HTTP error responses hidden by SDK retries are not reported as never receiving headers", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return Response.json(
					{ error: { message: "fixture unavailable" } },
					{
						status: 503,
						headers: {
							"retry-after": "30",
							"x-request-id": "req_fixture_503",
							"set-cookie": "private-response-cookie",
						},
					},
				);
			},
		});
		try {
			const output = await executeAgent(
				prepared,
				toAgentInput(AGENT_TASKS[3], {
					...controls,
					timeoutMs: 1500,
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
				}),
				path.join(root, "hidden-http-error"),
				"fixture-key",
			);
			expect(output.stop).toBe("timeout");
			expect(output.diagnostics?.timeout?.requestPhase).toBe("transport-retry-or-error");
			expect(output.diagnostics?.requests[0]).toMatchObject({
				responseHeadersMs: null,
				responseCount: 0,
				httpAttempts: [{ status: 503, requestId: "req_fixture_503", outcome: "response" }],
			});
			expect(JSON.stringify(output.diagnostics)).not.toContain("private-response-cookie");
		} finally {
			await server.stop(true);
		}
	}, 15_000);

	test("HTTP transport retries share the real request cap instead of hiding behind one logical request", async () => {
		let wireRequests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				wireRequests += 1;
				return Response.json(
					{ error: { message: "fixture transient error" } },
					{ status: 503, headers: { "retry-after": "0" } },
				);
			},
		});
		try {
			const output = await executeAgent(
				prepared,
				toAgentInput(AGENT_TASKS[3], {
					...controls,
					maxRequests: 1,
					timeoutMs: 10_000,
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
				}),
				path.join(root, "http-cap"),
				"fixture-key",
			);
			expect(output.stop).toBe("request-limit");
			expect(wireRequests).toBe(1);
			expect(output.diagnostics?.requests[0].httpAttempts).toHaveLength(1);
			expect(output.usageComplete).toBe(false);
		} finally {
			await server.stop(true);
		}
	}, 20_000);

	test("modified executable bytes fail before another trial starts", async () => {
		const file = path.join(prepared.runtimeDir, prepared.execution.entrypoint);
		const original = await Bun.file(file).bytes();
		try {
			await Bun.write(file, `${new TextDecoder().decode(original)}\n// changed after preparation\n`);
			await expect(verifyPreparedHarness(prepared)).rejects.toThrow("Harness executable changed");
		} finally {
			await Bun.write(file, original);
		}
	});
});
