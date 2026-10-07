import * as path from "node:path";
import { sha256 } from "../../src/harness-source";
import { AGENT_TASKS, type AgentTask, gradeAgentTask, type TaskGrade, toAgentInput } from "./agent-cases";
import type { AgentInput, AgentOutput } from "./agent-protocol";
import { CHALLENGE_TASKS, type ChallengeGrade, type ChallengeTask, gradeChallengeTask } from "./challenge-cases";

export type AgentSuite = "mcp-smoke-v1" | "mcp-challenge-v2";
export type BenchmarkTask = AgentTask | ChallengeTask;
export type BenchmarkGrade = TaskGrade | ChallengeGrade;

const EVALUATOR_FILES = [
	"agent-cases.ts",
	"agent-runner.ts",
	"agent-protocol.ts",
	"agent-scheduling.ts",
	"agent-suites.ts",
	"challenge-cases.ts",
	"challenge-data.ts",
	"challenge-fixture-server.ts",
	"challenge-prompts/read.md",
	"challenge-prompts/both.md",
	"challenge-prompts/search.md",
];

/** Used by both execution and independent regrading; a changed evaluator is never silently substituted. */
export async function suiteSourceDigests(
	suite: AgentSuite,
): Promise<{ evaluatorDigest: string; fixtureDigest: string }> {
	const digest = async (files: string[]) =>
		sha256(
			JSON.stringify(
				await Promise.all(
					files.map(async name => [name, sha256(await Bun.file(path.join(import.meta.dir, name)).bytes())]),
				),
			),
		);
	return {
		evaluatorDigest: await digest(EVALUATOR_FILES),
		fixtureDigest: await digest(
			suite === "mcp-smoke-v1" ? ["agent-fixture-server.ts"] : ["challenge-data.ts", "challenge-fixture-server.ts"],
		),
	};
}

export function parseAgentSuite(value: unknown = "mcp-smoke-v1"): AgentSuite {
	if (value !== "mcp-smoke-v1" && value !== "mcp-challenge-v2") throw new Error("Unknown MCP agent suite");
	return value;
}

export function tasksForSuite(suite: AgentSuite): BenchmarkTask[] {
	return structuredClone(suite === "mcp-smoke-v1" ? AGENT_TASKS : CHALLENGE_TASKS);
}

export function isChallengeTask(task: BenchmarkTask): task is ChallengeTask {
	return "suite" in task && task.suite === "mcp-challenge-v2";
}

export function gradeBenchmarkTask(task: BenchmarkTask, output: AgentOutput): BenchmarkGrade {
	return isChallengeTask(task) ? gradeChallengeTask(task, output) : gradeAgentTask(task, output);
}

/** Only fixture routing enters the worker. Goals/answers and grading modules stay in the parent. */
export function toBenchmarkInput(
	task: BenchmarkTask,
	controls: Omit<AgentInput, "version" | "prompt" | "servers">,
): AgentInput {
	const input = toAgentInput(task, controls);
	if (isChallengeTask(task))
		input.servers = task.servers.map(server => ({ name: server.name, profile: server.profile, seed: server.seed }));
	return input;
}

export function validateSuiteTasks(tasks: BenchmarkTask[], suite: AgentSuite): void {
	if (tasks.some(task => isChallengeTask(task) !== (suite === "mcp-challenge-v2")))
		throw new Error("Cannot mix v1 and v2 tasks or graders in one run");
	if (suite === "mcp-challenge-v2") {
		for (const task of tasks) {
			const canonical = CHALLENGE_TASKS.find(item => item.id === task.id);
			if (!canonical || JSON.stringify(canonical) !== JSON.stringify(task))
				throw new Error("v2 task differs from its versioned definition");
		}
	}
}
