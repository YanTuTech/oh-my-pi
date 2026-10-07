/**
 * Executor for the `mcp` benchmark adapter.
 *
 * Two kinds of signal are produced, and they must not be confused:
 *
 * 1. **Harness observations** — measured on OMP's own MCP pipeline, independent
 *    of any model. The runner builds tools with the real `createMCPToolName` and
 *    arbitrates collisions with the real `deduplicateMCPToolsByName`, then
 *    reports what that machinery actually did: how many tools a name collision
 *    silently dropped (`collision_errors`) and whether every minted name is a
 *    legal wire name (`tool_name_compliance`). This is the part that can grade a
 *    *harness variant* directly.
 *
 * 2. **Behaviour stand-ins** — a `policy` decides what tool calls to make, so the
 *    selection/precision metrics can be shown to discriminate. A policy is NOT a
 *    model: it exists to prove the metrics move. Grading a real agent means
 *    replacing the policy, not tuning it.
 *
 * Tool identity everywhere is the minted wire name (`mcp__<server>_<tool>`), the
 * same key the model must call. Calls are issued with the original MCP tool name,
 * matching `MCPTool.execute`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { callTool, connectToServer, disconnectServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { deduplicateMCPToolsByName, MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConfig, MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { profileServerName } from "./fake-mcp-server";
import type { McpTask } from "./tasks";

/** How the stand-in agent behaves when choosing tools. Not a model. */
export type McpPolicy = "correct" | "overcall" | "misselection";

export const MCP_POLICIES: McpPolicy[] = ["correct", "overcall", "misselection"];

/** Wire names must satisfy the strictest provider validator. */
const WIRE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolCallStat {
	calls: number;
	successes: number;
	failures: number;
}

export interface McpRunResult {
	runIndex: number;
	success: boolean;
	error?: string;
	duration: number;
	tokens: { input: number; output: number; reasoning: number };
	/** Keyed by minted wire name. */
	toolCalls: Record<string, ToolCallStat>;
	expected: { called: readonly string[]; forbiddenCalled: readonly string[] };
	/** Tools dropped by name-collision arbitration in this run. */
	collisionErrors: number;
	/** Fraction of minted names that are legal wire names. */
	toolNameCompliance: number;
	policy: McpPolicy;
	/** Minted wire names actually invoked (e.g. `mcp__paper_search_search_papers`). */
	calledIdentities: string[];
	/** Original MCP tool names actually invoked (e.g. `search_papers`). */
	calledToolNames: string[];
}

export interface McpTaskResult {
	id: string;
	name: string;
	runs: McpRunResult[];
}

export interface McpBenchmarkResult {
	mode: "deterministic";
	tasks: McpTaskResult[];
	summary: {
		totalRuns: number;
		successfulRuns: number;
		taskSuccessRate: number;
		toolSuccessRate: number;
		selectionPrecision: number;
		relevanceF1: number;
		callsPerTask: number;
		collisionErrors: number;
		toolNameCompliance: number;
		totalTokens: { input: number; output: number };
	};
}

export interface McpRunConfig {
	policy: McpPolicy;
	runsPerTask: number;
	fakeServerPath: string;
	dumpDir?: string;
	onProgress?: (taskId: string, runIndex: number, success: boolean) => void;
}

interface ResolvedTools {
	connections: MCPServerConnection[];
	/** Post-arbitration tools, i.e. exactly what the model would see. */
	tools: MCPTool[];
	/** How many tools a name collision removed. */
	dropped: number;
}

/**
 * Connect the task's servers and run the tools through the **real** pipeline:
 * `MCPTool.fromTools` mints names via `createMCPToolName`, then
 * `deduplicateMCPToolsByName` arbitrates. Nothing here re-implements naming.
 */
async function resolveTools(task: McpTask, fakeServerPath: string): Promise<ResolvedTools> {
	const connections: MCPServerConnection[] = [];
	const minted: MCPTool[] = [];

	for (const profile of task.servers) {
		const serverName = profileServerName(profile);
		const config: MCPServerConfig = {
			type: "stdio",
			command: process.execPath.endsWith("bun") ? process.execPath : "bun",
			args: [fakeServerPath, "--profile", profile],
		};
		const connection = await connectToServer(serverName, config, {});
		connections.push(connection);
		const advertised = await listTools(connection);
		minted.push(...MCPTool.fromTools(connection, advertised));
	}

	const deduplicated = deduplicateMCPToolsByName(minted);
	return { connections, tools: deduplicated, dropped: minted.length - deduplicated.length };
}

/** Decide which tools the policy will attempt, in order. */
function planCalls(task: McpTask, tools: MCPTool[], policy: McpPolicy): MCPTool[] {
	const shortName = (tool: MCPTool) => tool.mcpToolName;
	const forbidden = task.expected?.forbiddenCalled ?? [];
	const pickWrong = () => tools.find(tool => forbidden.includes(shortName(tool)));
	const planned: MCPTool[] = [];

	if (policy === "misselection") {
		// Never touch the expected set: call one explicitly-forbidden tool instead.
		const wrong = pickWrong();
		if (wrong) planned.push(wrong);
		return planned;
	}

	for (const short of task.expected?.called ?? []) {
		const tool = tools.find(candidate => shortName(candidate) === short);
		if (tool) planned.push(tool);
	}
	if (policy === "overcall") {
		const extra = pickWrong();
		if (extra) planned.push(extra);
	}
	return planned;
}

async function runOnce(task: McpTask, runIndex: number, config: McpRunConfig): Promise<McpRunResult> {
	const startedAt = Date.now();
	const toolCalls: Record<string, ToolCallStat> = {};
	const calledIdentities: string[] = [];
	const calledToolNames: string[] = [];
	const record = (identity: string, ok: boolean) => {
		toolCalls[identity] ??= { calls: 0, successes: 0, failures: 0 };
		const stat = toolCalls[identity];
		stat.calls += 1;
		if (ok) stat.successes += 1;
		else stat.failures += 1;
	};

	let connectionSet: MCPServerConnection[] = [];
	try {
		const { connections, tools, dropped } = await resolveTools(task, config.fakeServerPath);
		connectionSet = connections;
		const compliance =
			tools.length > 0 ? tools.filter(tool => WIRE_NAME_PATTERN.test(tool.name)).length / tools.length : 1;
		const planned = planCalls(task, tools, config.policy);

		for (const tool of planned) {
			const connection = connections.find(candidate => candidate.name === tool.mcpServerName);
			if (!connection) {
				record(tool.name, false);
				calledIdentities.push(tool.name);
				calledToolNames.push(tool.mcpToolName);
				continue;
			}
			try {
				// Call with the ORIGINAL MCP name, exactly as MCPTool.execute does.
				const result = await callTool(connection, tool.mcpToolName, { query: task.prompt });
				record(tool.name, result.isError !== true);
			} catch {
				record(tool.name, false);
			}
			calledIdentities.push(tool.name);
			calledToolNames.push(tool.mcpToolName);
		}

		const calledShorts = new Set(planned.map(tool => tool.mcpToolName));
		const expectedCalled = task.expected?.called ?? [];
		const forbidden = task.expected?.forbiddenCalled ?? [];
		const missing = expectedCalled.filter(name => !calledShorts.has(name));
		const violated = forbidden.filter(name => calledShorts.has(name));
		// `dropped` is an observation of the harness, so a collision task only
		// passes when arbitration actually had something to arbitrate.
		const collisionOk = task.expectCollision === true ? dropped > 0 : dropped === 0;
		const failures = Object.values(toolCalls).some(stat => stat.failures > 0);
		const success = missing.length === 0 && violated.length === 0 && collisionOk && !failures;

		return {
			runIndex,
			success,
			error: success
				? undefined
				: `missing=[${missing.join(",")}] violated=[${violated.join(",")}] dropped=${dropped}`,
			duration: Date.now() - startedAt,
			tokens: { input: 0, output: 0, reasoning: 0 },
			toolCalls,
			expected: { called: expectedCalled, forbiddenCalled: forbidden },
			collisionErrors: dropped,
			toolNameCompliance: compliance,
			policy: config.policy,
			calledIdentities,
			calledToolNames,
		};
	} catch (error) {
		return {
			runIndex,
			success: false,
			error: error instanceof Error ? error.message : String(error),
			duration: Date.now() - startedAt,
			tokens: { input: 0, output: 0, reasoning: 0 },
			toolCalls,
			expected: { called: task.expected?.called ?? [], forbiddenCalled: task.expected?.forbiddenCalled ?? [] },
			collisionErrors: 0,
			toolNameCompliance: 0,
			policy: config.policy,
			calledIdentities,
			calledToolNames,
		};
	} finally {
		for (const connection of connectionSet) {
			await disconnectServer(connection).catch(() => {});
		}
	}
}

/** Write a per-run markdown dump. */
async function writeRunDump(jobDir: string, task: McpTask, run: McpRunResult): Promise<void> {
	const dir = path.join(jobDir, "result.dump", task.id.replace(/[^a-zA-Z0-9._-]/g, "_"));
	await fs.mkdir(dir, { recursive: true });
	const lines = [
		`# ${task.id} — run ${run.runIndex + 1}`,
		"",
		`- prompt: ${task.prompt}`,
		`- servers: ${task.servers.join(", ")}`,
		`- policy: ${run.policy}`,
		`- success: ${run.success}`,
		`- collisionErrors (tools dropped): ${run.collisionErrors}`,
		`- toolNameCompliance: ${run.toolNameCompliance}`,
		run.error ? `- error: ${run.error}` : "",
		"",
		"## tool calls (minted wire name)",
		"",
		...Object.entries(run.toolCalls).map(
			([identity, stat]) => `- ${identity}: calls=${stat.calls} ok=${stat.successes} fail=${stat.failures}`,
		),
		"",
	];
	await fs.writeFile(
		path.join(dir, `run-${run.runIndex + 1}.md`),
		lines.filter(line => line !== "").join("\n"),
		"utf8",
	);
}

function summarize(tasks: McpTaskResult[]): McpBenchmarkResult["summary"] {
	let totalRuns = 0;
	let successfulRuns = 0;
	let toolCalls = 0;
	let toolSuccesses = 0;
	let truePositive = 0;
	let falsePositive = 0;
	let falseNegative = 0;
	let collisionErrors = 0;
	let complianceSum = 0;
	let tokIn = 0;
	let tokOut = 0;

	for (const task of tasks) {
		for (const run of task.runs) {
			totalRuns += 1;
			if (run.success) successfulRuns += 1;
			collisionErrors += run.collisionErrors;
			complianceSum += run.toolNameCompliance;
			tokIn += run.tokens.input;
			tokOut += run.tokens.output;

			const calledShorts = new Set(run.calledToolNames);
			const expectedCalled = new Set(run.expected.called);

			for (const stat of Object.values(run.toolCalls)) {
				toolCalls += stat.calls;
				toolSuccesses += stat.successes;
			}
			for (const short of calledShorts) {
				if (expectedCalled.has(short)) truePositive += 1;
				else falsePositive += 1;
			}
			for (const short of expectedCalled) {
				if (!calledShorts.has(short)) falseNegative += 1;
			}
		}
	}

	const precision = truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : null;
	const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : null;
	const f1 =
		precision !== null && recall !== null && precision + recall > 0
			? (2 * precision * recall) / (precision + recall)
			: null;

	return {
		totalRuns,
		successfulRuns,
		taskSuccessRate: totalRuns > 0 ? successfulRuns / totalRuns : 0,
		toolSuccessRate: toolCalls > 0 ? toolSuccesses / toolCalls : 0,
		selectionPrecision: precision ?? 0,
		relevanceF1: f1 ?? 0,
		callsPerTask: totalRuns > 0 ? toolCalls / totalRuns : 0,
		collisionErrors,
		toolNameCompliance: totalRuns > 0 ? complianceSum / totalRuns : 1,
		totalTokens: { input: tokIn, output: tokOut },
	};
}

/** Run every task and materialize the native `result.json` artifact. */
export async function runMcpBenchmark(
	tasks: McpTask[],
	config: McpRunConfig,
	outputPath: string,
): Promise<McpBenchmarkResult> {
	const results: McpTaskResult[] = [];
	for (const task of tasks) {
		const runs: McpRunResult[] = [];
		for (let runIndex = 0; runIndex < config.runsPerTask; runIndex++) {
			const run = await runOnce(task, runIndex, config);
			runs.push(run);
			config.onProgress?.(task.id, runIndex, run.success);
			if (config.dumpDir) await writeRunDump(config.dumpDir, task, run);
		}
		results.push({ id: task.id, name: task.name, runs });
	}
	const result: McpBenchmarkResult = { mode: "deterministic", tasks: results, summary: summarize(results) };
	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
	return result;
}
