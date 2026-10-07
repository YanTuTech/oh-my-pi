#!/usr/bin/env bun
import * as readline from "node:readline";
import { isRecord } from "./agent-protocol";

/** A controlled external data source; no task expectations or scoring logic. */
const profiles = new Set(["primary", "secondary", "flaky"]);
const profile = process.argv[2] ?? "primary";
if (!profiles.has(profile)) throw new Error("Unknown fixture profile");
let fetches = 0;
const record =
	profile === "secondary"
		? { id: "atlas-42", title: "Secondary Atlas", year: 2024, checksum: "S-91" }
		: { id: "atlas-42", title: "Retrieval Under Uncertainty", year: 2025, checksum: "P-73" };

const tools = [
	{
		name: "search_records",
		description: "Search this library for a topic; returns matching record IDs, not full records.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "get_record",
		description: "Read a full record from this library by its exact ID, including its checksum.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		},
	},
];

function textResult(value: unknown, isError = false): Record<string, unknown> {
	return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}

function handle(method: string, params: unknown): Record<string, unknown> {
	if (method === "initialize")
		return {
			protocolVersion: "2025-03-26",
			serverInfo: { name: `library-${profile}`, version: "1" },
			capabilities: { tools: {} },
		};
	if (method === "tools/list") return { tools };
	if (method === "ping") return {};
	if (method !== "tools/call" || !isRecord(params) || !isRecord(params.arguments))
		return textResult({ error: "invalid_request" }, true);
	const args = params.arguments;
	if (params.name === "search_records") {
		if (typeof args.query !== "string" || !args.query.trim() || Object.keys(args).some(key => key !== "query"))
			return textResult({ error: "query must be a nonempty string" }, true);
		return textResult({ records: [{ id: record.id }] });
	}
	if (params.name === "get_record") {
		if (args.id !== record.id || Object.keys(args).some(key => key !== "id"))
			return textResult({ error: "unknown_record" }, true);
		fetches += 1;
		if (profile === "flaky" && fetches === 1)
			return textResult({ error: "temporary_unavailable", guidance: "This read is safe to retry once." }, true);
		return textResult(record);
	}
	return textResult({ error: "unknown_tool" }, true);
}

if (import.meta.main) {
	if (process.env.MCP_BENCH_API_KEY)
		throw new Error("Model credentials must not be forwarded to MCP fixture processes");
	const input = readline.createInterface({ input: process.stdin });
	input.on("line", line => {
		if (line.length > 65_536) return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (
			!isRecord(message) ||
			(typeof message.id !== "string" && typeof message.id !== "number") ||
			typeof message.method !== "string"
		)
			return;
		process.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: handle(message.method, message.params) })}\n`,
		);
	});
	input.on("close", () => process.exit(0));
}
