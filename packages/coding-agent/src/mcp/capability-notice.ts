import { prompt } from "@oh-my-pi/pi-utils";
import capabilityStatePrompt from "../prompts/system/mcp-capability-state.md" with { type: "text" };
import type { CustomMessage } from "../session/messages";
import type { MCPToolOriginSource } from "./tool-bridge";

export const MCP_CAPABILITY_STATE_TYPE = "mcp-capability-state";
const MAX_NOTICE_DATA_BYTES = 8_000;
const MAX_NOTICE_ENTRIES = 32;

export interface MCPExtensionCandidate {
	readonly owner: string;
	readonly tool: MCPToolOriginSource;
}

export interface MCPRouteIdentity {
	readonly name: string;
	readonly mcpServerName: string;
	readonly mcpToolName: string;
}

/** Keep identity only: no tool closures, credentials, schemas or external descriptions. */
export function copyMCPRouteIdentities(tools: Iterable<MCPToolOriginSource>): MCPRouteIdentity[] {
	const routes = new Map<string, MCPRouteIdentity>();
	for (const tool of tools) {
		if (typeof tool.mcpServerName !== "string" || typeof tool.mcpToolName !== "string") continue;
		const route = { name: tool.name, mcpServerName: tool.mcpServerName, mcpToolName: tool.mcpToolName };
		routes.set(JSON.stringify([route.name, route.mcpServerName, route.mcpToolName]), route);
	}
	return [...routes.values()];
}

function originKey(route: MCPRouteIdentity): string {
	return JSON.stringify([route.mcpServerName, route.mcpToolName]);
}

interface CollisionEntry {
	wireName: string;
	unavailable: { server: string; tool: string };
	registered: { server: string; tool: string; enabled: boolean };
}

/** JSON data in an XML prompt: preserve exact identities without allowing markup/control injection. */
function quoteCollision(entry: CollisionEntry): string {
	return JSON.stringify(entry).replace(
		/[<>&`\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
		character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/**
 * A replaceable provider-context snapshot, never a steer/follow-up or transcript append.
 * Refresh coalesces naturally: only the last successfully committed registry is projected.
 * Each request has at most one notice; unchanged refreshes preserve identical content.
 */
export class MCPCapabilityNotice {
	#message: CustomMessage | undefined;
	#dataSignature: string | undefined;
	#observedCollision = false;

	get message(): CustomMessage | undefined {
		return this.#message;
	}

	update(
		candidates: Iterable<MCPToolOriginSource>,
		registry: Iterable<MCPToolOriginSource>,
		enabled: ReadonlySet<string>,
	): void {
		const registered = copyMCPRouteIdentities(registry);
		const byName = new Map(registered.map(route => [route.name, route]));
		const registeredOrigins = new Set(registered.map(originKey));
		const conflicts = copyMCPRouteIdentities(candidates).flatMap(route => {
			const winner = byName.get(route.name);
			// Inspect the committed winner, not an intermediate pairwise arbitration.
			// A candidate with another registered alias has not lost this capability.
			if (!winner || registeredOrigins.has(originKey(route))) return [];
			return [
				{
					wireName: route.name,
					unavailable: { server: route.mcpServerName, tool: route.mcpToolName },
					registered: {
						server: winner.mcpServerName,
						tool: winner.mcpToolName,
						enabled: enabled.has(winner.name),
					},
				},
			];
		});
		conflicts.sort((a, b) => {
			const x = JSON.stringify(a),
				y = JSON.stringify(b);
			return x < y ? -1 : x > y ? 1 : 0;
		});
		if (conflicts.length > 0) this.#observedCollision = true;
		if (!this.#observedCollision) return;
		let bytes = 2;
		const rows: string[] = [];
		for (const conflict of conflicts) {
			const row = quoteCollision(conflict);
			const size = Buffer.byteLength(row, "utf8") + 1;
			if (rows.length >= MAX_NOTICE_ENTRIES || bytes + size > MAX_NOTICE_DATA_BYTES) continue;
			rows.push(row);
			bytes += size;
		}
		const data = `[${rows.join(",")} ]`;
		const blockedCount = conflicts.length,
			omittedCount = conflicts.length - rows.length;
		const signature = JSON.stringify([blockedCount, omittedCount, data]);
		if (signature === this.#dataSignature) return;
		this.#dataSignature = signature;
		this.#message = {
			role: "custom",
			customType: MCP_CAPABILITY_STATE_TYPE,
			content: prompt.render(capabilityStatePrompt, { blockedCount, omittedCount, data }),
			details: { version: 1, blockedCount, omittedCount },
			attribution: "agent",
			display: false,
			timestamp: Date.now(),
		};
	}
}
