#!/usr/bin/env bun
import * as readline from "node:readline";
import { isRecord } from "./agent-protocol";
import { type ChallengeSide, createLibraryWorld, type LibraryWorld, searchLibrary } from "./challenge-data";

const tools = [
	{
		name: "search_records",
		description:
			"Search this library by words in a title or an exact ID. Optional year filters publication year. Returns IDs, revisions, titles and years, with source and snapshot; not checksums.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" }, year: { type: "integer" } },
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "get_record",
		description:
			"Read one exact ID and revision from this library. Both fields are required. Returns the full record including checksum, source and snapshot. Do not substitute another library's record with the same ID.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" }, revision: { type: "integer" } },
			required: ["id", "revision"],
			additionalProperties: false,
		},
	},
];

function textResult(value: unknown, isError = false): Record<string, unknown> {
	return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}

/** Shared protocol implementation; no task ID, expected answer or scoring module is loaded. */
export class ChallengeLibrary {
	readonly world: LibraryWorld;
	constructor(
		readonly source: string,
		seed: number,
		side: ChallengeSide,
	) {
		if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(source)) throw new Error("Invalid library name");
		this.world = createLibraryWorld(seed, side);
	}

	handle(method: string, params: unknown): Record<string, unknown> {
		if (method === "initialize")
			return {
				protocolVersion: "2025-03-26",
				serverInfo: { name: this.source, version: "2" },
				capabilities: { tools: {} },
			};
		if (method === "tools/list") return { tools };
		if (method === "ping") return {};
		if (method !== "tools/call" || !isRecord(params) || !isRecord(params.arguments))
			return textResult({ error: "invalid_request" }, true);
		const args = params.arguments;
		const provenance = { source: this.source, snapshot: this.world.snapshot };
		if (params.name === "search_records") {
			if (
				typeof args.query !== "string" ||
				!args.query.trim() ||
				args.query.length > 256 ||
				(args.year !== undefined && !Number.isSafeInteger(args.year)) ||
				Object.keys(args).some(key => !["query", "year"].includes(key))
			)
				return textResult({ error: "invalid_search_arguments" }, true);
			const matches = searchLibrary(this.world, args.query, args.year === undefined ? undefined : Number(args.year));
			return textResult({
				...provenance,
				records: matches.map(({ id, revision, title, year }) => ({ id, revision, title, year })),
			});
		}
		if (params.name === "get_record") {
			if (
				typeof args.id !== "string" ||
				!Number.isSafeInteger(args.revision) ||
				Object.keys(args).some(key => !["id", "revision"].includes(key))
			)
				return textResult({ error: "invalid_read_arguments" }, true);
			const record = this.world.records.find(item => item.id === args.id && item.revision === args.revision);
			return record
				? textResult({ ...provenance, record })
				: textResult({ ...provenance, error: "unknown_record_or_revision" }, true);
		}
		return textResult({ error: "unknown_tool" }, true);
	}
}

if (import.meta.main) {
	if (process.env.MCP_BENCH_API_KEY) throw new Error("Model credentials must not reach fixture processes");
	const [profile, seed, name] = process.argv.slice(2);
	if (profile !== "challenge-primary" && profile !== "challenge-secondary")
		throw new Error("Unknown challenge profile");
	const library = new ChallengeLibrary(name, Number(seed), profile === "challenge-primary" ? "primary" : "secondary");
	const input = readline.createInterface({ input: process.stdin });
	input.on("line", line => {
		if (line.length > 65536) return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (
			!isRecord(message) ||
			(typeof message.id !== "number" && typeof message.id !== "string") ||
			typeof message.method !== "string"
		)
			return;
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: library.handle(message.method, message.params) })}\n`,
		);
	});
	input.on("close", () => process.exit(0));
}
