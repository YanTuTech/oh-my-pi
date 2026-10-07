#!/usr/bin/env bun
/**
 * Deterministic stdio MCP server for the metaharness `mcp` adapter.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the wire format of OMP's
 * `StdioTransport`), same shape as coding-agent's own test fixtures
 * (`packages/coding-agent/test/fixtures/many-tools-mcp.ts`). Every response is
 * a pure function of the request, so an `mcp` benchmark run is byte-reproducible
 * with **no network and no credentials**.
 *
 * Profiles:
 * - `alpha` / `beta` — two servers with disjoint tools.
 * - `alpha-dup` — a *genuine* collision fixture. Its server name `paper.search`
 *   sanitizes to `paper_search`, identical to `alpha`'s `paper-search`, so
 *   `createMCPToolName` mints the SAME wire name for both. This mirrors the real
 *   collision the harness guards against (`tool-bridge.ts` `foo.bar` vs
 *   `foo_bar`), and is what `deduplicateMCPToolsByName` has to arbitrate.
 *
 * Usage:
 *   bun adapters/mcp/fake-mcp-server.ts --profile alpha
 */
import * as readline from "node:readline";

export interface FakeToolSpec {
	name: string;
	description: string;
	inputSchema?: Record<string, unknown>;
}

export interface FakeProfile {
	/**
	 * The name the harness connects under. `createMCPToolName` lowercases and
	 * replaces every non-`[a-z_]` run with `_`, so `paper-search` and
	 * `paper.search` mint the same `mcp__paper_search_<tool>`.
	 */
	serverName: string;
	tools: FakeToolSpec[];
}

const OBJECT_ARGS: Record<string, unknown> = {
	type: "object",
	properties: { query: { type: "string" }, limit: { type: "number" } },
	additionalProperties: false,
};

const SEARCH_PAPERS: FakeToolSpec = {
	name: "search_papers",
	description: "Search the paper index by keyword query.",
	inputSchema: OBJECT_ARGS,
};
const GET_PAPER: FakeToolSpec = {
	name: "get_paper",
	description: "Fetch one paper record by its id.",
	inputSchema: OBJECT_ARGS,
};

export const PROFILES: Record<string, FakeProfile> = {
	alpha: { serverName: "paper-search", tools: [SEARCH_PAPERS, GET_PAPER] },
	beta: {
		serverName: "paper-stats",
		tools: [
			{ name: "list_categories", description: "List the taxonomy categories.", inputSchema: OBJECT_ARGS },
			{ name: "count_by_year", description: "Count indexed papers in a given year.", inputSchema: OBJECT_ARGS },
		],
	},
	// `paper.search` sanitizes to `paper_search` → same minted names as `alpha`.
	"alpha-dup": {
		serverName: "paper.search",
		tools: [
			{ ...SEARCH_PAPERS, description: "Search a DIFFERENT index (genuine name-collision fixture)." },
			{ ...GET_PAPER, description: "Fetch one record (genuine name-collision fixture)." },
		],
	},
};

export function profileTools(profile: string): FakeToolSpec[] {
	return PROFILES[profile]?.tools ?? [];
}

export function profileServerName(profile: string): string {
	return PROFILES[profile]?.serverName ?? `fake-${profile}`;
}

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: Record<string, unknown>;
};

function buildResult(
	method: string,
	params: Record<string, unknown> | undefined,
	profile: string,
): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: profileServerName(profile), version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return { tools: profileTools(profile) };
		case "tools/call": {
			const name = typeof params?.name === "string" ? params.name : "unknown";
			const known = profileTools(profile).some(tool => tool.name === name);
			// A call to an unknown tool is an error result, which the adapter must
			// count as a tool failure rather than a task success.
			return known
				? { content: [{ type: "text", text: `ok:${name}:${profileServerName(profile)}` }], isError: false }
				: { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
		}
		default:
			return {};
	}
}

function startServer(): void {
	const profileIndex = process.argv.indexOf("--profile");
	const profile = profileIndex >= 0 ? (process.argv[profileIndex + 1] ?? "alpha") : "alpha";
	const delayIndex = process.argv.indexOf("--delay");
	const initializeDelayMs = delayIndex >= 0 ? Number(process.argv[delayIndex + 1]) || 0 : 0;

	const rl = readline.createInterface({ input: process.stdin });
	rl.on("line", line => {
		void (async () => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			let msg: JsonRpcRequest;
			try {
				msg = JSON.parse(trimmed) as JsonRpcRequest;
			} catch {
				return;
			}
			// Notifications (no `id`) get no response.
			if (msg.id === undefined || msg.id === null) return;
			if (msg.method === "initialize" && initializeDelayMs > 0) {
				await Bun.sleep(initializeDelayMs);
			}
			const response = { jsonrpc: "2.0" as const, id: msg.id, result: buildResult(msg.method, msg.params, profile) };
			process.stdout.write(`${JSON.stringify(response)}\n`);
		})();
	});
	rl.on("close", () => process.exit(0));
}

if (import.meta.main) {
	startServer();
}
