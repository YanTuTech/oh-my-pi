/** Trusted driver protocol. Deliberately contains no expectations or grader input. */
export interface ToolOrigin {
	server: string;
	tool: string;
}

/** Explicit non-secret catalog snapshot for a model newer than the candidate's bundled catalog. */
export interface BenchmarkModelProfile {
	provider: string;
	id: string;
	name: string;
	api: "openai-completions" | "openai-responses" | "anthropic-messages";
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface AgentInput {
	version: 1;
	prompt: string;
	model: string;
	baseUrl?: string;
	modelProfile?: BenchmarkModelProfile;
	servers: {
		name: string;
		profile: "primary" | "secondary" | "flaky" | "challenge-primary" | "challenge-secondary";
		seed?: number;
	}[];
	timeoutMs: number;
	maxRequests: number;
	maxToolCalls: number;
	maxOutputTokens: number;
	temperature: number;
}

export interface ObservedCall {
	id: string;
	origin: ToolOrigin;
	wireName: string;
	args: unknown;
	result: unknown;
	isError: boolean;
	/** Tool lifecycle order assigned by the driver; absent only in pre-v2 archives. */
	startedOrder?: number;
	completedOrder?: number | null;
	/** Logical model response that chose the call; same-response calls cannot depend on each other's results. */
	modelRequestIndex?: number;
}

export type AgentStop =
	| "completed"
	| "timeout"
	| "request-limit"
	| "tool-limit"
	| "output-limit"
	| "provider-error"
	| "setup-error";

export type DiagnosticPhase =
	| "setup"
	| "model"
	| "tools"
	| "between-requests"
	| "session-dispose"
	| "mcp-disconnect"
	| "finished";
export type RequestPhase =
	| "preparing-request"
	| "waiting-response-headers"
	| "transport-retry-or-error"
	| "waiting-stream-event"
	| "streaming"
	| "finished";

/** Every fetch invocation, including error responses hidden by SDK transport retries. */
export interface HttpAttemptTiming {
	index: number;
	startedMs: number;
	headersMs: number | null;
	endedMs: number | null;
	status: number | null;
	requestId: string | null;
	errorCode: string | null;
	outcome: "pending" | "response" | "aborted" | "network-error";
}

/** Monotonic offsets, not wall-clock timestamps. No request/response contents or headers. */
export interface RequestTiming {
	index: number;
	startedMs: number;
	payloadReadyMs: number | null;
	responseHeadersMs: number | null;
	firstSseMs: number | null;
	firstContentMs: number | null;
	lastSseMs: number | null;
	endedMs: number | null;
	responseCount: number;
	/** Older observations stopped at the SDK callback and have no wire evidence. */
	httpAttempts?: HttpAttemptTiming[];
	sseCount: number;
	status: number | null;
	outcome: "pending" | "completed" | "provider-error" | "aborted" | "output-limit" | "exception";
}

export interface AgentDiagnostics {
	version: 1;
	phase: DiagnosticPhase;
	elapsedMs: number;
	setupMs: number | null;
	promptMs: number | null;
	sessionDisposeMs: number | null;
	mcpDisconnectMs: number | null;
	requests: RequestTiming[];
	tools: { callIndex: number; startedMs: number; endedMs: number | null }[];
	timeout: {
		phase: DiagnosticPhase;
		requestPhase: RequestPhase | null;
		requestIndex: number | null;
		elapsedMs: number;
	} | null;
	cleanupErrors: ("session-dispose" | "mcp-disconnect" | "auth-close")[];
}

export interface AgentOutput {
	version: 1;
	entrypointDigest: string;
	finalText: string;
	stop: AgentStop;
	requests: number;
	calls: ObservedCall[];
	inventory: { wireName: string; origin: ToolOrigin }[];
	collisionErrors: number;
	tokens: { input: number; output: number; reasoning: number | null; cacheRead: number; cacheWrite: number };
	usageComplete: boolean;
	costUsd: number;
	/** Catalog estimate from provider-reported usage, not a billing receipt. */
	costSource: "catalog-estimate";
	/** Older archived runs have no timing evidence; do not invent it on read. */
	diagnostics?: AgentDiagnostics;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateModelEndpoint(value: string): void {
	const endpoint = new URL(value);
	if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
		throw new Error("Model endpoint must not contain credentials, query parameters or fragments");
	if (
		endpoint.protocol !== "https:" &&
		!(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
	)
		throw new Error("Use HTTPS for non-local model endpoints");
}

/** Reject identity substitutions, arbitrary provider headers and secret-bearing profile fields. */
export function parseModelProfile(value: unknown, selector: string): BenchmarkModelProfile {
	if (!isRecord(value)) throw new Error("Invalid model profile");
	const allowed = new Set([
		"provider",
		"id",
		"name",
		"api",
		"baseUrl",
		"reasoning",
		"input",
		"contextWindow",
		"maxTokens",
		"cost",
	]);
	if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("Unexpected model profile field");
	for (const key of ["provider", "id", "name", "baseUrl"] as const) {
		if (typeof value[key] !== "string" || value[key].length === 0 || value[key].length > 2048)
			throw new Error(`Invalid model profile ${key}`);
	}
	if (`${value.provider}/${value.id}` !== selector)
		throw new Error("Model profile identity does not match the requested model");
	if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(String(value.api)))
		throw new Error("Unsupported model profile API");
	validateModelEndpoint(String(value.baseUrl));
	if (
		typeof value.reasoning !== "boolean" ||
		!Array.isArray(value.input) ||
		value.input.length === 0 ||
		!value.input.every(item => item === "text" || item === "image") ||
		new Set(value.input).size !== value.input.length
	)
		throw new Error("Invalid model profile capabilities");
	for (const key of ["contextWindow", "maxTokens"] as const) {
		if (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0 || Number(value[key]) > 10_000_000)
			throw new Error(`Invalid model profile ${key}`);
	}
	const cost = value.cost;
	const costKeys = ["input", "output", "cacheRead", "cacheWrite"];
	if (
		!isRecord(cost) ||
		Object.keys(cost).some(key => !costKeys.includes(key)) ||
		!costKeys.every(key => typeof cost[key] === "number" && Number.isFinite(cost[key]) && cost[key] >= 0)
	)
		throw new Error("Invalid model profile cost");
	return value as unknown as BenchmarkModelProfile;
}

export function parseAgentInput(value: unknown): AgentInput {
	if (!isRecord(value) || value.version !== 1 || typeof value.prompt !== "string" || typeof value.model !== "string")
		throw new Error("Invalid agent input");
	const allowed = new Set([
		"version",
		"prompt",
		"model",
		"baseUrl",
		"modelProfile",
		"servers",
		"timeoutMs",
		"maxRequests",
		"maxToolCalls",
		"maxOutputTokens",
		"temperature",
	]);
	if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("Unexpected agent input field");
	for (const key of ["timeoutMs", "maxRequests", "maxToolCalls", "maxOutputTokens"] as const) {
		if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1) throw new Error(`Invalid ${key}`);
	}
	if (
		typeof value.temperature !== "number" ||
		!Number.isFinite(value.temperature) ||
		value.temperature < 0 ||
		value.temperature > 2
	)
		throw new Error("Invalid temperature");
	if (value.baseUrl !== undefined) {
		if (typeof value.baseUrl !== "string") throw new Error("Invalid model endpoint");
		validateModelEndpoint(value.baseUrl);
	}
	if (value.modelProfile !== undefined) {
		const profile = parseModelProfile(value.modelProfile, value.model);
		if (value.baseUrl !== undefined && value.baseUrl !== profile.baseUrl)
			throw new Error("Model endpoint conflicts with the frozen profile");
	}
	if (
		Number(value.timeoutMs) > 900_000 ||
		Number(value.maxRequests) > 64 ||
		Number(value.maxToolCalls) > 256 ||
		Number(value.maxOutputTokens) > 32_768 ||
		value.prompt.length > 65_536
	)
		throw new Error("Agent input exceeds supported resource limits");
	if (
		!Array.isArray(value.servers) ||
		value.servers.length > 8 ||
		!value.servers.every(server => {
			if (
				!isRecord(server) ||
				typeof server.name !== "string" ||
				!/^[a-zA-Z0-9_.-]{1,64}$/.test(server.name) ||
				Object.keys(server).some(key => !["name", "profile", "seed"].includes(key))
			)
				return false;
			if (["challenge-primary", "challenge-secondary"].includes(String(server.profile)))
				return Number.isSafeInteger(server.seed) && Number(server.seed) >= 1 && Number(server.seed) <= 65535;
			return ["primary", "secondary", "flaky"].includes(String(server.profile)) && server.seed === undefined;
		}) ||
		new Set(value.servers.map(server => server.name)).size !== value.servers.length
	)
		throw new Error("Invalid MCP servers");
	return value as unknown as AgentInput;
}

function validateDiagnostics(value: unknown, requestCount: number, callCount: number): void {
	const phases: readonly string[] = [
		"setup",
		"model",
		"tools",
		"between-requests",
		"session-dispose",
		"mcp-disconnect",
		"finished",
	];
	const requestPhases: readonly string[] = [
		"preparing-request",
		"waiting-response-headers",
		"transport-retry-or-error",
		"waiting-stream-event",
		"streaming",
		"finished",
	];
	const time = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item) && item >= 0;
	const optionalTime = (item: unknown) => item === null || time(item);
	if (!isRecord(value) || value.version !== 1 || !phases.includes(String(value.phase)) || !time(value.elapsedMs))
		throw new Error("Invalid agent diagnostics");
	for (const key of ["setupMs", "promptMs", "sessionDisposeMs", "mcpDisconnectMs"]) {
		if (!optionalTime(value[key]) || (typeof value[key] === "number" && value[key] > value.elapsedMs))
			throw new Error("Invalid diagnostic duration");
	}
	if (!Array.isArray(value.requests) || value.requests.length !== requestCount || requestCount > 64)
		throw new Error("Invalid request timing count");
	for (const [index, request] of value.requests.entries()) {
		if (
			!isRecord(request) ||
			request.index !== index + 1 ||
			!time(request.startedMs) ||
			request.startedMs > value.elapsedMs
		)
			throw new Error("Invalid request timing");
		for (const key of [
			"payloadReadyMs",
			"responseHeadersMs",
			"firstSseMs",
			"firstContentMs",
			"lastSseMs",
			"endedMs",
		]) {
			if (
				!optionalTime(request[key]) ||
				(typeof request[key] === "number" && (request[key] < request.startedMs || request[key] > value.elapsedMs))
			)
				throw new Error("Invalid request timing boundary");
		}
		if (
			!Number.isSafeInteger(request.responseCount) ||
			Number(request.responseCount) < 0 ||
			!Number.isSafeInteger(request.sseCount) ||
			Number(request.sseCount) < 0
		)
			throw new Error("Invalid request event counts");
		if (
			request.status !== null &&
			(!Number.isSafeInteger(request.status) || Number(request.status) < 100 || Number(request.status) > 599)
		)
			throw new Error("Invalid diagnostic HTTP status");
		if (
			!["pending", "completed", "provider-error", "aborted", "output-limit", "exception"].includes(
				String(request.outcome),
			)
		)
			throw new Error("Invalid request outcome");
		if (request.httpAttempts !== undefined) {
			if (!Array.isArray(request.httpAttempts) || request.httpAttempts.length > 64)
				throw new Error("Invalid HTTP attempt count");
			for (const [attemptIndex, attempt] of request.httpAttempts.entries()) {
				if (
					!isRecord(attempt) ||
					attempt.index !== attemptIndex + 1 ||
					!time(attempt.startedMs) ||
					attempt.startedMs < request.startedMs ||
					attempt.startedMs > value.elapsedMs
				)
					throw new Error("Invalid HTTP attempt timing");
				for (const key of ["headersMs", "endedMs"])
					if (
						!optionalTime(attempt[key]) ||
						(typeof attempt[key] === "number" &&
							(attempt[key] < attempt.startedMs || attempt[key] > value.elapsedMs))
					)
						throw new Error("Invalid HTTP attempt boundary");
				if (
					attempt.status !== null &&
					(!Number.isSafeInteger(attempt.status) || Number(attempt.status) < 100 || Number(attempt.status) > 599)
				)
					throw new Error("Invalid HTTP attempt status");
				if (
					attempt.requestId !== null &&
					(typeof attempt.requestId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(attempt.requestId))
				)
					throw new Error("Invalid HTTP request id");
				if (
					attempt.errorCode !== null &&
					![
						"ABORT_ERR",
						"ECONNRESET",
						"ECONNREFUSED",
						"ETIMEDOUT",
						"ENOTFOUND",
						"EAI_AGAIN",
						"UND_ERR_CONNECT_TIMEOUT",
					].includes(String(attempt.errorCode))
				)
					throw new Error("Invalid HTTP error code");
				if (!["pending", "response", "aborted", "network-error"].includes(String(attempt.outcome)))
					throw new Error("Invalid HTTP attempt outcome");
			}
		}
	}
	if (!Array.isArray(value.tools) || value.tools.length !== callCount || callCount > 256)
		throw new Error("Invalid tool timing count");
	for (const [index, tool] of value.tools.entries()) {
		if (
			!isRecord(tool) ||
			tool.callIndex !== index + 1 ||
			!time(tool.startedMs) ||
			tool.startedMs > value.elapsedMs ||
			!optionalTime(tool.endedMs) ||
			(typeof tool.endedMs === "number" && (tool.endedMs < tool.startedMs || tool.endedMs > value.elapsedMs))
		)
			throw new Error("Invalid tool timing");
	}
	if (value.timeout !== null) {
		const timeout = value.timeout;
		if (
			!isRecord(timeout) ||
			!phases.includes(String(timeout.phase)) ||
			!time(timeout.elapsedMs) ||
			timeout.elapsedMs > value.elapsedMs ||
			(timeout.requestPhase !== null && !requestPhases.includes(String(timeout.requestPhase))) ||
			(timeout.requestIndex !== null &&
				(!Number.isSafeInteger(timeout.requestIndex) ||
					Number(timeout.requestIndex) < 1 ||
					Number(timeout.requestIndex) > requestCount))
		)
			throw new Error("Invalid timeout location");
	}
	if (
		!Array.isArray(value.cleanupErrors) ||
		value.cleanupErrors.length > 3 ||
		!value.cleanupErrors.every(item => ["session-dispose", "mcp-disconnect", "auth-close"].includes(item))
	)
		throw new Error("Invalid cleanup diagnostics");
}

/** Do not treat missing, malformed or non-finite worker evidence as success. */
export function parseAgentOutput(value: unknown): AgentOutput {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.entrypointDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.entrypointDigest)
	)
		throw new Error("Invalid agent execution evidence");
	if (
		typeof value.finalText !== "string" ||
		![
			"completed",
			"timeout",
			"request-limit",
			"tool-limit",
			"output-limit",
			"provider-error",
			"setup-error",
		].includes(String(value.stop))
	)
		throw new Error("Invalid agent completion");
	for (const key of ["requests", "collisionErrors", "costUsd"] as const) {
		if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0)
			throw new Error("Invalid agent measurement");
	}
	const tokens = value.tokens;
	if (
		!isRecord(tokens) ||
		!["input", "output", "cacheRead", "cacheWrite"].every(
			key => typeof tokens[key] === "number" && Number.isFinite(tokens[key]) && tokens[key] >= 0,
		)
	)
		throw new Error("Missing agent usage");
	if (
		tokens.reasoning !== null &&
		(typeof tokens.reasoning !== "number" || !Number.isFinite(tokens.reasoning) || tokens.reasoning < 0)
	)
		throw new Error("Invalid reasoning usage");
	if (typeof value.usageComplete !== "boolean") throw new Error("Missing usage completeness evidence");
	if (
		!Array.isArray(value.calls) ||
		!value.calls.every(
			call =>
				isRecord(call) &&
				typeof call.id === "string" &&
				typeof call.wireName === "string" &&
				typeof call.isError === "boolean" &&
				isRecord(call.origin) &&
				typeof call.origin.server === "string" &&
				typeof call.origin.tool === "string" &&
				"args" in call &&
				"result" in call,
		)
	)
		throw new Error("Invalid agent tool evidence");
	if (
		!Array.isArray(value.inventory) ||
		!value.inventory.every(
			tool =>
				isRecord(tool) &&
				typeof tool.wireName === "string" &&
				isRecord(tool.origin) &&
				typeof tool.origin.server === "string" &&
				typeof tool.origin.tool === "string",
		)
	)
		throw new Error("Invalid tool inventory");
	const lifecycleOrders = new Set<number>();
	for (const call of value.calls) {
		if (
			call.modelRequestIndex !== undefined &&
			(!Number.isSafeInteger(call.modelRequestIndex) ||
				call.modelRequestIndex < 1 ||
				call.modelRequestIndex > Number(value.requests))
		)
			throw new Error("Invalid tool model-request identity");
		if (call.startedOrder === undefined && call.completedOrder === undefined) continue; // Historical evidence.
		if (!Number.isSafeInteger(call.startedOrder) || call.startedOrder < 1 || lifecycleOrders.has(call.startedOrder))
			throw new Error("Invalid tool lifecycle order");
		lifecycleOrders.add(call.startedOrder);
		if (call.completedOrder !== null) {
			if (
				!Number.isSafeInteger(call.completedOrder) ||
				call.completedOrder <= call.startedOrder ||
				lifecycleOrders.has(call.completedOrder)
			)
				throw new Error("Invalid tool lifecycle order");
			lifecycleOrders.add(call.completedOrder);
		}
	}
	if (value.costSource !== "catalog-estimate") throw new Error("Missing cost provenance");
	if (value.diagnostics !== undefined)
		validateDiagnostics(value.diagnostics, Number(value.requests), value.calls.length);
	return value as unknown as AgentOutput;
}
