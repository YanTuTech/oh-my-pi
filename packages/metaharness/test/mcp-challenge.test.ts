import { describe, expect, test } from "bun:test";
import { AGENT_TASKS, gradeAgentTask } from "../adapters/mcp/agent-cases";
import {
	type AgentOutput,
	isRecord,
	type ObservedCall,
	parseAgentInput,
	parseAgentOutput,
} from "../adapters/mcp/agent-protocol";
import {
	gradeBenchmarkTask,
	parseAgentSuite,
	tasksForSuite,
	toBenchmarkInput,
	validateSuiteTasks,
} from "../adapters/mcp/agent-suites";
import { CHALLENGE_TASKS, type ChallengeTask, gradeChallengeTask } from "../adapters/mcp/challenge-cases";
import { createLibraryWorld } from "../adapters/mcp/challenge-data";
import { ChallengeLibrary } from "../adapters/mcp/challenge-fixture-server";
import { sha256 } from "../src/harness-source";
import { mcpRunnerArgs } from "../src/launch-args";

function task(id: string): ChallengeTask {
	const found = CHALLENGE_TASKS.find(item => item.id === id);
	if (!found) throw new Error("Missing test task");
	return structuredClone(found);
}
function observation(definition: ChallengeTask): AgentOutput {
	return {
		version: 1,
		entrypointDigest: "a".repeat(64),
		finalText: JSON.stringify(definition.expected),
		stop: "completed",
		requests: 3,
		calls: [],
		inventory: definition.servers.flatMap((server, index) =>
			["search_records", "get_record"].map(tool => ({
				wireName: `test_${index}_${tool}`,
				origin: { server: server.name, tool },
			})),
		),
		collisionErrors: 0,
		tokens: { input: 100, output: 20, reasoning: null, cacheRead: 0, cacheWrite: 0 },
		costUsd: 0.01,
		costSource: "catalog-estimate",
		usageComplete: true,
	};
}
function append(
	output: AgentOutput,
	definition: ChallengeTask,
	source: string,
	tool: string,
	args: Record<string, unknown>,
): ObservedCall {
	const server = definition.servers.find(item => item.name === source);
	const mounted = output.inventory.find(item => item.origin.server === source && item.origin.tool === tool);
	if (!server || server.seed === undefined || !mounted) throw new Error("Unconfigured fixture route");
	const library = new ChallengeLibrary(
		source,
		server.seed,
		server.profile === "challenge-secondary" ? "secondary" : "primary",
	);
	const result = library.handle("tools/call", { name: tool, arguments: args });
	const order = output.calls.length * 2 + 1;
	const call = {
		id: `call-${order}`,
		origin: mounted.origin,
		wireName: mounted.wireName,
		args,
		result,
		isError: result.isError === true,
		startedOrder: order,
		completedOrder: order + 1,
		modelRequestIndex: output.calls.length + 1,
	};
	output.requests = Math.max(output.requests, call.modelRequestIndex);
	output.calls.push(call);
	return call;
}
function searchTrace(definition = task("search-revision-17")): AgentOutput {
	const out = observation(definition);
	const target = definition.targets[0];
	append(out, definition, target.source, "search_records", { query: target.record.title, year: target.record.year });
	append(out, definition, target.source, "get_record", { id: target.record.id, revision: target.record.revision });
	return out;
}
function replacePayload(call: ObservedCall, update: (value: Record<string, unknown>) => void): void {
	if (
		!isRecord(call.result) ||
		!Array.isArray(call.result.content) ||
		!isRecord(call.result.content[0]) ||
		typeof call.result.content[0].text !== "string"
	)
		throw new Error("Invalid fixture result");
	const value: unknown = JSON.parse(call.result.content[0].text);
	if (!isRecord(value)) throw new Error("Expected tool JSON");
	update(value);
	call.result.content[0].text = JSON.stringify(value);
}

describe("v2 result provenance and causality", () => {
	test("a completed search must precede a dependent read, including calls launched in parallel", () => {
		const definition = task("search-revision-17");
		const correct = searchTrace(definition);
		expect(gradeChallengeTask(definition, correct).passed).toBe(true);
		const reversed = structuredClone(correct);
		reversed.calls[0].startedOrder = 3;
		reversed.calls[0].completedOrder = 4;
		reversed.calls[1].startedOrder = 1;
		reversed.calls[1].completedOrder = 2;
		expect(gradeChallengeTask(definition, reversed).reasons).toContain("read_without_completed_search_evidence");
		const concurrent = structuredClone(correct);
		concurrent.calls[0].completedOrder = 4;
		concurrent.calls[1].startedOrder = 2;
		concurrent.calls[1].completedOrder = 3;
		expect(gradeChallengeTask(definition, concurrent).passed).toBe(false);
		const preplanned = structuredClone(correct);
		preplanned.calls[1].modelRequestIndex = preplanned.calls[0].modelRequestIndex;
		expect(gradeChallengeTask(definition, preplanned).passed).toBe(false); // Serial execution of same-response guesses is not a dependency.
		// Serialization order cannot change an observed lifecycle dependency.
		correct.calls.reverse();
		expect(gradeChallengeTask(definition, correct).passed).toBe(true);
	});
	test("a guessed correct answer without a successful target read cannot pass", () => {
		const definition = task("search-revision-17");
		expect(gradeChallengeTask(definition, observation(definition)).outcome).toBe("unsupported-answer");
		const output = searchTrace(definition);
		output.calls[1].isError = true;
		expect(gradeChallengeTask(definition, output).outcome).toBe("unsupported-answer");
	});
	test("wrong IDs and stale revisions cannot be credited by an otherwise correct final answer", () => {
		const definition = task("search-revision-17");
		const wrongId = observation(definition);
		append(wrongId, definition, "catalog-main", "search_records", { query: definition.targets[0].record.title });
		append(wrongId, definition, "catalog-main", "get_record", { id: "invented", revision: 1 });
		expect(gradeChallengeTask(definition, wrongId).passed).toBe(false);
		const stale = observation(definition);
		append(stale, definition, "catalog-main", "search_records", { query: definition.targets[0].record.title });
		append(stale, definition, "catalog-main", "get_record", { id: definition.targets[0].record.id, revision: 1 });
		expect(gradeChallengeTask(definition, stale).reasons).toContain("missing_grounded_target_read");
	});
	test("a read from another data source is not rescued by identical record IDs or later correct retrieval", () => {
		const definition = task("search-secondary-17");
		const output = searchTrace(definition);
		const primary = createLibraryWorld(17, "primary").records[3];
		append(output, definition, "catalog-main", "get_record", { id: primary.id, revision: primary.revision });
		expect(gradeChallengeTask(definition, output).outcome).toBe("wrong-source");
	});
	test("returned snapshot, source, record and actual parameters must agree", () => {
		const definition = task("search-revision-17");
		const badSnapshot = searchTrace(definition);
		replacePayload(badSnapshot.calls[0], value => {
			value.snapshot = "different-snapshot";
		});
		expect(gradeChallengeTask(definition, badSnapshot).evidenceValid).toBe(false);
		const badSource = searchTrace(definition);
		replacePayload(badSource.calls[1], value => {
			value.source = "catalog-archive";
		});
		expect(gradeChallengeTask(definition, badSource).evidenceValid).toBe(false);
		const badArgs = searchTrace(definition);
		badArgs.calls[0].args = { query: "no matching record" };
		expect(gradeChallengeTask(definition, badArgs).passed).toBe(false);
	});
	test("wrong final content fails even with a valid retrieval trace", () => {
		const definition = task("search-revision-17");
		const output = searchTrace(definition);
		output.finalText = JSON.stringify({ ...definition.expected, checksum: "invented" });
		expect(gradeChallengeTask(definition, output)).toMatchObject({
			passed: false,
			resultCorrect: false,
			routesCorrect: true,
		});
	});
	test("legitimate extra searches and evidence-based verification reads remain valid", () => {
		const definition = task("search-revision-17");
		const output = searchTrace(definition);
		append(output, definition, "catalog-main", "search_records", { query: definition.targets[0].record.title });
		append(output, definition, "catalog-main", "get_record", { id: definition.targets[0].record.id, revision: 1 });
		expect(gradeChallengeTask(definition, output).passed).toBe(true);
	});
	test("missing or duplicate lifecycle evidence is not invented when grading v2", () => {
		const definition = task("search-revision-17");
		const output = searchTrace(definition);
		delete output.calls[0].completedOrder;
		expect(gradeChallengeTask(definition, output).evidenceValid).toBe(false);
		expect(() => parseAgentOutput(output)).toThrow("lifecycle");
		const duplicate = searchTrace(definition);
		duplicate.calls[1].startedOrder = duplicate.calls[0].startedOrder;
		expect(() => parseAgentOutput(duplicate)).toThrow("lifecycle");
	});
});

describe("v2 collision victim outcomes", () => {
	test("truthful capability absence is distinct from actual task completion", () => {
		const definition = task("collision-victim-17");
		const output = observation(definition);
		output.inventory = output.inventory.filter(item => item.origin.server !== "library.tools");
		output.finalText = '{"status":"unavailable","sources":["library.tools"]}';
		expect(gradeChallengeTask(definition, output)).toMatchObject({
			passed: false,
			outcome: "honest-unavailable",
			missingSources: ["library.tools"],
		});
		output.finalText = JSON.stringify(definition.expected);
		expect(gradeChallengeTask(definition, output).outcome).toBe("unsupported-answer");
		output.finalText = '{"status":"unavailable","sources":["library-tools"]}';
		expect(gradeChallengeTask(definition, output).outcome).toBe("incorrect-result");
	});
	test("unavailable claims cannot conceal an available tool or a wrong-source call", () => {
		const definition = task("collision-victim-17");
		const output = observation(definition);
		output.finalText = '{"status":"unavailable","sources":["library.tools"]}';
		expect(gradeChallengeTask(definition, output).outcome).toBe("incorrect-result");
		output.inventory = output.inventory.filter(item => item.origin.server !== "library.tools");
		const primary = createLibraryWorld(17, "primary").records[3];
		append(output, definition, "library-tools", "get_record", { id: primary.id, revision: primary.revision });
		expect(gradeChallengeTask(definition, output).outcome).toBe("wrong-source");
	});
	test("dual-source completion permits parallel independent reads but requires both sources", () => {
		const definition = task("collision-both-17");
		const output = observation(definition);
		for (const target of definition.targets)
			append(output, definition, target.source, "get_record", {
				id: target.record.id,
				revision: target.record.revision,
			});
		output.calls[0].completedOrder = 4;
		output.calls[1].startedOrder = 2;
		output.calls[1].completedOrder = 3;
		output.calls[0].modelRequestIndex = 1;
		output.calls[1].modelRequestIndex = 1;
		expect(gradeChallengeTask(definition, output).passed).toBe(true);
		output.calls.pop();
		expect(gradeChallengeTask(definition, output).passed).toBe(false);
	});
	test("spoofed wire origins and unmetered executions never receive completion credit", () => {
		const definition = task("search-revision-17");
		const output = searchTrace(definition);
		output.calls[1].wireName = "unmounted-tool";
		expect(gradeChallengeTask(definition, output).passed).toBe(false);
		const unmetered = searchTrace(definition);
		unmetered.usageComplete = false;
		expect(gradeChallengeTask(definition, unmetered).outcome).toBe("execution-error");
	});
});

describe("v2 fixture and version isolation", () => {
	test("queries select different records and explicit revisions; search never returns checksums", () => {
		const library = new ChallengeLibrary("catalog-main", 17, "primary");
		const output = (name: string, args: Record<string, unknown>) =>
			library.handle("tools/call", { name, arguments: args });
		const extract = (result: Record<string, unknown>) => {
			if (
				!Array.isArray(result.content) ||
				!isRecord(result.content[0]) ||
				typeof result.content[0].text !== "string"
			)
				throw new Error("Invalid MCP response");
			return JSON.parse(result.content[0].text) as { records?: unknown[] };
		};
		const matches = extract(output("search_records", { query: library.world.topic }));
		expect(matches.records?.length).toBe(3);
		expect(extract(output("search_records", { query: "calibration notes" })).records?.length).toBe(1);
		expect(extract(output("search_records", { query: "unrelated missing topic" })).records).toStrictEqual([]);
		expect(JSON.stringify(matches)).not.toContain("checksum");
		expect(output("get_record", { id: library.world.records[3].id }).isError).toBe(true);
		expect(createLibraryWorld(29, "primary").records[3].id).not.toBe(library.world.records[3].id);
		expect(createLibraryWorld(17, "secondary").records[3].checksum).not.toBe(library.world.records[3].checksum);
	});
	test("worker input does not include answers or task goals, even nested in server configuration", () => {
		const definition = task("search-revision-17");
		const input = toBenchmarkInput(definition, {
			model: "opencode-go/deepseek-v4.1-flash",
			timeoutMs: 1000,
			maxRequests: 8,
			maxToolCalls: 16,
			maxOutputTokens: 1024,
			temperature: 0,
		});
		parseAgentInput(input);
		expect(JSON.stringify(input)).not.toContain(definition.targets[0].record.id);
		expect(JSON.stringify(input)).not.toContain(definition.targets[0].record.checksum);
		expect(Object.keys(input)).not.toContain("targets");
		expect(() =>
			parseAgentInput({ ...input, servers: [{ ...input.servers[0], expected: definition.expected }] }),
		).toThrow("Invalid MCP servers");
		expect(() => parseAgentInput({ ...input, servers: [{ ...input.servers[0], seed: undefined }] })).toThrow(
			"Invalid MCP servers",
		);
	});
	test("v1 task identity stays unchanged and v1/v2 cannot be silently mixed or mislabeled", () => {
		expect(sha256(JSON.stringify(AGENT_TASKS))).toBe(
			"5bccde61776c0d09b4f2da0716d389fce8538712b1e95a0132af245c88329529",
		);
		expect(tasksForSuite("mcp-smoke-v1").map(item => item.id)).toStrictEqual(AGENT_TASKS.map(item => item.id));
		const legacy = observation(task("collision-victim-17"));
		legacy.calls = [];
		legacy.finalText = '{"answer":42}';
		expect(gradeBenchmarkTask(AGENT_TASKS[3], legacy)).toStrictEqual(gradeAgentTask(AGENT_TASKS[3], legacy));
		expect(() => validateSuiteTasks([AGENT_TASKS[0], CHALLENGE_TASKS[0]], "mcp-challenge-v2")).toThrow("mix");
		expect(() => validateSuiteTasks([{ ...CHALLENGE_TASKS[0], expected: {} }], "mcp-challenge-v2")).toThrow(
			"versioned definition",
		);
		expect(() => parseAgentSuite("v3")).toThrow("Unknown");
	});
	test("REST launch arguments bind the selected suite and reject conflicting datasets", () => {
		const request = { model: "opencode-go/deepseek-v4.1-flash", mcp: { suite: "mcp-challenge-v2" as const } };
		expect(mcpRunnerArgs(request, "/job")).toContain("mcp-challenge-v2");
		expect(() => mcpRunnerArgs({ model: request.model, dataset: "mcp-challenge-v2" }, "/job")).toThrow(
			"explicit mcp.suite",
		);
		expect(() => mcpRunnerArgs({ ...request, dataset: "mcp-smoke-v1" }, "/job")).toThrow("conflicts");
		expect(() => mcpRunnerArgs({ ...request, mcp: { ...request.mcp, mode: "deterministic" } }, "/job")).toThrow(
			"agent mode",
		);
	});
});
