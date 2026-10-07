/**
 * Task contract for the `mcp` benchmark adapter.
 *
 * A task is a (server set, prompt, expected tool behaviour) triple. Expectations
 * are declared as tool *short names*; the runner resolves them against the union
 * of tools advertised by the task's servers and reports ambiguity as a collision
 * rather than picking a winner. Every expectation maps to exactly one graded
 * metric — nothing here is decorative:
 *
 *   expected.called        → selection_precision (did it pick the right tool?)
 *   expected.forbiddenCalled → relevance_f1     (did it refrain when it should?)
 *   expectCollision        → collision_errors   (how many tools did name-collision arbitration silently drop?)
 */
import { type FakeToolSpec, PROFILES, profileTools } from "./fake-mcp-server";

export interface McpTaskExpectation {
	/** Short tool names that SHOULD be called for the task to count as correct. */
	called?: readonly string[];
	/** Short tool names that must NOT be called (relevance / restraint check). */
	forbiddenCalled?: readonly string[];
}

export interface McpTask {
	id: string;
	name: string;
	prompt: string;
	/** Fake-server profiles connected for this task, in order. */
	servers: readonly string[];
	expected?: McpTaskExpectation;
	/** The task intends to provoke a cross-server same-name collision. */
	expectCollision?: boolean;
	metadata?: { difficulty?: "easy" | "medium" | "hard"; collisionScenario?: boolean };
}

/** Short tool names available on one server profile. */
export function toolsForProfile(profile: string): FakeToolSpec[] {
	return profileTools(profile);
}

/** Every tool short name across all profiles, de-duplicated. */
export function allToolNames(): string[] {
	const names = new Set<string>();
	for (const profile of Object.values(PROFILES)) for (const tool of profile.tools) names.add(tool.name);
	return [...names];
}

/**
 * Built-in task set. It is deliberately small and fully deterministic: it exists
 * to prove the three-stage chain (launcher → adapter → reader) end to end and to
 * give `selection_precision` / `relevance_f1` / `collision_errors` a real signal
 * to move on. Task content (a larger, model-driven set) is a separate concern.
 */
export const MCP_TASKS: McpTask[] = [
	{
		id: "search-basic",
		name: "Search the paper index",
		prompt: "Find papers about retrieval augmentation.",
		servers: ["alpha"],
		expected: { called: ["search_papers"], forbiddenCalled: ["get_paper"] },
		metadata: { difficulty: "easy" },
	},
	{
		id: "fetch-by-id",
		name: "Fetch one paper record",
		prompt: "Retrieve the record for paper id 2026.0142.",
		servers: ["alpha"],
		expected: { called: ["get_paper"], forbiddenCalled: ["search_papers"] },
		metadata: { difficulty: "easy" },
	},
	{
		id: "stats-by-year",
		name: "Count papers by year",
		prompt: "How many papers were indexed in 2025?",
		servers: ["alpha", "beta"],
		expected: { called: ["count_by_year"], forbiddenCalled: ["search_papers", "get_paper", "list_categories"] },
		metadata: { difficulty: "medium" },
	},
	{
		id: "no-tool-needed",
		name: "Answer without calling a tool",
		prompt: "In one sentence, what does the term 'recall' mean in information retrieval?",
		servers: ["alpha", "beta"],
		expected: { forbiddenCalled: ["search_papers", "get_paper", "list_categories", "count_by_year"] },
		metadata: { difficulty: "medium" },
	},
	{
		// `alpha` connects as `paper-search`, `alpha-dup` as `paper.search`. Both
		// sanitize to `paper_search`, so `createMCPToolName` mints identical wire
		// names and `deduplicateMCPToolsByName` must drop one. This is the real
		// collision class (see coding-agent/test/mcp-reconnect.test.ts), not an
		// invented one. After arbitration the name is unique, so the task still
		// expects a normal call — the observable signal is `collision_errors`.
		id: "duplicate-name-collision",
		name: "Sanitize-collapsing server names",
		prompt: "Search the paper index.",
		servers: ["alpha", "alpha-dup"],
		expectCollision: true,
		expected: { called: ["search_papers"] },
		metadata: { difficulty: "hard", collisionScenario: true },
	},
];
