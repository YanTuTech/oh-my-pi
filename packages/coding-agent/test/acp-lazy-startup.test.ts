import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAcpConnection, createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/modes/acp";
import {
	applyAcpDefaultSettingOverrides,
	applyRpcDefaultSettingOverrides,
} from "@oh-my-pi/pi-coding-agent/modes/protocol-settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type Client,
	ClientSideConnection,
	type CreateTerminalRequest,
	type CreateTerminalResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@oh-my-pi/pi-utils/acp";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const TEST_MODEL: Model = buildModel({
	id: "claude-sonnet-4-20250514",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

class TestClient implements Client {
	readonly updates: SessionNotification[] = [];

	async requestPermission(_params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		return { outcome: { outcome: "selected", optionId: "allow_once" } };
	}

	async sessionUpdate(params: SessionNotification): Promise<void> {
		this.updates.push(params);
	}

	async createTerminal(_params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
		return { terminalId: "test-terminal" };
	}
}

class LazyFakeSession {
	sessionManager: SessionManager;
	sessionId: string;
	agent: { sessionId: string; waitForIdle: () => Promise<void> };
	model: Model | undefined = TEST_MODEL;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	extensionRunner = undefined;
	isStreaming = false;
	queuedMessageCount = 0;
	systemPrompt = "system";
	disposed = false;
	settings = { get: (_path: string) => false };

	constructor(cwd: string) {
		this.sessionManager = SessionManager.inMemory(cwd);
		this.sessionId = this.sessionManager.getSessionId();
		this.agent = { sessionId: this.sessionId, waitForIdle: async () => {} };
	}

	get sessionName(): string {
		return this.sessionManager.getHeader()?.title ?? `Session ${this.sessionId}`;
	}

	get modelRegistry(): { getApiKey: (model: Model) => Promise<string> } {
		return { getApiKey: async (_model: Model) => "test-key" };
	}

	getAvailableModels(): Model[] {
		return [TEST_MODEL];
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return ["low", "medium", "high"];
	}

	setThinkingLevel(): void {}
	setSlashCommands(): void {}
	async setModel(): Promise<void> {}
	subscribe(): () => void {
		return () => {};
	}
	async prompt(): Promise<void> {}
	async waitForIdle(): Promise<void> {}
	async abort(): Promise<void> {}
	async promptCustomMessage(): Promise<void> {}
	async refreshMCPTools(): Promise<void> {}
	getContextUsage(): undefined {
		return undefined;
	}
	async switchSession(): Promise<boolean> {
		return false;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.sessionManager.close();
	}
	async reload(): Promise<void> {}
	async newSession(): Promise<boolean> {
		return false;
	}
	async branch(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	async navigateTree(): Promise<{ cancelled: boolean }> {
		return { cancelled: false };
	}
	getActiveToolNames(): string[] {
		return [];
	}
	getAllToolNames(): string[] {
		return [];
	}
	setActiveToolsByName(): void {}
	setClientBridge(): void {}
	getPlanModeState(): undefined {
		return undefined;
	}
	setPlanModeState(): void {}
	async sendCustomMessage(): Promise<void> {}
	async sendUserMessage(): Promise<void> {}
	async compact(): Promise<void> {}
	async fork(): Promise<boolean> {
		return false;
	}
}

/**
 * Close one direction of the in-memory transport used by these tests. The ACP
 * SDK's `ndJsonStream` acquires a transient writer per message, so immediately
 * after the final response resolves on the peer the writer-release is still a
 * queued microtask. Closing while that writer is held rejects with "WritableStream
 * .close ... locked", which leaves the peer's readable open and hangs
 * `connection.closed`. Wait for the lock to clear (bounded) before closing.
 */
async function closeTransport(writable: WritableStream<unknown>): Promise<void> {
	for (let i = 0; i < 100 && writable.locked; i++) {
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	await Promise.allSettled([writable.close()]);
}

describe("ACP lazy startup", () => {
	it("applies schema defaults for ACP background jobs", async () => {
		const settings = Settings.isolated();
		applyAcpDefaultSettingOverrides(settings);
		expect({
			asyncEnabled: settings.get("async.enabled"),
			asyncMaxJobs: settings.get("async.maxJobs"),
			bashAutoBackground: settings.get("bash.autoBackground.enabled"),
			bashAutoBackgroundThresholdMs: settings.get("bash.autoBackground.thresholdMs"),
		}).toEqual({
			asyncEnabled: true,
			asyncMaxJobs: 100,
			bashAutoBackground: true,
			bashAutoBackgroundThresholdMs: 60000,
		});
	});

	it("honors explicit host-defaulted and todo settings for protocol hosts", async () => {
		// Regression for #3207: protocol-host defaults previously clobbered explicit
		// configured value (caller, project, --config overlay, or global) with the
		// schema default. The fix (re-)added an `isConfigured` guard so explicit
		// configuration survives, and the schema default only fills holes.
		const explicit = {
			"task.isolation.mode": "rcopy",
			"task.isolation.apply": false,
			"task.isolation.merge": "branch",
			"task.isolation.commits": "ai",
			"task.eager": "always",
			"task.batch": false,
			"task.maxConcurrency": 4,
			"task.maxRecursionDepth": 5,
			"task.disabledAgents": ["scout"],
			"task.agentModelOverrides": { task: "claude-sonnet-4-20250514" },
			"task.agentAdvisor": { task: "on" },
			"memory.backend": "local",
			"memories.enabled": true,
			"advisor.enabled": true,
			"advisor.syncBacklog": "5",
			"advisor.immuneTurns": 7,
			"todo.enabled": false,
			"todo.reminders": false,
			"todo.eager": "always",
		} as const;
		const rpcOnlyExplicit = {
			"async.enabled": false,
			"async.maxJobs": 7,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 5_000,
		} as const;
		const allPaths = [
			...(Object.keys(explicit) as (keyof typeof explicit)[]),
			...(Object.keys(rpcOnlyExplicit) as (keyof typeof rpcOnlyExplicit)[]),
		];
		for (const applyDefaults of [applyRpcDefaultSettingOverrides, applyAcpDefaultSettingOverrides]) {
			const settings = Settings.isolated({ ...explicit, ...rpcOnlyExplicit });
			applyDefaults(settings);
			const observed = Object.fromEntries(allPaths.map(key => [key, settings.get(key)]));
			expect(observed).toEqual({ ...explicit, ...rpcOnlyExplicit });
		}
	});

	it("answers initialize before creating the first AgentSession", async () => {
		const clientToAgent = new TransformStream();
		const agentToClient = new TransformStream();
		const client = new TestClient();
		let createCalls = 0;
		const creationStarted = Promise.withResolvers<void>();
		const blockedCreation = Promise.withResolvers<{
			session: AgentSession;
			setToolUIContext: () => void;
		}>();

		const agentConnection = new ClientSideConnection(
			() => client,
			ndJsonStream(clientToAgent.writable, agentToClient.readable),
		);
		const serverConnection = createAcpConnection(
			ndJsonStream(agentToClient.writable, clientToAgent.readable),
			async cwd => {
				creationStarted.resolve();
				createCalls++;
				if (createCalls === 1) {
					return await blockedCreation.promise;
				}
				return {
					session: new LazyFakeSession(cwd) as unknown as AgentSession,
					setToolUIContext: () => {},
				};
			},
		);

		try {
			const initializeResponse = await agentConnection.initialize({ protocolVersion: 1, clientCapabilities: {} });
			expect(initializeResponse).toEqual(
				expect.objectContaining({
					protocolVersion: 1,
					agentInfo: expect.objectContaining({ name: "oh-my-pi" }),
				}),
			);
			expect(createCalls).toBe(0);

			const newSessionPromise = agentConnection.newSession({ cwd: "/tmp/acp-lazy-startup", mcpServers: [] });
			await creationStarted.promise;
			expect(createCalls).toBe(1);

			blockedCreation.resolve({
				session: new LazyFakeSession("/tmp/acp-lazy-startup") as unknown as AgentSession,
				setToolUIContext: () => {},
			});
			const sessionResponse = await newSessionPromise;
			expect(sessionResponse.sessionId).toEqual(expect.any(String));
		} finally {
			await closeTransport(clientToAgent.writable);
			await closeTransport(agentToClient.writable);
			await Promise.allSettled([agentConnection.closed, serverConnection.closed]);
		}
	});

	it("applies runtime API keys after ACP lazy session creation resolves extension models", async () => {
		using tempDir = TempDir.createSync("@omp-acp-lazy-api-key-");
		const cwd = tempDir.path();

		await Bun.write(
			path.join(cwd, "runtime-provider.ts"),
			`export default function(pi) {
	pi.registerProvider("runtime-provider", {
		baseUrl: "https://runtime.example.com/v1",
		apiKey: "extension-key",
		api: "openai-completions",
		models: [{
			id: "runtime-model",
			name: "Runtime Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		}],
	});
}
`,
		);

		const authStorage = createInMemoryAuthStorage();
		try {
			const settings = Settings.isolated();
			const modelRegistry = new ModelRegistry(authStorage);
			let sessionHasUI: boolean | undefined;
			let deferredUsageReserveConfirmation: boolean | undefined;
			const extensionPath = path.join(cwd, "runtime-provider.ts");
			const factory = createAcpSessionFactory({
				baseOptions: {
					additionalExtensionPaths: [extensionPath],
					disableExtensionDiscovery: true,
					modelPattern: "runtime-provider/runtime-model",
					workspaceTree: emptyWorkspaceTree(cwd),
				},
				settings,
				sessionDir: cwd,
				authStorage,
				modelRegistry,
				runtimeApiKey: "runtime-key",
				trustedExtensionPaths: [extensionPath],
				createSession: sessionOptions => {
					sessionHasUI = sessionOptions.hasUI;
					deferredUsageReserveConfirmation = sessionOptions.deferUsageReserveConfirmation;
					return createAgentSession(sessionOptions);
				},
			});
			const created = await factory(cwd);
			const session = "session" in created ? created.session : created;

			if (!session?.model) {
				throw new Error("Expected extension model to resolve");
			}
			expect(session.model.provider).toBe("runtime-provider");
			expect(await session.modelRegistry.getApiKey(session.model)).toBe("runtime-key");
			expect(sessionHasUI).toBe(false);
			expect(deferredUsageReserveConfirmation).toBe(true);
			await session.dispose();
		} finally {
			authStorage.close();
		}
	}, 15_000);
});
