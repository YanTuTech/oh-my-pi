import * as fs from "node:fs/promises";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { loadExtensions } from "../../extensibility/extensions/loader";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../sdk";
import { createAgentSession } from "../../sdk";
import type { AuthStorage } from "../../session/auth-storage";
import { SessionManager } from "../../session/session-manager";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../../system-prompt";
import { EventBus } from "../../utils/event-bus";
import { applyAcpDefaultSettingOverrides } from "../protocol-settings";
import type { AcpSessionFactory } from "./acp-mode";

export interface AcpSessionFactoryOptions {
	baseOptions?: CreateAgentSessionOptions;
	settings: Settings;
	sessionDir?: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	runtimeApiKey?: string;
	trustedExtensionPaths?: string[];
	toolNames?: string[];
	createSession?: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

async function statTrustedExtension(trustedPath: string) {
	try {
		return await fs.stat(trustedPath);
	} catch {
		throw new Error(`Trusted extension must be an existing module file: ${trustedPath}`);
	}
}

async function loadTrustedSessionExtensions(paths: string[], cwd: string, eventBus: EventBus) {
	for (const trustedPath of paths) {
		const stat = await statTrustedExtension(trustedPath);
		if (!stat.isFile()) {
			throw new Error(`Trusted extension must be a module file, not a directory: ${trustedPath}`);
		}
	}
	return loadExtensions(paths, cwd, eventBus);
}

function validateRequestedToolNames(requestedTools: string[], knownTools: string[]): void {
	const known = new Set(knownTools);
	const unknown = requestedTools.filter(name => !known.has(name));
	if (unknown.length === 0) return;
	throw new Error(`Unknown requested tool: ${unknown.join(", ")}. Valid tools: ${knownTools.join(", ")}`);
}

/**
 * Build the per-workspace session factory used by an ACP host.
 *
 * MCP servers are owned by the ACP client and arrive through `session/new`, so
 * host-side on-disk MCP discovery is always disabled for sessions created here.
 */
export function createAcpSessionFactory(options: AcpSessionFactoryOptions): AcpSessionFactory {
	const baseOptions = options.baseOptions ?? {};
	const createSession = options.createSession ?? createAgentSession;

	return async (cwd, factoryOptions) => {
		const settings = await options.settings.cloneForCwd(cwd);
		applyAcpDefaultSettingOverrides(settings);
		const sessionManager = SessionManager.create(cwd, options.sessionDir);
		const agentId = `acp:${sessionManager.getSessionId()}`;
		const titleSystemPromptSource = discoverTitleSystemPromptFile(cwd);
		const titleSystemPrompt = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
		const eventBus = new EventBus();
		const trustedPaths = options.trustedExtensionPaths ?? [];
		const trustedExtensions =
			trustedPaths.length > 0 ? await loadTrustedSessionExtensions(trustedPaths, cwd, eventBus) : undefined;
		if (trustedExtensions && trustedExtensions.errors.length > 0) {
			throw new Error(
				`Trusted extension failed to load: ${trustedExtensions.errors.map(item => item.error).join("; ")}`,
			);
		}

		const { session, setToolUIContext } = await createSession({
			...baseOptions,
			cwd,
			sessionManager,
			settings,
			authStorage: options.authStorage,
			modelRegistry: options.modelRegistry,
			agentId,
			interactivePrompts: factoryOptions?.interactivePrompts,
			deferUsageReserveConfirmation: true,
			enableMCP: false,
			hasUI: false,
			titleSystemPrompt,
			eventBus,
			preloadedExtensions: trustedExtensions,
		});

		if (options.runtimeApiKey && !baseOptions.model && session.model) {
			options.authStorage.setRuntimeApiKey(session.model.provider, options.runtimeApiKey);
		}
		if (options.toolNames) {
			try {
				validateRequestedToolNames(options.toolNames, session.getAllToolNames());
			} catch (error) {
				await session.dispose();
				throw error;
			}
		}
		return { session, setToolUIContext };
	};
}
