import type { AgentInput, AgentOutput, ToolOrigin } from "./agent-protocol";

/** Evaluator-owned. This module is never copied to the candidate driver. */
export interface AgentTask {
	id: string;
	prompt: string;
	servers: AgentInput["servers"];
	expected: Record<string, string | number>;
	requiredRoutes: ToolOrigin[];
	forbidTools?: boolean;
}

export const AGENT_TASKS: AgentTask[] = [
	{
		id: "record-by-id",
		prompt: "Read record atlas-42 from library-primary. Return JSON with exactly id, title, and year.",
		servers: [{ name: "library-primary", profile: "primary" }],
		expected: { id: "atlas-42", title: "Retrieval Under Uncertainty", year: 2025 },
		requiredRoutes: [{ server: "library-primary", tool: "get_record" }],
	},
	{
		id: "search-then-read",
		prompt:
			"Search library-primary for retrieval augmentation, then read the matching record. Return JSON with exactly id and checksum.",
		servers: [{ name: "library-primary", profile: "primary" }],
		expected: { id: "atlas-42", checksum: "P-73" },
		requiredRoutes: [
			{ server: "library-primary", tool: "search_records" },
			{ server: "library-primary", tool: "get_record" },
		],
	},
	{
		id: "choose-correct-source",
		prompt:
			"Read atlas-42 specifically from library-secondary, not library-primary. Return JSON with exactly id and checksum.",
		servers: [
			{ name: "library-primary", profile: "primary" },
			{ name: "library-secondary", profile: "secondary" },
		],
		expected: { id: "atlas-42", checksum: "S-91" },
		requiredRoutes: [{ server: "library-secondary", tool: "get_record" }],
	},
	{
		id: "no-tool-needed",
		prompt: "Without using tools, calculate 17 + 25. Return JSON with exactly one numeric field named answer.",
		servers: [{ name: "library-primary", profile: "primary" }],
		expected: { answer: 42 },
		requiredRoutes: [],
		forbidTools: true,
	},
	{
		id: "recover-temporary-read",
		prompt:
			"Read atlas-42 from library-flaky. A temporary read failure is safe to retry. Return JSON with exactly id and checksum.",
		servers: [{ name: "library-flaky", profile: "flaky" }],
		expected: { id: "atlas-42", checksum: "P-73" },
		requiredRoutes: [{ server: "library-flaky", tool: "get_record" }],
	},
	{
		id: "collision-correct-result",
		prompt:
			"Read atlas-42 from library-tools (the hyphenated primary library). Return JSON with exactly id and checksum.",
		servers: [
			{ name: "library-tools", profile: "primary" },
			{ name: "library.tools", profile: "secondary" },
		],
		expected: { id: "atlas-42", checksum: "P-73" },
		requiredRoutes: [{ server: "library-tools", tool: "get_record" }],
	},
];

export interface TaskGrade {
	passed: boolean;
	reasons: string[];
	resultCorrect: boolean;
	routesCorrect: boolean;
}

/** Exact structured result + required evidence. Collisions and retries are diagnostic, not forced failures. */
export function gradeAgentTask(task: AgentTask, output: AgentOutput): TaskGrade {
	const reasons: string[] = [];
	if (output.stop !== "completed") reasons.push(`incomplete:${output.stop}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.finalText.trim());
	} catch {
		parsed = undefined;
	}
	const expectedEntries = Object.entries(task.expected);
	const resultCorrect =
		typeof parsed === "object" &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		Object.keys(parsed).length === expectedEntries.length &&
		expectedEntries.every(
			([key, value]) => Object.hasOwn(parsed, key) && (parsed as Record<string, unknown>)[key] === value,
		);
	if (!resultCorrect) reasons.push("incorrect_final_result");
	const missing = task.requiredRoutes.filter(
		route =>
			!output.calls.some(
				call => !call.isError && call.origin.server === route.server && call.origin.tool === route.tool,
			),
	);
	const forbidden = task.forbidTools === true && output.calls.length > 0;
	// Explicit data-source tasks must not substitute the same-named operation
	// from another library, even when an answer happens to match.
	const wrongSource = output.calls.some(
		call =>
			task.requiredRoutes.some(route => route.tool === call.origin.tool) &&
			!task.requiredRoutes.some(route => route.tool === call.origin.tool && route.server === call.origin.server),
	);
	const routesCorrect = missing.length === 0 && !forbidden && !wrongSource;
	if (missing.length > 0) reasons.push("missing_successful_required_route");
	if (forbidden) reasons.push("forbidden_tool_use");
	if (wrongSource) reasons.push("wrong_data_source");
	return { passed: reasons.length === 0, reasons, resultCorrect, routesCorrect };
}

/** Explicit projection prevents answer-key fields being serialized to a worker. */
export function toAgentInput(
	task: AgentTask,
	controls: Omit<AgentInput, "version" | "prompt" | "servers">,
): AgentInput {
	return {
		version: 1,
		prompt: task.prompt,
		servers: task.servers.map(server => ({ name: server.name, profile: server.profile })),
		model: controls.model,
		...(controls.baseUrl === undefined ? {} : { baseUrl: controls.baseUrl }),
		...(controls.modelProfile === undefined ? {} : { modelProfile: controls.modelProfile }),
		timeoutMs: controls.timeoutMs,
		maxRequests: controls.maxRequests,
		maxToolCalls: controls.maxToolCalls,
		maxOutputTokens: controls.maxOutputTokens,
		temperature: controls.temperature,
	};
}
