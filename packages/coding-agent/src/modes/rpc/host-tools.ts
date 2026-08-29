import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { applyToolProxy } from "../../extensibility/tool-proxy";
import type { Theme } from "../../extensibility/ui-contract";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { assertJsonWireValue, canonicalJson, compareCanonicalJsonStrings } from "../../utils/canonical-json";
import type {
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
} from "./rpc-types";

type RpcHostToolOutput = (frame: RpcHostToolCallRequest | RpcHostToolCancelRequest) => void;

export interface RpcHostToolConstraints {
	readonly allowedSkillUris?: readonly string[];
}

type PendingHostToolCall = {
	resolve: (result: AgentToolResult<unknown>) => void;
	reject: (error: Error) => void;
	onUpdate?: AgentToolUpdateCallback<unknown>;
};

const MANAGED_CAPABILITY_ARGUMENT_LIMITS = {
	maxDepth: 16,
	maxNodes: 4_096,
	maxObjectKeys: 128,
	maxArrayLength: 1_024,
	maxStringBytes: 32_768,
	maxSerializedBytes: 65_536,
} as const;

const MANAGED_TOOL_NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const MANAGED_DISPATCH_ID_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/u;

export function isManagedRpcHostToolIdentifier(value: string, kind: "name" | "dispatchId"): boolean {
	const maximumLength = kind === "name" ? 128 : 256;
	const pattern = kind === "name" ? MANAGED_TOOL_NAME_PATTERN : MANAGED_DISPATCH_ID_PATTERN;
	return value.length > 0 && value.length <= maximumLength && pattern.test(value);
}

export function canonicalRpcHostToolArguments(argumentsValue: Record<string, unknown>): string {
	assertJsonWireValue(argumentsValue, true);
	for (const key of Object.keys(argumentsValue)) {
		if (key.length === 0 || key.length > 128) {
			throw new RangeError("Capability argument keys must contain 1 to 128 UTF-16 code units");
		}
	}
	return canonicalJson(argumentsValue, MANAGED_CAPABILITY_ARGUMENT_LIMITS);
}

function isAgentToolResult(value: unknown): value is AgentToolResult<unknown> {
	if (!value || typeof value !== "object") return false;
	const content = (value as { content?: unknown }).content;
	return Array.isArray(content);
}

export function isRpcHostToolResult(value: unknown): value is RpcHostToolResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; result?: unknown };
	return frame.type === "host_tool_result" && typeof frame.id === "string" && isAgentToolResult(frame.result);
}

export function isRpcHostToolUpdate(value: unknown): value is RpcHostToolUpdate {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown; partialResult?: unknown };
	return frame.type === "host_tool_update" && typeof frame.id === "string" && isAgentToolResult(frame.partialResult);
}

export function createRpcHostToolManifestDigest(tools: readonly RpcHostToolDefinition[]): string {
	return Bun.SHA256.hash(canonicalRpcHostToolManifest(tools), "hex");
}

/**
 * Canonical Effective Tool Manifest shared by both RPC peers. Every field that
 * changes model visibility, prompting, schema validation, or provider routing
 * is authenticated. `dispatchId` is the versioned provider route identity.
 */
export function canonicalRpcHostToolManifest(tools: readonly RpcHostToolDefinition[]): string {
	const manifest = tools
		.map((tool, index) => normalizeRpcHostToolDefinition(tool, index))
		.map(tool => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			hidden: tool.hidden,
			loadMode: tool.loadMode,
			dispatchId: tool.dispatchId,
			capabilityKind: tool.capabilityKind,
		}))
		.sort((left, right) =>
			compareCanonicalJsonStrings(
				`${left.dispatchId ?? ""}\0${left.name}`,
				`${right.dispatchId ?? ""}\0${right.name}`,
			),
		);
	return canonicalJson(manifest);
}

export function normalizeRpcHostToolDefinitions(tools: readonly RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	const normalized = tools.map((tool, index) => normalizeRpcHostToolDefinition(tool, index));
	if (new Set(normalized.map(tool => tool.name)).size !== normalized.length) {
		throw new Error("Host tool names must be unique");
	}
	const dispatchIds = normalized.flatMap(tool => (tool.dispatchId === undefined ? [] : [tool.dispatchId]));
	if (new Set(dispatchIds).size !== dispatchIds.length) {
		throw new Error("Host tool dispatch ids must be unique");
	}
	return normalized;
}

function normalizeRpcHostToolDefinition(tool: RpcHostToolDefinition, index: number): RpcHostToolDefinition {
	const name = typeof tool.name === "string" ? tool.name.trim() : "";
	if (!name) throw new Error(`Host tool at index ${index} must provide a non-empty name`);
	const description = typeof tool.description === "string" ? tool.description.trim() : "";
	if (!description) throw new Error(`Host tool "${name}" must provide a non-empty description`);
	if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
		throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
	}
	assertJsonWireValue(tool.parameters, true);
	const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
	return {
		name,
		label,
		description,
		parameters: tool.parameters,
		hidden: tool.hidden === true,
		loadMode: defaultLoadModeForToolName(name, tool.loadMode),
		capabilityKind: tool.capabilityKind,
		dispatchId: tool.dispatchId,
	};
}

class RpcHostToolAdapter<TParams extends TSchema = TSchema, TTheme extends Theme = Theme>
	implements AgentTool<TParams, unknown, TTheme>
{
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict = true;
	concurrency: "shared" | "exclusive" = "shared";
	readonly loadMode: ToolLoadMode;
	#bridge: RpcHostToolBridge;
	#definition: RpcHostToolDefinition;
	#constraints: RpcHostToolConstraints;

	constructor(definition: RpcHostToolDefinition, bridge: RpcHostToolBridge, constraints: RpcHostToolConstraints = {}) {
		this.#definition = definition;
		this.#bridge = bridge;
		this.#constraints = constraints;
		applyToolProxy(definition, this);
		this.loadMode = defaultLoadModeForToolName(definition.name, definition.loadMode);
	}

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		if (this.#definition.name === "skill_read" && this.#constraints.allowedSkillUris !== undefined) {
			const uri = (params as Record<string, unknown>).uri;
			const allowed =
				typeof uri === "string" &&
				this.#constraints.allowedSkillUris.some(root => uri === root || uri.startsWith(`${root}/`));
			if (!allowed) return Promise.reject(new Error("Skill URI is outside the locked resource set"));
		}
		return this.#bridge.requestExecution(
			this.#definition,
			toolCallId,
			params as Record<string, unknown>,
			signal,
			onUpdate,
		);
	}
}

export class RpcHostToolBridge {
	#output: RpcHostToolOutput;
	#definitions = new Map<string, RpcHostToolDefinition>();
	#pendingCalls = new Map<string, PendingHostToolCall>();
	#closedError: Error | undefined;
	#stageGeneration = 0;

	constructor(output: RpcHostToolOutput) {
		this.#output = output;
	}

	getToolNames(): string[] {
		return Array.from(this.#definitions.keys());
	}

	/** Return the currently registered host tool definitions. */
	getDefinitions(): RpcHostToolDefinition[] {
		return [...this.#definitions.values()];
	}

	setTools(tools: RpcHostToolDefinition[]): AgentTool[] {
		const stage = this.stageTools(tools);
		stage.commit();
		return stage.tools;
	}

	/** Build adapters without making them executable until the caller commits. */
	stageTools(tools: RpcHostToolDefinition[]): { tools: AgentTool[]; commit(): void; discard(): void } {
		const definitions = normalizeRpcHostToolDefinitions(tools);
		const generation = ++this.#stageGeneration;
		let settled = false;
		return {
			tools: definitions.map(tool => new RpcHostToolAdapter(tool, this)),
			commit: () => {
				if (settled || generation !== this.#stageGeneration) {
					throw new Error("Host tool manifest stage is no longer current");
				}
				settled = true;
				this.#definitions = new Map(definitions.map(tool => [tool.name, tool]));
			},
			discard: () => {
				if (settled) return;
				settled = true;
				if (generation === this.#stageGeneration) this.#stageGeneration++;
			},
		};
	}

	/** Create child-local adapters from the current parent definitions without mutating the parent set. */
	createTools(allowedToolNames?: readonly string[], constraints: RpcHostToolConstraints = {}): AgentTool[] {
		const allowed = allowedToolNames === undefined ? undefined : new Set(allowedToolNames);
		return [...this.#definitions.values()]
			.filter(definition => definition.name !== "task" && (allowed === undefined || allowed.has(definition.name)))
			.map(definition => new RpcHostToolAdapter(definition, this, constraints));
	}

	handleResult(frame: RpcHostToolResult): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		this.#pendingCalls.delete(frame.id);
		if (frame.isError) {
			const text = frame.result.content
				.filter(
					(item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string",
				)
				.map(item => item.text)
				.join("\n")
				.trim();
			pending.reject(new Error(text || "Host tool execution failed"));
			return true;
		}
		pending.resolve(frame.result);
		return true;
	}

	handleUpdate(frame: RpcHostToolUpdate): boolean {
		const pending = this.#pendingCalls.get(frame.id);
		if (!pending) return false;
		pending.onUpdate?.(frame.partialResult);
		return true;
	}

	requestExecution(
		definition: RpcHostToolDefinition,
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> {
		if (this.#definitions.get(definition.name) !== definition) {
			return Promise.reject(new Error(`Host tool "${definition.name}" is not armed`));
		}
		if (signal?.aborted) {
			return Promise.reject(new Error(`Host tool "${definition.name}" was aborted`));
		}

		if (this.#closedError) {
			return Promise.reject(this.#closedError);
		}
		let argumentsDigest: string;
		try {
			argumentsDigest = Bun.SHA256.hash(canonicalRpcHostToolArguments(args), "hex");
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}

		const id = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<AgentToolResult<unknown>>();
		let settled = false;

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
			this.#pendingCalls.delete(id);
		};

		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			this.#output({
				type: "host_tool_cancel",
				id: Snowflake.next() as string,
				targetId: id,
			});
			reject(new Error(`Host tool "${definition.name}" was aborted`));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingCalls.set(id, {
			resolve: result => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
			onUpdate,
		});

		this.#output({
			type: "host_tool_call",
			id,
			toolCallId,
			toolName: definition.name,
			capabilityKind: definition.capabilityKind,
			dispatchId: definition.dispatchId,
			arguments: args,
			argumentsDigest,
		});

		return promise;
	}

	rejectAllPending(message: string): void {
		const error = new Error(message);
		const pendingCalls = Array.from(this.#pendingCalls.values());
		this.#pendingCalls.clear();
		for (const pending of pendingCalls) {
			pending.reject(error);
		}
	}

	/** Reject active and future host tool requests after the RPC client disconnects. */
	close(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const pendingCalls = Array.from(this.#pendingCalls.values());
		this.#pendingCalls.clear();
		for (const pending of pendingCalls) {
			pending.reject(this.#closedError);
		}
	}
}
