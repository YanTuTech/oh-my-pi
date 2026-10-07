import * as path from "node:path";
import { AuthStorage, streamSimple } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { connectToServer, disconnectServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { DiagnosticRecorder } from "./agent-diagnostics";
import { type AgentOutput, type AgentStop, isRecord, parseAgentInput } from "./agent-protocol";
import agentSystemPrompt from "./agent-system.md" with { type: "text" };

/** This entry point is copied by the trusted evaluator and compiled against the candidate. */
async function main(): Promise<AgentOutput> {
	const raw = await Bun.stdin.text();
	if (raw.length > 131_072) throw new Error("Agent input exceeds protocol limit");
	const input = parseAgentInput(JSON.parse(raw));
	const entrypointDigest = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(import.meta.path).arrayBuffer())
		.digest("hex");
	const diagnostics = new DiagnosticRecorder();
	const deadline = Date.now() + input.timeoutMs;
	const cancellation = new AbortController();
	const output: AgentOutput = {
		version: 1,
		entrypointDigest,
		finalText: "",
		stop: "setup-error",
		requests: 0,
		calls: [],
		inventory: [],
		collisionErrors: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
		costUsd: 0,
		costSource: "catalog-estimate",
		usageComplete: false,
		diagnostics: diagnostics.data,
	};
	const connections: MCPServerConnection[] = [];
	let session: AgentSession | undefined;
	let auth: AuthStorage | undefined;
	let stop: AgentStop | undefined;
	let requestSignal: AbortSignal | undefined;
	const deadlineReached = (): boolean =>
		cancellation.signal.aborted ||
		Date.now() >= deadline ||
		(requestSignal?.aborted === true &&
			requestSignal.reason instanceof DOMException &&
			requestSignal.reason.name === "TimeoutError");
	let measuredResponses = 0;
	let toolLifecycleOrder = 0;
	let httpAttempts = 0;
	const transportBudgetAbort = new AbortController();
	let reasoningKnown = true;
	const timer = setTimeout(
		() => {
			diagnostics.timeout();
			stop = "timeout";
			cancellation.abort();
			void session?.abort().catch(() => {});
		},
		Math.max(0, deadline - Date.now()),
	);
	try {
		const apiKey = process.env.MCP_BENCH_API_KEY;
		if (!apiKey) throw new Error("Model credential unavailable");
		auth = await AuthStorage.create(":memory:");
		const slash = input.model.indexOf("/");
		if (slash <= 0) throw new Error("Expected provider/model");
		const provider = input.model.slice(0, slash);
		const id = input.model.slice(slash + 1);
		auth.setRuntimeApiKey(provider, apiKey);
		const settings = Settings.isolated({
			"tools.xdev": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			temperature: input.temperature,
		});
		const models = new ModelRegistry(auth, path.join(process.cwd(), "models.yml"), {
			ignoreLocalModelConfig: true,
			settings,
			cacheDbPath: ":memory:",
		});
		const catalogModel = input.modelProfile ? buildModel(input.modelProfile) : models.find(provider, id);
		if (!catalogModel) throw new Error("Model is absent from the frozen catalog; supply an explicit model profile");
		const model = { ...catalogModel, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) };
		const minted: MCPTool[] = [];
		for (const server of input.servers) {
			if (stop) throw new Error("Agent deadline reached");
			const connection = await connectToServer(
				server.name,
				{
					type: "stdio",
					command: process.execPath,
					args: server.profile.startsWith("challenge-")
						? [
								path.join(import.meta.dir, "challenge-fixture-server.js"),
								server.profile,
								String(server.seed),
								server.name,
							]
						: [path.join(import.meta.dir, "agent-fixture-server.js"), server.profile],
					env: { MCP_BENCH_API_KEY: "" },
				},
				{ signal: cancellation.signal },
			);
			connections.push(connection);
			for (const tool of MCPTool.fromTools(
				connection,
				await listTools(connection, { signal: cancellation.signal }),
			)) {
				const execute = tool.execute.bind(tool);
				// Count and record actual original routes. Do not infer origin by
				// splitting the normalized wire name or by consulting the answer key.
				tool.execute = async (callId, args, onUpdate, context, signal) => {
					if (output.calls.length >= input.maxToolCalls) {
						stop = "tool-limit";
						throw new Error("Benchmark tool-call budget exhausted");
					}
					const call = {
						id: callId,
						origin: { server: tool.mcpServerName, tool: tool.mcpToolName },
						wireName: tool.name,
						args,
						result: null as unknown,
						isError: true,
						startedOrder: ++toolLifecycleOrder,
						completedOrder: null as number | null,
						modelRequestIndex: output.requests,
					};
					output.calls.push(call);
					const endTool = diagnostics.beginTool(output.calls.length);
					try {
						const result = await execute(callId, args, onUpdate, context, signal);
						call.result = result;
						call.isError = isRecord(result) && result.isError === true;
						return result;
					} finally {
						call.completedOrder = ++toolLifecycleOrder;
						endTool();
					}
				};
				minted.push(tool);
			}
		}
		const created = await createAgentSession({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			managedRuntime: true,
			authStorage: auth,
			modelRegistry: models,
			model,
			sessionManager: SessionManager.inMemory(),
			settings,
			appendSystemPrompt: agentSystemPrompt,
			fileMentionReadPolicy: { mode: "disabled" },
			customTools: [],
			toolNames: [],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			extensions: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			enableIrc: false,
			skipPythonPreflight: true,
			requireYieldTool: false,
			deadline,
			getApiKey: () => apiKey,
			streamFn: (requestModel, context, options) => {
				if (stop || output.requests >= input.maxRequests) {
					stop ??= "request-limit";
					throw new Error("Benchmark request budget exhausted");
				}
				const headers = { ...options?.headers };
				if (provider === "opencode-go") {
					// Go routes each conversation by session, not by its prompt-cache key.
					// Reuse the SDK identity across tool turns; every trial owns a fresh SDK session.
					if (!options?.sessionId) throw new Error("OpenCode Go requires a session identity");
					headers["x-opencode-session"] = options.sessionId;
					headers["user-agent"] = `leapsea-metaharness/1.0 ${USER_AGENT}`;
				}
				output.requests += 1;
				requestSignal = options?.signal
					? AbortSignal.any([options.signal, transportBudgetAbort.signal])
					: transportBudgetAbort.signal;
				const timing = diagnostics.beginRequest();
				return streamSimple(requestModel, context, {
					...options,
					signal: requestSignal,
					headers,
					maxTokens: input.maxOutputTokens,
					temperature: input.temperature,
					fetch: diagnostics.observeFetch(timing, options?.fetch ?? fetch, () => {
						// SDK retries are real requests too; they share the same finite cap.
						if (stop || httpAttempts >= input.maxRequests) {
							stop ??= "request-limit";
							const reason = new Error("Benchmark HTTP attempt budget exhausted");
							transportBudgetAbort.abort(reason); // also stops retry backoff sleeps
							throw reason;
						}
						httpAttempts += 1;
					}),
					onPayload: async (payload, model) => {
						diagnostics.payloadReady(timing);
						return options?.onPayload?.(payload, model);
					},
					onResponse: async (response, model) => {
						diagnostics.response(timing, response.status);
						await options?.onResponse?.(response, model);
					},
					onSseEvent: (event, model) => {
						diagnostics.sse(timing);
						options?.onSseEvent?.(event, model);
					},
				});
			},
		});
		session = created.session;
		// Exercise the production registry refresh and collision arbitration,
		// rather than deduplicating inside a benchmark-specific reconstruction.
		await session.refreshMCPTools(minted);
		for (const tool of session.agent.state.tools) {
			if (!tool.name.startsWith("mcp__")) throw new Error("Unexpected ambient tool in benchmark session");
			if (
				!("mcpServerName" in tool) ||
				typeof tool.mcpServerName !== "string" ||
				!("mcpToolName" in tool) ||
				typeof tool.mcpToolName !== "string"
			)
				throw new Error("MCP registry lost original route identity");
			output.inventory.push({ wireName: tool.name, origin: { server: tool.mcpServerName, tool: tool.mcpToolName } });
		}
		output.collisionErrors = minted.length - output.inventory.length;
		session.subscribe(event => {
			if (
				event.type === "message_update" &&
				["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type)
			)
				diagnostics.content();
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const message = event.message;
			// The SDK shares the same absolute deadline and may signal first.
			// Preserve timeout attribution before message_end changes the phase.
			if (deadlineReached()) {
				diagnostics.timeout();
				stop = "timeout";
			}
			output.finalText = message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n");
			if (message.stopReason === "error" || message.stopReason === "aborted") stop ??= "provider-error";
			if (message.stopReason === "length") stop ??= "output-limit";
			diagnostics.endRequest(
				message.stopReason === "error"
					? "provider-error"
					: message.stopReason === "aborted"
						? "aborted"
						: message.stopReason === "length"
							? "output-limit"
							: "completed",
			);
			if (
				message.usage.totalTokens > 0 &&
				[
					message.usage.input,
					message.usage.output,
					message.usage.cacheRead,
					message.usage.cacheWrite,
					message.usage.cost.total,
				].every(value => Number.isFinite(value) && value >= 0)
			)
				measuredResponses += 1;
			if (message.usage.reasoningTokens === undefined) reasoningKnown = false;
			else output.tokens.reasoning = (output.tokens.reasoning ?? 0) + message.usage.reasoningTokens;
			output.tokens.input += message.usage.input;
			output.tokens.output += message.usage.output;
			output.tokens.cacheRead += message.usage.cacheRead;
			output.tokens.cacheWrite += message.usage.cacheWrite;
			output.costUsd += message.usage.cost.total;
		});
		diagnostics.beginPrompt();
		await session.prompt(input.prompt);
		output.stop = stop ?? "completed";
		output.usageComplete =
			output.stop === "completed" && output.requests > 0 && measuredResponses === output.requests;
		if (!reasoningKnown) output.tokens.reasoning = null;
	} catch {
		if (deadlineReached()) {
			diagnostics.timeout();
			stop = "timeout";
		}
		output.stop = stop ?? (session ? "provider-error" : "setup-error");
		diagnostics.endRequest("exception");
	} finally {
		clearTimeout(timer);
		diagnostics.endPrompt();
		await diagnostics.cleanup("session-dispose", async () => {
			await session?.dispose();
		});
		await diagnostics.cleanup("mcp-disconnect", async () => {
			const results = await Promise.allSettled(connections.map(connection => disconnectServer(connection)));
			if (results.some(result => result.status === "rejected")) throw new Error("MCP disconnect failed");
		});
		try {
			auth?.close();
		} catch {
			diagnostics.data.cleanupErrors.push("auth-close");
		}
		diagnostics.phase("finished");
	}
	return output;
}

if (import.meta.main) {
	main()
		.then(async output => {
			// main has awaited owned session/MCP teardown. Flush the evidence before
			// exiting this single-use worker; unrelated SDK timers must not extend
			// a completed trial or race the parent's hard timeout.
			await Bun.write(Bun.stdout, `${JSON.stringify(output)}\n`);
			process.exit(0);
		})
		.catch(() => {
			// Never echo credentials, raw provider errors, or the input payload.
			process.stderr.write("Agent driver protocol/setup failure\n", () => process.exit(1));
		});
}
